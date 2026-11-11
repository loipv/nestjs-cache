import type { LoadOptions } from '../core/cache-engine.js';
import {
  assertBoolean,
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
import type { AsyncMethodDecorator, CacheableOptions, KeySpec } from './options.js';

export function Cacheable<
  K extends unknown[] = never[],
  C extends unknown[] = never[],
  R = unknown,
  G extends unknown[] = never[],
>(options?: CacheableOptions<K, C, R, G>): AsyncMethodDecorator<K, C, R, G> {
  return (target, propertyKey, descriptor) => {
    assertInstanceMethod(target, propertyKey);
    assertNamespace(target, propertyKey, options?.namespace);
    assertPositiveFinite(target, propertyKey, 'ttl', options?.ttl);
    assertPositiveFinite(target, propertyKey, 'nullTtl', options?.nullTtl);
    assertBoolean(target, propertyKey, 'cacheNull', options?.cacheNull);
    assertStrategyTtls(target, propertyKey, options);
    const keyOf = compileKeyAt(target, propertyKey, options?.key as KeySpec<never[]> | undefined);
    const tagsOf = compileTags(target, propertyKey, options?.tags);
    const condition = options?.condition as ((...args: unknown[]) => boolean) | undefined;
    const store = options?.store ?? 'default';
    const namespace = options?.namespace;
    const loadOptions: LoadOptions<unknown> = putOptionsOf(options);
    if (options?.lock !== undefined) loadOptions.lock = options.lock;
    const strategy = presetStrategy(loadOptions);
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
        // Untagged calls share the options built once; tags are per call (D2).
        const options = tagsOf === undefined ? loadOptions : { ...loadOptions, tags: tagsOf(call) };
        return engine.getOrSet({ store, namespace, key }, call.invoke, options, strategy);
      },
    );
  };
}
