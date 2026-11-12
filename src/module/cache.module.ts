import { DiscoveryService, DiscoveryModule } from '@nestjs/core';
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { CacheEngine } from '../core/cache-engine.js';
import { CacheService } from '../core/cache.service.js';
import { CacheEvents } from '../core/events.js';
import { CacheHealthIndicator } from '../health/cache-health.indicator.js';
import { CacheTracing } from '../observability/cache-tracing.js';
import { CacheExplorer } from './cache.explorer.js';
import { CacheLifecycle } from './cache.lifecycle.js';
import { CacheLogger } from './cache.logger.js';
import {
  resolveOptions,
  type CacheModuleAsyncOptions,
  type CacheModuleOptions,
  type ResolvedCacheOptions,
} from './cache.options.js';
import { CACHE_ENGINE, CACHE_LOGGER, CACHE_OPTIONS } from './tokens.js';

function sharedProviders(): Provider[] {
  return [
    {
      provide: CACHE_LOGGER,
      useFactory: (options: ResolvedCacheOptions) => new CacheLogger(options.logging.level),
      inject: [CACHE_OPTIONS],
    },
    {
      provide: CacheEvents,
      useFactory: (logger: CacheLogger) =>
        new CacheEvents((error) => {
          logger.error(
            `A cache event listener threw: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      inject: [CACHE_LOGGER],
    },
    {
      provide: CacheTracing,
      useFactory: (logger: CacheLogger) => new CacheTracing(logger),
      inject: [CACHE_LOGGER],
    },
    {
      provide: CACHE_ENGINE,
      useFactory: (options: ResolvedCacheOptions, events: CacheEvents, tracing: CacheTracing) =>
        new CacheEngine(options, events, tracing),
      inject: [CACHE_OPTIONS, CacheEvents, CacheTracing],
    },
    {
      provide: CacheService,
      useFactory: (engine: CacheEngine) => new CacheService(engine),
      inject: [CACHE_ENGINE],
    },
    {
      provide: CacheHealthIndicator,
      useFactory: (options: ResolvedCacheOptions) => new CacheHealthIndicator(options),
      inject: [CACHE_OPTIONS],
    },
    {
      provide: CacheLifecycle,
      useFactory: (options: ResolvedCacheOptions, events: CacheEvents, logger: CacheLogger) =>
        new CacheLifecycle(options, events, logger),
      inject: [CACHE_OPTIONS, CacheEvents, CACHE_LOGGER],
    },
    {
      provide: CacheExplorer,
      useFactory: (discovery: DiscoveryService, engine: CacheEngine) =>
        new CacheExplorer(discovery, engine),
      inject: [DiscoveryService, CACHE_ENGINE],
    },
  ];
}

const EXPORTS = [
  CacheService,
  CacheEvents,
  CACHE_ENGINE,
  CacheHealthIndicator,
  CACHE_LOGGER,
  CacheTracing,
];

/**
 * The cache module: provides `CacheService`, `CacheEvents` and `CacheHealthIndicator`, and
 * wires the cache decorators of every provider. Register it once, usually with `isGlobal`.
 */
@Module({})
export class CacheModule {
  /** Registers the module with options known up front. Invalid options throw `CacheConfigError`. */
  static forRoot(options: CacheModuleOptions & { isGlobal?: boolean } = {}): DynamicModule {
    const { isGlobal, ...moduleOptions } = options;
    const resolved = resolveOptions(moduleOptions);
    return {
      module: CacheModule,
      global: isGlobal ?? false,
      imports: [DiscoveryModule],
      providers: [{ provide: CACHE_OPTIONS, useValue: resolved }, ...sharedProviders()],
      exports: EXPORTS,
    };
  }

  /** Registers the module with options built by `useFactory`, which can inject providers. */
  static forRootAsync(options: CacheModuleAsyncOptions): DynamicModule {
    return {
      module: CacheModule,
      global: options.isGlobal ?? false,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers: [
        {
          provide: CACHE_OPTIONS,
          useFactory: async (...args: never[]) => resolveOptions(await options.useFactory(...args)),
          inject: options.inject ?? [],
        },
        ...sharedProviders(),
      ],
      exports: EXPORTS,
    };
  }
}
