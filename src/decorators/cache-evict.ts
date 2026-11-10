import { CacheConfigError } from '../errors.js';
import { describeMethod } from './metadata.js';
import { compileKeyAt, wrapMethod } from './method-wrapper.js';
import type { AsyncMethodDecorator, CacheEvictOptions, KeySpec } from './options.js';

export function CacheEvict<K extends unknown[] = never[]>(
  options?: CacheEvictOptions<K>,
): AsyncMethodDecorator<K, never[], unknown> {
  return (target, propertyKey, descriptor) => {
    const loose = (options ?? {}) as {
      namespace?: string;
      store?: string;
      key?: KeySpec<never[]> | readonly KeySpec<never[]>[];
      allEntries?: boolean;
      beforeInvocation?: boolean;
    };
    const { namespace, allEntries = false, beforeInvocation = false } = loose;
    const store = loose.store ?? 'default';
    if (allEntries) {
      const where = describeMethod(target, propertyKey);
      if (typeof namespace !== 'string' || namespace === '') {
        throw new CacheConfigError(`${where}: allEntries requires a namespace`);
      }
      if (loose.key !== undefined) {
        throw new CacheConfigError(`${where}: allEntries cannot be combined with key`);
      }
    }
    const specs: readonly (KeySpec<never[]> | undefined)[] = Array.isArray(loose.key)
      ? (loose.key as readonly KeySpec<never[]>[])
      : [loose.key as KeySpec<never[]> | undefined];
    const keyBuilders = allEntries
      ? []
      : specs.map((spec) => compileKeyAt(target, propertyKey, spec));

    wrapMethod(
      target,
      propertyKey,
      descriptor,
      { kind: 'evict', method: propertyKey, store },
      async (engine, call) => {
        // Keys are built before the method runs, from the arguments as passed.
        let evict: (() => Promise<void>) | undefined;
        try {
          if (allEntries) {
            evict = () => engine.clear(namespace as string, store);
          } else {
            const keys = keyBuilders.map((build) => build(call));
            evict = () => engine.delete({ store, namespace }, keys);
          }
        } catch (error) {
          engine.reportError(store, 'key', error);
        }
        if (evict === undefined) return call.invoke();
        if (beforeInvocation) {
          await evict();
          return call.invoke();
        }
        const result = await call.invoke();
        await evict();
        return result;
      },
    );
  };
}
