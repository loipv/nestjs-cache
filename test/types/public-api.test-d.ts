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
