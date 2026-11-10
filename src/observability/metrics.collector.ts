import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { BreakerState, CacheEvents } from '../core/events.js';
import { CacheConfigError } from '../errors.js';
import type { CacheLogger } from '../module/cache.logger.js';
import {
  construct,
  type CachePrometheusOptions,
  type PrometheusClientLike,
  type RegistryLike,
} from './prometheus.types.js';

export interface ResolvedPrometheusOptions {
  client: PrometheusClientLike;
  registry: RegistryLike;
  prefix: string;
  buckets: readonly number[] | undefined;
}

const PREFIX_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return value === undefined ? 'undefined' : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** @internal Validates the module options in the documented order and fills the defaults. */
export function resolvePrometheusOptions(
  options: CachePrometheusOptions,
): ResolvedPrometheusOptions {
  const client = options.client as Partial<PrometheusClientLike> | undefined;
  if (
    typeof client?.Counter !== 'function' ||
    typeof client.Histogram !== 'function' ||
    typeof client.Gauge !== 'function'
  ) {
    throw new CacheConfigError(
      'Invalid cachePrometheus option client: must provide Counter, Histogram and Gauge',
    );
  }
  const prefix: unknown = options.prefix ?? 'cache_';
  if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix)) {
    throw new CacheConfigError(`Invalid cachePrometheus option prefix: ${describeValue(prefix)}`);
  }
  const buckets: unknown = options.buckets;
  if (buckets !== undefined) {
    const valid =
      Array.isArray(buckets) &&
      buckets.length > 0 &&
      buckets.every(
        (b, i, all) =>
          typeof b === 'number' && Number.isFinite(b) && (i === 0 || b > (all[i - 1] as number)),
      );
    if (!valid) {
      throw new CacheConfigError(
        `Invalid cachePrometheus option buckets: ${describeValue(buckets)}`,
      );
    }
  }
  return {
    client: options.client,
    registry: options.registry ?? options.client.register,
    prefix,
    buckets: options.buckets,
  };
}

const BREAKER_VALUE: Record<BreakerState, number> = { closed: 0, 'half-open': 1, open: 2 };

/**
 * @internal Listens to `CacheEvents` and records the five cache metrics through the user's
 * Prometheus client. Metrics are removed from the registry on shutdown.
 */
export class CacheMetricsCollector implements OnModuleInit, OnModuleDestroy {
  private unsubscribers: (() => void)[] = [];

  private created: string[] = [];

  constructor(
    private readonly events: CacheEvents,
    private readonly options: ResolvedPrometheusOptions,
    private readonly logger: CacheLogger,
  ) {}

  onModuleInit(): void {
    const { client, registry, prefix, buckets } = this.options;
    const name = (suffix: string): string => `${prefix}${suffix}`;
    const names = [
      'requests_total',
      'errors_total',
      'load_duration_seconds',
      'lock_wait_seconds',
      'circuit_breaker_state',
    ].map(name);
    for (const metric of names) {
      if (registry.getSingleMetric(metric) !== undefined) {
        throw new CacheConfigError(
          `Metric "${metric}" is already registered; use a different prefix or registry`,
        );
      }
    }
    const registers = [registry];
    const histogramBuckets = buckets === undefined ? {} : { buckets };
    try {
      const requests = this.create(client.Counter, {
        name: name('requests_total'),
        help: 'Cache reads by result',
        labelNames: ['store', 'namespace', 'result'],
        registers,
      });
      const errors = this.create(client.Counter, {
        name: name('errors_total'),
        help: 'Cache errors by operation',
        labelNames: ['store', 'operation'],
        registers,
      });
      const load = this.create(client.Histogram, {
        name: name('load_duration_seconds'),
        help: 'Loader duration on cache misses and refreshes',
        labelNames: ['store', 'namespace', 'success'],
        registers,
        ...histogramBuckets,
      });
      const lock = this.create(client.Histogram, {
        name: name('lock_wait_seconds'),
        help: 'Time spent acquiring or waiting for the distributed lock',
        labelNames: ['store', 'acquired'],
        registers,
        ...histogramBuckets,
      });
      const breaker = this.create(client.Gauge, {
        name: name('circuit_breaker_state'),
        help: 'Circuit breaker state: 0 closed, 1 half-open, 2 open',
        labelNames: ['store'],
        registers,
      });
      const guard = (store: string, update: () => void): void => {
        try {
          update();
        } catch (error) {
          this.logger.storeError(store, 'metrics', error);
        }
      };
      const ns = (namespace: string | undefined): string => namespace ?? '';
      this.unsubscribers = [
        this.events.on('hit', (p) => {
          guard(p.store, () => {
            requests.inc({
              store: p.store,
              namespace: ns(p.namespace),
              result: p.stale ? 'stale' : 'hit',
            });
          });
        }),
        this.events.on('miss', (p) => {
          guard(p.store, () => {
            requests.inc({ store: p.store, namespace: ns(p.namespace), result: 'miss' });
          });
        }),
        this.events.on('error', (p) => {
          guard(p.store, () => {
            errors.inc({ store: p.store, operation: p.operation });
          });
        }),
        this.events.on('load', (p) => {
          guard(p.store, () => {
            load.observe(
              { store: p.store, namespace: ns(p.namespace), success: String(p.success) },
              p.durationMs / 1000,
            );
          });
        }),
        this.events.on('lock', (p) => {
          guard(p.store, () => {
            lock.observe({ store: p.store, acquired: String(p.acquired) }, p.waitedMs / 1000);
          });
        }),
        this.events.on('breaker', (p) => {
          guard(p.store, () => {
            breaker.set({ store: p.store }, BREAKER_VALUE[p.state]);
          });
        }),
      ];
    } catch (error) {
      this.onModuleDestroy();
      throw error;
    }
  }

  onModuleDestroy(): void {
    for (const off of this.unsubscribers.splice(0)) off();
    for (const metric of this.created.splice(0)) {
      try {
        this.options.registry.removeSingleMetric(metric);
      } catch (error) {
        this.logger.warn(
          `Could not remove metric "${metric}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private create<T>(
    ctor: Parameters<typeof construct<T>>[0],
    config: Parameters<typeof construct<T>>[1],
  ): T {
    const metric = construct(ctor, config);
    this.created.push(config.name);
    return metric;
  }
}
