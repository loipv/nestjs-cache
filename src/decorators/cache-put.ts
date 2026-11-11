import {
  assertBoolean,
  assertFunction,
  assertNamespace,
  assertPositiveFinite,
  assertStrategyTtls,
} from './metadata.js';
import {
  assertInstanceMethod,
  compileKeyAt,
  compileTags,
  presetStrategy,
  putOptionsOf,
  wrapMethod,
} from './method-wrapper.js';
import type { AsyncMethodDecorator, CachePutOptions, KeySpec } from './options.js';

/**
 * Always runs the async method and writes its result to the cache (unless `condition` is false
 * or `unless` is true). Invalid options throw `CacheConfigError` at class definition.
 */
export function CachePut<
  K extends unknown[] = never[],
  C extends unknown[] = never[],
  R = unknown,
  G extends unknown[] = never[],
>(options?: CachePutOptions<K, C, R, G>): AsyncMethodDecorator<K, C, R, G> {
  return (target, propertyKey, descriptor) => {
    assertInstanceMethod(target, propertyKey);
    assertNamespace(target, propertyKey, options?.namespace);
    assertPositiveFinite(target, propertyKey, 'ttl', options?.ttl);
    assertPositiveFinite(target, propertyKey, 'nullTtl', options?.nullTtl);
    assertBoolean(target, propertyKey, 'cacheNull', options?.cacheNull);
    assertFunction(target, propertyKey, 'condition', options?.condition);
    assertFunction(target, propertyKey, 'unless', options?.unless);
    assertStrategyTtls(target, propertyKey, options, '@CachePut');
    const keyOf = compileKeyAt(target, propertyKey, options?.key as KeySpec<never[]> | undefined);
    const tagsOf = compileTags(target, propertyKey, options?.tags);
    const condition = options?.condition as ((...args: unknown[]) => boolean) | undefined;
    const store = options?.store ?? 'default';
    const namespace = options?.namespace;
    const putOptions = putOptionsOf(options);
    const strategy = presetStrategy(putOptions);
    wrapMethod(
      target,
      propertyKey,
      descriptor,
      { kind: 'put', method: propertyKey, store, lock: undefined },
      async (engine, call) => {
        // Condition and key are evaluated before the method runs, so a method
        // that mutates its arguments still writes under the key the caller asked for.
        let key: string | undefined;
        try {
          if (condition === undefined || condition(...call.args)) key = keyOf(call);
        } catch (error) {
          engine.reportError(store, 'key', error);
        }
        const tags = key === undefined ? undefined : tagsOf?.(call);
        // Tags known before the method (templates) have their tokens taken now, and the write
        // uses exactly those: an invalidation while the method runs is not lost (spec 3.3).
        const taken =
          tags === undefined || typeof tags === 'function'
            ? undefined
            : await engine.takeTags(store, tags);
        const result = await call.invoke();
        if (key !== undefined) {
          const options = tags === undefined ? putOptions : { ...putOptions, tags };
          await engine.put({ store, namespace, key }, result, options, strategy, taken);
        }
        return result;
      },
    );
  };
}
