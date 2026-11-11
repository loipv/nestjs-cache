import type { DynamicModule, Provider } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { CacheEvents } from '../core/events.js';
import type { CacheLogger } from '../module/cache.logger.js';
import { CACHE_LOGGER, CACHE_PROMETHEUS_OPTIONS } from '../module/tokens.js';
import {
  CacheMetricsCollector,
  resolvePrometheusOptions,
  type ResolvedPrometheusOptions,
} from './metrics.collector.js';
import type { CachePrometheusAsyncOptions, CachePrometheusOptions } from './prometheus.types.js';

function collectorProvider(): Provider {
  return {
    provide: CacheMetricsCollector,
    useFactory: (events: CacheEvents, options: ResolvedPrometheusOptions, logger: CacheLogger) =>
      new CacheMetricsCollector(events, options, logger),
    inject: [CacheEvents, CACHE_PROMETHEUS_OPTIONS, CACHE_LOGGER],
  };
}

/**
 * Records cache metrics through a Prometheus client you pass in (`prom-client` or
 * `@prometheus-io/client`). Needs a global `CacheModule`. Opens no endpoint.
 */
@Module({})
export class CachePrometheusModule {
  static forRoot(options: CachePrometheusOptions): DynamicModule {
    const resolved = resolvePrometheusOptions(options);
    return {
      module: CachePrometheusModule,
      providers: [{ provide: CACHE_PROMETHEUS_OPTIONS, useValue: resolved }, collectorProvider()],
    };
  }

  static forRootAsync(options: CachePrometheusAsyncOptions): DynamicModule {
    return {
      module: CachePrometheusModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: CACHE_PROMETHEUS_OPTIONS,
          useFactory: async (...args: never[]) =>
            resolvePrometheusOptions(await options.useFactory(...args)),
          inject: options.inject ?? [],
        },
        collectorProvider(),
      ],
    };
  }
}
