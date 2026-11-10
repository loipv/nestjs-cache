import { assertBoolean, assertPositiveFinite, assertStrategyTtls } from './metadata.js';
import {
  assertInstanceMethod,
  compileKeyAt,
  presetStrategy,
  putOptionsOf,
  wrapMethod,
} from './method-wrapper.js';
import type { AsyncMethodDecorator, CachePutOptions, KeySpec } from './options.js';

export function CachePut<K extends unknown[] = never[], C extends unknown[] = never[], R = unknown>(
  options?: CachePutOptions<K, C, R>,
): AsyncMethodDecorator<K, C, R> {
  return (target, propertyKey, descriptor) => {
    assertInstanceMethod(target, propertyKey);
    assertPositiveFinite(target, propertyKey, 'ttl', options?.ttl);
    assertPositiveFinite(target, propertyKey, 'nullTtl', options?.nullTtl);
    assertBoolean(target, propertyKey, 'cacheNull', options?.cacheNull);
    assertStrategyTtls(target, propertyKey, options);
    const keyOf = compileKeyAt(target, propertyKey, options?.key as KeySpec<never[]> | undefined);
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
        const result = await call.invoke();
        if (key !== undefined)
          await engine.put({ store, namespace, key }, result, putOptions, strategy);
        return result;
      },
    );
  };
}
