import type { CacheEngine } from '../core/cache-engine.js';
import { normalizeTags } from '../core/engine-tags.js';
import { CacheConfigError } from '../errors.js';
import { assertNamespace, describeMethod } from './metadata.js';
import {
  assertInstanceMethod,
  compileEvictTags,
  compileKeyAt,
  wrapMethod,
  type MethodCall,
} from './method-wrapper.js';
import type { AsyncMethodDecorator, CacheEvictOptions, KeySpec } from './options.js';

/**
 * The tags one eviction invalidates (spec 2.5): empty tags are dropped; an invalid list (a
 * callback that throws, not an array, a non-string tag, more than 32 tags) is one `tag` error
 * and invalidates nothing. `undefined` when nothing is left to invalidate.
 */
function tagsToEvict(
  engine: CacheEngine,
  store: string,
  build: (call: MethodCall) => unknown,
  call: MethodCall,
): string[] | undefined {
  try {
    const raw = build(call);
    const names = normalizeTags(
      Array.isArray(raw) ? (raw as unknown[]).filter((tag) => tag !== '') : raw,
    );
    return names.length === 0 ? undefined : names;
  } catch (error) {
    engine.reportError(store, 'tag', error);
    return undefined;
  }
}

/** Gives the tags new versions; a failed token write is already a `version` error (spec 3.4). */
async function invalidate(engine: CacheEngine, store: string, tags: string[]): Promise<void> {
  try {
    await engine.invalidateTags(tags, store);
  } catch {
    // @CacheEvict never rejects for the cache: the failure surfaces as the event only.
  }
}

export function CacheEvict<K extends unknown[] = never[], G extends unknown[] = never[]>(
  options?: CacheEvictOptions<K, G>,
): AsyncMethodDecorator<K, never[], unknown, G> {
  return (target, propertyKey, descriptor) => {
    assertInstanceMethod(target, propertyKey);
    const loose = (options ?? {}) as {
      namespace?: string;
      store?: string;
      key?: KeySpec<never[]> | readonly KeySpec<never[]>[];
      allEntries?: boolean;
      beforeInvocation?: boolean;
      tags?: unknown;
    };
    const { namespace, allEntries = false, beforeInvocation = false } = loose;
    assertNamespace(target, propertyKey, namespace);
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
    if (Array.isArray(loose.key) && loose.key.length === 0) {
      throw new CacheConfigError(
        `${describeMethod(target, propertyKey)}: key must not be an empty array`,
      );
    }
    const tagsOf = compileEvictTags(target, propertyKey, loose.tags);
    // Without a key, tags alone evict no key; with neither, the default key is evicted, as in 0.6.
    const keySpecs: readonly (KeySpec<never[]> | undefined)[] = Array.isArray(loose.key)
      ? (loose.key as readonly KeySpec<never[]>[])
      : loose.key === undefined && tagsOf !== undefined
        ? []
        : [loose.key as KeySpec<never[]> | undefined];
    // A key that renders empty is allowed here: engine.delete drops and reports it, and still
    // deletes the other keys. A builder that throws skips the whole key eviction.
    const keyBuilders = allEntries
      ? []
      : keySpecs.map((spec) => compileKeyAt(target, propertyKey, spec, true));

    wrapMethod(
      target,
      propertyKey,
      descriptor,
      { kind: 'evict', method: propertyKey, store, lock: undefined },
      async (engine, call) => {
        // Keys and tags are built before the method runs, from the arguments as passed.
        let evictKeys: (() => Promise<void>) | undefined;
        try {
          if (allEntries) {
            evictKeys = () => engine.clear(namespace as string, store);
          } else if (keyBuilders.length > 0) {
            const keys = keyBuilders.map((build) => build(call));
            evictKeys = () => engine.delete({ store, namespace }, keys);
          }
        } catch (error) {
          engine.reportError(store, 'key', error);
        }
        const tags = tagsOf === undefined ? undefined : tagsToEvict(engine, store, tagsOf, call);
        if (evictKeys === undefined && tags === undefined) return call.invoke();
        // The key or namespace first, then the tags (spec 2.2).
        const evict = async (): Promise<void> => {
          if (evictKeys !== undefined) await evictKeys();
          if (tags !== undefined) await invalidate(engine, store, tags);
        };
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
