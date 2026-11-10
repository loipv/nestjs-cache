import type { LoadOptions } from '../core/cache-engine.js';
import { assertPositiveFinite, assertStrategyTtls } from './metadata.js';
import { assertInstanceMethod, compileKeyAt, putOptionsOf, wrapMethod } from './method-wrapper.js';
import type { AsyncMethodDecorator, CacheableOptions, KeySpec } from './options.js';

export function Cacheable<
  K extends unknown[] = never[],
  C extends unknown[] = never[],
  R = unknown,
>(options?: CacheableOptions<K, C, R>): AsyncMethodDecorator<K, C, R> {
  return (target, propertyKey, descriptor) => {
    assertInstanceMethod(target, propertyKey);
    assertPositiveFinite(target, propertyKey, 'ttl', options?.ttl);
    assertPositiveFinite(target, propertyKey, 'nullTtl', options?.nullTtl);
    assertStrategyTtls(target, propertyKey, options);
    const keyOf = compileKeyAt(target, propertyKey, options?.key as KeySpec<never[]> | undefined);
    const condition = options?.condition as ((...args: unknown[]) => boolean) | undefined;
    const store = options?.store ?? 'default';
    const namespace = options?.namespace;
    const loadOptions: LoadOptions<unknown> = putOptionsOf(options);
    if (options?.lock !== undefined) loadOptions.lock = options.lock;
    wrapMethod(
      target,
      propertyKey,
      descriptor,
      { kind: 'cacheable', method: propertyKey, store, lock: options?.lock },
      (engine, call) => {
        let key: string;
        try {
          if (condition !== undefined && !condition(...call.args)) return call.invoke();
          key = keyOf(call);
        } catch (error) {
          engine.reportError(store, 'key', error);
          return call.invoke();
        }
        return engine.getOrSet({ store, namespace, key }, call.invoke, loadOptions);
      },
    );
  };
}
