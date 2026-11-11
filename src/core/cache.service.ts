import type { StrategyOptions } from '../decorators/options.js';
import type {
  BatchLoadOptions,
  BatchScope,
  BatchSetOptions,
  CacheEngine,
  LoadOptions,
  SetOptions,
} from './cache-engine.js';
import { strategyOptionsOf } from './strategies/expiry-strategy.js';

export interface KeyOptions {
  namespace?: string;
  store?: string;
}

/**
 * `tags`: fixed tag strings (not templates), or a function of the value. The entry is stamped
 * with each tag's version, so `invalidateTags` turns it into a miss. On `getOrSet` an array's
 * versions are taken before the loader runs; a function runs after it, and only when the entry
 * is written, so an invalidation during that load can be missed until the entry expires. An
 * invalid list (an empty tag, more than 32 tags, a throwing function) is an `error` event with
 * operation `'tag'`: the entry is not written and the call still resolves.
 */
export type WriteOptions<T = unknown> = KeyOptions & {
  ttl?: number;
  tags?: readonly string[] | ((value: T) => readonly string[]);
} & StrategyOptions;

/** The options of the batch writes: a tag function also gets each entry's key. */
export type WriteManyOptions<T = unknown> = KeyOptions & {
  ttl?: number;
  tags?: readonly string[] | ((value: T, key: string) => readonly string[]);
} & StrategyOptions;

interface LoadPolicy<T> {
  cacheNull?: boolean;
  nullTtl?: number;
  unless?: (result: T) => boolean;
  lock?: boolean;
}

export type GetOrSetOptions<T> = WriteOptions<T> & LoadPolicy<T>;

/** `getOrSetMany` options; `lock: true` is not supported. */
export type GetOrSetManyOptions<T> = WriteManyOptions<T> & LoadPolicy<T>;

function refOf(
  key: string,
  options: KeyOptions,
): { store?: string; namespace?: string; key: string } {
  const ref: { store?: string; namespace?: string; key: string } = { key };
  if (options.store !== undefined) ref.store = options.store;
  if (options.namespace !== undefined) ref.namespace = options.namespace;
  return ref;
}

function scopeOf(options: KeyOptions): BatchScope {
  const scope: BatchScope = {};
  if (options.store !== undefined) scope.store = options.store;
  if (options.namespace !== undefined) scope.namespace = options.namespace;
  return scope;
}

/** Only the defined options are forwarded. */
function writeOptionsOf<T>(options: WriteOptions<T>): SetOptions<T> {
  const write: SetOptions<T> = strategyOptionsOf(options);
  if (options.ttl !== undefined) write.ttl = options.ttl;
  if (options.tags !== undefined) write.tags = options.tags;
  return write;
}

function writeManyOptionsOf<T>(options: WriteManyOptions<T>): BatchSetOptions<T> {
  const write: BatchSetOptions<T> = strategyOptionsOf(options);
  if (options.ttl !== undefined) write.ttl = options.ttl;
  if (options.tags !== undefined) write.tags = options.tags;
  return write;
}

/** Copies the defined `LoadPolicy` options of `options` onto `load`. */
function withLoadPolicy<O extends LoadPolicy<T>, T>(load: O, options: LoadPolicy<T>): O {
  const { cacheNull, nullTtl, unless, lock } = options;
  if (cacheNull !== undefined) load.cacheNull = cacheNull;
  if (nullTtl !== undefined) load.nullTtl = nullTtl;
  if (unless !== undefined) load.unless = unless;
  if (lock !== undefined) load.lock = lock;
  return load;
}

function loadOptionsOf<T>(options: GetOrSetOptions<T>): LoadOptions<T> {
  return withLoadPolicy<LoadOptions<T>, T>(writeOptionsOf(options), options);
}

function loadManyOptionsOf<T>(options: GetOrSetManyOptions<T>): BatchLoadOptions<T> {
  return withLoadPolicy<BatchLoadOptions<T>, T>(writeManyOptionsOf(options), options);
}

export class CacheService {
  constructor(private readonly engine: CacheEngine) {}

  /**
   * Reads a value; returns `undefined` on a miss.
   *
   * Strategy options pick the read command (`sliding` touches the entry) and how the entry is
   * classified; a stale `swr` entry is returned as a hit with `stale: true`. `get` never refreshes.
   *
   * With `strategy: 'sliding'` the entry's window is reset to `defaults.ttl`, not to the `ttl` it
   * was written with, because `getAndTouch` needs the TTL before the entry is read.
   */
  get<T>(key: string, options: KeyOptions & StrategyOptions = {}): Promise<T | undefined> {
    return this.engine.get<T>(refOf(key, options), strategyOptionsOf(options));
  }

  set<T>(key: string, value: T, options: WriteOptions<T> = {}): Promise<void> {
    return this.engine.set(refOf(key, options), value, writeOptionsOf(options));
  }

  delete(key: string | readonly string[], options: KeyOptions = {}): Promise<void> {
    return this.engine.delete(scopeOf(options), typeof key === 'string' ? [key] : key);
  }

  clear(namespace: string, options: { store?: string } = {}): Promise<void> {
    return this.engine.clear(namespace, options.store);
  }

  getOrSet<T>(key: string, loader: () => Promise<T>, options: GetOrSetOptions<T> = {}): Promise<T> {
    return this.engine.getOrSet(refOf(key, options), loader, loadOptionsOf(options));
  }

  /**
   * Invalidates every entry stamped with one of `tags` in the store (`options.store`, else
   * `default`), across namespaces: each tag gets a new version, so those entries read as misses.
   * This instance sees it at once; other instances once their cached version expires
   * (`versioning.cacheTtl`). Tags are plain strings, used as is.
   *
   * Rejects with `CacheConfigError` when `tags` is not a non-empty array of non-empty strings,
   * has more than 32 tags after de-duplication, or the store is unknown. When a version write
   * fails, every tag is still tried; an `error` event with operation `'version'` is emitted and
   * the call rejects with the first failure.
   */
  invalidateTags(tags: readonly string[], options: { store?: string } = {}): Promise<void> {
    return this.engine.invalidateTags(tags, options.store);
  }

  /**
   * Reads several keys of one namespace and store; results follow `keys`, `undefined` for a
   * miss. One store read for the batch (MGET on Redis), except with `strategy: 'sliding'`,
   * which touches each entry with its own `getAndTouch`.
   */
  getMany<T>(
    keys: readonly string[],
    options: KeyOptions & StrategyOptions = {},
  ): Promise<(T | undefined)[]> {
    return this.engine.getMany<T>(scopeOf(options), keys, strategyOptionsOf(options));
  }

  /** Writes several entries, each as `set` would, with one store call when the store allows. */
  setMany<T>(
    entries: readonly (readonly [key: string, value: T])[],
    options: WriteManyOptions<T> = {},
  ): Promise<void> {
    return this.engine.setMany(scopeOf(options), entries, writeManyOptionsOf(options));
  }

  /**
   * `getOrSet` for several keys: hits are served, and the misses are loaded with one
   * `loader(missing)` call that resolves a Map. A key the loader omits is treated as
   * `undefined`; keys it was not asked for are ignored. `lock: true` is not supported.
   */
  getOrSetMany<T>(
    keys: readonly string[],
    loader: (missing: string[]) => Promise<ReadonlyMap<string, T>>,
    options: GetOrSetManyOptions<T> = {},
  ): Promise<(T | undefined)[]> {
    return this.engine.getOrSetMany(scopeOf(options), keys, loader, loadManyOptionsOf(options));
  }
}
