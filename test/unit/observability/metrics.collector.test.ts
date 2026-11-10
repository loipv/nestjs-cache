import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import * as ioClient from '@prometheus-io/client';
import * as promClient from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheEvents } from '../../../src/core/events.js';
import { CacheConfigError } from '../../../src/errors.js';
import { CacheModule } from '../../../src/module/cache.module.js';
import { construct } from '../../../src/observability/prometheus.types.js';
import { resolvePrometheusOptions } from '../../../src/observability/metrics.collector.js';
import { CachePrometheusModule } from '../../../src/observability/prometheus.module.js';
import type {
  PrometheusClientLike,
  RegistryLike,
} from '../../../src/observability/prometheus.types.js';

interface RealRegistry extends RegistryLike {
  getSingleMetricAsString(name: string): Promise<string>;
  clear(): void;
}

const clients: [string, PrometheusClientLike & { Registry: new () => RealRegistry }][] = [
  ['prom-client', promClient],
  ['@prometheus-io/client', ioClient],
];

describe.each(clients)('CacheMetricsCollector with %s', (_name, client) => {
  const refs: TestingModule[] = [];

  async function boot(
    registry: RegistryLike,
    extra: { prefix?: string; buckets?: number[] } = {},
  ): Promise<TestingModule> {
    const ref = await Test.createTestingModule({
      imports: [
        CacheModule.forRoot({ isGlobal: true }),
        CachePrometheusModule.forRoot({ client, registry, ...extra }),
      ],
    }).compile();
    refs.push(ref);
    await ref.init();
    return ref;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const ref of refs.splice(0)) await ref.close();
  });

  it('counts hit, stale and miss with store/namespace/result labels', async () => {
    const registry = new client.Registry();
    const events = (await boot(registry)).get(CacheEvents);
    events.emit('hit', { store: 'default', namespace: 'users', key: 'a', stale: false });
    events.emit('hit', { store: 'default', namespace: 'users', key: 'a', stale: true });
    events.emit('miss', { store: 'default', namespace: undefined, key: 'b' });
    const text = await registry.getSingleMetricAsString('cache_requests_total');
    expect(text).toContain(
      'cache_requests_total{store="default",namespace="users",result="hit"} 1',
    );
    expect(text).toContain(
      'cache_requests_total{store="default",namespace="users",result="stale"} 1',
    );
    expect(text).toContain('cache_requests_total{store="default",namespace="",result="miss"} 1');
  });

  it('records errors, load and lock durations in seconds and breaker state', async () => {
    const registry = new client.Registry();
    const events = (await boot(registry)).get(CacheEvents);
    events.emit('error', { store: 'default', operation: 'get', error: new Error('x') });
    events.emit('load', {
      store: 'default',
      namespace: 'u',
      key: 'k',
      durationMs: 250,
      success: false,
    });
    events.emit('lock', {
      store: 'default',
      namespace: undefined,
      key: 'k',
      waitedMs: 50,
      acquired: true,
    });
    events.emit('breaker', { store: 'default', state: 'open' });
    expect(await registry.getSingleMetricAsString('cache_errors_total')).toContain(
      'cache_errors_total{store="default",operation="get"} 1',
    );
    expect(await registry.getSingleMetricAsString('cache_load_duration_seconds')).toContain(
      'cache_load_duration_seconds_sum{store="default",namespace="u",success="false"} 0.25',
    );
    const lockText = await registry.getSingleMetricAsString('cache_lock_wait_seconds');
    expect(lockText).toContain('cache_lock_wait_seconds_sum{store="default",acquired="true"} 0.05');
    expect(lockText).not.toContain('namespace=');
    const gauge = (): Promise<string> =>
      registry.getSingleMetricAsString('cache_circuit_breaker_state');
    expect(await gauge()).toContain('cache_circuit_breaker_state{store="default"} 2');
    events.emit('breaker', { store: 'default', state: 'half-open' });
    expect(await gauge()).toContain('cache_circuit_breaker_state{store="default"} 1');
    events.emit('breaker', { store: 'default', state: 'closed' });
    expect(await gauge()).toContain('cache_circuit_breaker_state{store="default"} 0');
  });

  it('honours prefix and buckets', async () => {
    const registry = new client.Registry();
    const events = (await boot(registry, { prefix: 'app_', buckets: [0.1, 1] })).get(CacheEvents);
    events.emit('miss', { store: 's', namespace: undefined, key: 'k' });
    events.emit('load', {
      store: 's',
      namespace: undefined,
      key: 'k',
      durationMs: 5,
      success: true,
    });
    expect(await registry.getSingleMetricAsString('app_requests_total')).toContain(
      'app_requests_total{',
    );
    expect(registry.getSingleMetric('cache_requests_total')).toBeUndefined();
    const text = await registry.getSingleMetricAsString('app_load_duration_seconds');
    expect(text).toContain('le="0.1"');
    expect(text).not.toContain('le="0.005"');
  });

  it('throws on a duplicate metric, then starts after the first app closes', async () => {
    const registry = new client.Registry();
    const first = await boot(registry);
    const second = await Test.createTestingModule({
      imports: [
        CacheModule.forRoot({ isGlobal: true }),
        CachePrometheusModule.forRoot({ client, registry }),
      ],
    }).compile();
    const rejection = second.init();
    await expect(rejection).rejects.toBeInstanceOf(CacheConfigError);
    await expect(rejection).rejects.toThrow(
      'Metric "cache_requests_total" is already registered; use a different prefix or registry',
    );
    await second.close();
    // the failed app must not have removed the first app's metrics
    expect(registry.getSingleMetric('cache_requests_total')).toBeDefined();
    await first.close();
    refs.splice(refs.indexOf(first), 1);
    expect(registry.getSingleMetric('cache_requests_total')).toBeUndefined();
    await boot(registry);
    expect(registry.getSingleMetric('cache_requests_total')).toBeDefined();
  });

  it('does not remove a same-named metric that another source registered after a clear', async () => {
    const registry = new client.Registry();
    const ref = await boot(registry);
    registry.clear();
    const foreign = construct(client.Counter, {
      name: 'cache_requests_total',
      help: 'foreign',
      labelNames: [],
      registers: [registry],
    });
    await ref.close();
    refs.splice(refs.indexOf(ref), 1);
    expect(registry.getSingleMetric('cache_requests_total')).toBe(foreign);
  });

  it('removes every metric and stops listening after close', async () => {
    const registry = new client.Registry();
    const ref = await boot(registry);
    const events = ref.get(CacheEvents);
    await ref.close();
    refs.splice(0);
    for (const n of [
      'requests_total',
      'errors_total',
      'load_duration_seconds',
      'lock_wait_seconds',
      'circuit_breaker_state',
    ])
      expect(registry.getSingleMetric(`cache_${n}`)).toBeUndefined();
    expect(() => {
      events.emit('miss', { store: 's', namespace: undefined, key: 'k' });
    }).not.toThrow();
  });
});

describe('resolvePrometheusOptions messages', () => {
  it.each([
    [[1, Number.NaN], '[1,NaN]'],
    [[Number.POSITIVE_INFINITY, 1], '[Infinity,1]'],
    [[1, Number.NEGATIVE_INFINITY], '[1,-Infinity]'],
  ])('shows non-finite buckets %j as %s', (buckets, shown) => {
    expect(() => resolvePrometheusOptions({ client: promClient, buckets })).toThrow(
      new CacheConfigError(`Invalid cachePrometheus option buckets: ${shown}`),
    );
  });
});

describe('CacheMetricsCollector with a failing client', () => {
  it('a failing metric update is logged as metrics and never reaches the emitter', async () => {
    const registry: RegistryLike = {
      getSingleMetric: () => undefined,
      removeSingleMetric: () => undefined,
      registerMetric: () => undefined,
    };
    class Boom {
      inc(): void {
        throw new Error('inc exploded');
      }
      observe(): void {}
      set(): void {}
    }
    const client: PrometheusClientLike = {
      Counter: Boom,
      Histogram: Boom,
      Gauge: Boom,
      register: registry,
    };
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const ref = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ isGlobal: true }), CachePrometheusModule.forRoot({ client })],
    }).compile();
    await ref.init();
    const events = ref.get(CacheEvents);
    const errors = vi.fn();
    events.on('error', errors);
    expect(() => {
      events.emit('miss', { store: 'default', namespace: undefined, key: 'k' });
    }).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Cache metrics failed on store "default"'),
    );
    expect(errors).not.toHaveBeenCalled();
    await ref.close();
  });
});
