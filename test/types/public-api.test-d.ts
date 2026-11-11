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
