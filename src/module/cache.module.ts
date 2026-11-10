import { DiscoveryService, DiscoveryModule } from '@nestjs/core';
import { Logger, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { CacheEngine } from '../core/cache-engine.js';
import { CacheService } from '../core/cache.service.js';
import { CacheEvents } from '../core/events.js';
import { CacheHealthIndicator } from '../health/cache-health.indicator.js';
import { CacheExplorer } from './cache.explorer.js';
import { CacheLifecycle } from './cache.lifecycle.js';
import {
  resolveOptions,
  type CacheModuleAsyncOptions,
  type CacheModuleOptions,
  type ResolvedCacheOptions,
} from './cache.options.js';
import { CACHE_ENGINE, CACHE_OPTIONS } from './tokens.js';

function sharedProviders(): Provider[] {
  return [
    {
      provide: CacheEvents,
      useFactory: () => {
        const logger = new Logger('CacheModule');
        return new CacheEvents((error) => {
          logger.error(
            `A cache event listener threw: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      },
    },
    {
      provide: CACHE_ENGINE,
      useFactory: (options: ResolvedCacheOptions, events: CacheEvents) =>
        new CacheEngine(options, events),
      inject: [CACHE_OPTIONS, CacheEvents],
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
      useFactory: (options: ResolvedCacheOptions, events: CacheEvents) =>
        new CacheLifecycle(options, events),
      inject: [CACHE_OPTIONS, CacheEvents],
    },
    {
      provide: CacheExplorer,
      useFactory: (discovery: DiscoveryService, engine: CacheEngine) =>
        new CacheExplorer(discovery, engine),
      inject: [DiscoveryService, CACHE_ENGINE],
    },
  ];
}

const EXPORTS = [CacheService, CacheEvents, CACHE_ENGINE, CacheHealthIndicator];

@Module({})
export class CacheModule {
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
