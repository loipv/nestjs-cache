import { expectTypeOf } from 'vitest';
import * as lib from '../../src/index.js';

type Index = typeof lib;

/* 0.9-T6 A-02..A-05: the DI and metadata tokens are internal, so the package index does not
   export them. CacheService is what applications inject. */
expectTypeOf<Index>().not.toHaveProperty('CACHE_ENGINE');
expectTypeOf<Index>().not.toHaveProperty('CACHE_OPTIONS');
expectTypeOf<Index>().not.toHaveProperty('CACHE_ENGINE_PROPERTY');
expectTypeOf<Index>().not.toHaveProperty('CACHE_METADATA');
// @ts-expect-error CACHE_ENGINE is not exported
expectTypeOf<Index>().toHaveProperty('CACHE_ENGINE');

/* 0.9-T6 L-05: PrometheusMetricConfig is used by an internal helper only; it is not exported. */
// @ts-expect-error PrometheusMetricConfig is not exported
export type MetricConfig = lib.PrometheusMetricConfig;

/* 0.9-T6 B-07: softTimeout exists only on the calls that load (LoadStrategyOptions):
   @Cacheable, @HttpCache, getOrSet and getOrSetMany. StrategyOptions, used by the calls that
   never load (@CachePut, set, setMany, get, getMany), has softTimeout?: never. */
export const load: lib.LoadStrategyOptions = { strategy: 'swr', staleTtl: 1, softTimeout: 5 };
export const plainSwr: lib.StrategyOptions = { strategy: 'swr', staleTtl: 1 };
// @ts-expect-error StrategyOptions has no softTimeout
export const noSoft: lib.StrategyOptions = { strategy: 'swr', staleTtl: 1, softTimeout: 5 };
expectTypeOf<lib.StrategyOptions>().toExtend<lib.LoadStrategyOptions>();
expectTypeOf<lib.GetOrSetOptions<number>>().toExtend<{ softTimeout?: number }>();
expectTypeOf<lib.GetOrSetManyOptions<number>>().toExtend<{ softTimeout?: number }>();
expectTypeOf<lib.WriteOptions<number>>().toExtend<{ softTimeout?: undefined }>();
expectTypeOf<lib.WriteManyOptions<number>>().toExtend<{ softTimeout?: undefined }>();
export const cacheable: lib.CacheableOptions<[], [], number> = {
  strategy: 'swr',
  staleTtl: 1,
  softTimeout: 5,
};
export const http: lib.HttpCacheOptions = { strategy: 'swr', staleTtl: 1, softTimeout: 5 };
export const put: lib.CachePutOptions<[], [], number> = {
  strategy: 'swr',
  staleTtl: 1,
  // @ts-expect-error @CachePut does not support softTimeout
  softTimeout: 5,
};

declare const cache: lib.CacheService;
const SOFT = { strategy: 'swr', staleTtl: 1, softTimeout: 5 } as const;
void cache.getOrSet('k', () => Promise.resolve(1), SOFT);
void cache.getOrSetMany(['k'], () => Promise.resolve(new Map<string, number>()), SOFT);
// @ts-expect-error get does not support softTimeout
void cache.get('k', SOFT);
// @ts-expect-error getMany does not support softTimeout
void cache.getMany(['k'], SOFT);
// @ts-expect-error set does not support softTimeout
void cache.set('k', 1, SOFT);
// @ts-expect-error setMany does not support softTimeout
void cache.setMany([['k', 1]], SOFT);

/* 0.9-T6 J-06: getOrSetMany never locks and rejects lock: true, so the type accepts only
   false (an options object shared with getOrSet may still say lock: false). */
const loadMany = (): Promise<Map<string, number>> => Promise.resolve(new Map<string, number>());
void cache.getOrSetMany(['k'], loadMany, { lock: false });
// @ts-expect-error getOrSetMany does not support lock: true
void cache.getOrSetMany(['k'], loadMany, { lock: true });
expectTypeOf<lib.GetOrSetManyOptions<number>['lock']>().toEqualTypeOf<false | undefined>();

/* 0.9-T6 E-03: CacheOperation lists only what an error event can carry; 'metrics' (used in
   logs only) is not one of them. */
export const op: lib.CacheOperation = 'tag';
// @ts-expect-error 'metrics' is not a CacheOperation
export const metricsOp: lib.CacheOperation = 'metrics';
// @ts-expect-error 'tracing' (logs only) is not a CacheOperation
export const tracingOp: lib.CacheOperation = 'tracing';
expectTypeOf<lib.CacheEventMap['error']['operation']>().toEqualTypeOf<lib.CacheOperation>();

/* 0.9-T6 G-08: the breaker factory is circuitBreakerStore, paired with CircuitBreakerStore. */
expectTypeOf(lib.circuitBreakerStore).returns.toEqualTypeOf<lib.CircuitBreakerStore>();
expectTypeOf<Index>().not.toHaveProperty('circuitBreaker');

/* 0.9-T6 G-04: the bus factory takes RedisInvalidationBusOptions; RedisStoreOptions extends it
   with the same fields, so one options object serves both factories. */
expectTypeOf(lib.redisInvalidationBus)
  .parameter(0)
  .toEqualTypeOf<lib.RedisInvalidationBusOptions>();
expectTypeOf<lib.RedisStoreOptions>().toExtend<lib.RedisInvalidationBusOptions>();
expectTypeOf<lib.RedisInvalidationBusOptions>().toExtend<lib.RedisStoreOptions>();

/* 0.9-T6 L-01: CachePrometheusModule.forRootAsync takes the exported
   CachePrometheusAsyncOptions, as CacheModule.forRootAsync takes CacheModuleAsyncOptions. */
expectTypeOf(lib.CachePrometheusModule.forRootAsync)
  .parameter(0)
  .toEqualTypeOf<lib.CachePrometheusAsyncOptions>();
export const promAsync: lib.CachePrometheusAsyncOptions = {
  inject: [],
  useFactory: () => ({ client: {} as lib.PrometheusClientLike }),
};

/* 0.10: tracing. CacheTracingModule and its option and structural tracer types are public;
   CacheTracing (the internal registry the engine traces through) is not exported. */
expectTypeOf(lib.CacheTracingModule.forRoot).parameter(0).toEqualTypeOf<lib.CacheTracingOptions>();
expectTypeOf(lib.CacheTracingModule.forRootAsync)
  .parameter(0)
  .toEqualTypeOf<lib.CacheTracingAsyncOptions>();
expectTypeOf<lib.CacheTracingOptions['tracer']>().toEqualTypeOf<lib.TracerLike>();
expectTypeOf(null as unknown as lib.TracerLike)
  .toHaveProperty('startSpan')
  .returns.toEqualTypeOf<lib.SpanLike>();
expectTypeOf<ReturnType<lib.SpanLike['spanContext']>>().toEqualTypeOf<lib.SpanContextLike>();
expectTypeOf<NonNullable<lib.SpanOptionsLike['attributes']>>().toEqualTypeOf<
  Record<string, lib.SpanAttributeValue>
>();
export const tracingAsync: lib.CacheTracingAsyncOptions = {
  inject: [],
  useFactory: () => ({ tracer: {} as lib.TracerLike, recordKeys: false }),
};
expectTypeOf<Index>().not.toHaveProperty('CacheTracing');
// @ts-expect-error CacheTracing is internal, not exported
export type Tracing = lib.CacheTracing;

/* 1.0 G-07: the options type is CircuitBreakerStoreOptions; the old name is gone. */
expectTypeOf<lib.CircuitBreakerStoreOptions>().toEqualTypeOf<{
  failureThreshold?: number;
  openDuration?: number;
  timeout?: number;
}>();
// @ts-expect-error the old name is not exported
export type OldBreakerOptions = lib.CircuitBreakerOptions;

/* 1.1: touch and setIfAbsent are optional CacheStore members; a minimal store still satisfies
   it. */
export const minimalStore: lib.CacheStore = {
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};
expectTypeOf<lib.CacheStore['touch']>().toEqualTypeOf<
  ((keys: readonly string[], ttlMs: number) => Promise<void>) | undefined
>();
expectTypeOf<lib.CacheStore['setIfAbsent']>().toEqualTypeOf<
  ((key: string, value: string, ttlMs: number) => Promise<boolean>) | undefined
>();
