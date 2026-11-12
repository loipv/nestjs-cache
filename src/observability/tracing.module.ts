import type { DynamicModule, Provider } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { CACHE_TRACING_OPTIONS, CACHE_TRACING_REGISTRATION } from '../module/tokens.js';
import { CacheTracing, resolveTracingOptions } from './cache-tracing.js';
import type { CacheTracingAsyncOptions, CacheTracingOptions } from './tracing.types.js';

/**
 * Registers the options with the `CacheModule`'s `CacheTracing` when the module is instantiated.
 * Invalid options, or a second registration, throw `CacheConfigError` and fail the app init.
 */
function registrationProvider(): Provider {
  return {
    provide: CACHE_TRACING_REGISTRATION,
    useFactory: (tracing: CacheTracing, options: CacheTracingOptions) => {
      tracing.use(options);
      return true;
    },
    inject: [CacheTracing, CACHE_TRACING_OPTIONS],
  };
}

/**
 * Traces cache calls through an OpenTelemetry tracer you pass in, for example
 * `trace.getTracer('my-app')`; without this module nothing is traced. Needs a global
 * `CacheModule`. Register it once: a second registration fails the app init with
 * `CacheConfigError`.
 */
@Module({})
export class CacheTracingModule {
  /** Registers the tracer given up front. Invalid options throw `CacheConfigError`. */
  static forRoot(options: CacheTracingOptions): DynamicModule {
    const resolved = resolveTracingOptions(options);
    return {
      module: CacheTracingModule,
      providers: [{ provide: CACHE_TRACING_OPTIONS, useValue: resolved }, registrationProvider()],
    };
  }

  /**
   * Registers the tracer `useFactory` returns; it can inject providers. Invalid options fail
   * the app init with `CacheConfigError`.
   */
  static forRootAsync(options: CacheTracingAsyncOptions): DynamicModule {
    return {
      module: CacheTracingModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: CACHE_TRACING_OPTIONS,
          useFactory: async (...args: never[]) => options.useFactory(...args),
          inject: options.inject ?? [],
        },
        registrationProvider(),
      ],
    };
  }
}
