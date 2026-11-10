import type { StrategyOptions } from '../decorators/options.js';
import type { BatchScope, CacheEngine, LoadOptions, SetOptions } from './cache-engine.js';
import { strategyOptionsOf } from './strategies/expiry-strategy.js';

export interface KeyOptions {
  namespace?: string;
  store?: string;
}

export type WriteOptions = KeyOptions & { ttl?: number } & StrategyOptions;

export type GetOrSetOptions<T> = WriteOptions & {
  cacheNull?: boolean;
  nullTtl?: number;
  unless?: (result: T) => boolean;
  lock?: boolean;
};

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

function writeOptionsOf(options: WriteOptions): SetOptions {
  const write: SetOptions = strategyOptionsOf(options);
  if (options.ttl !== undefined) write.ttl = options.ttl;
  return write;
}

function loadOptionsOf<T>(options: GetOrSetOptions<T>): LoadOptions<T> {
  const { cacheNull, nullTtl, unless, lock } = options;
  const load: LoadOptions<T> = writeOptionsOf(options);
  if (cacheNull !== undefined) load.cacheNull = cacheNull;
  if (nullTtl !== undefined) load.nullTtl = nullTtl;
  if (unless !== undefined) load.unless = unless;
  if (lock !== undefined) load.lock = lock;
  return load;
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

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- public API (spec 5.3)
  set<T>(key: string, value: T, options: WriteOptions = {}): Promise<void> {
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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- public API (spec 0.4 2.2)
  setMany<T>(
    entries: readonly (readonly [key: string, value: T])[],
    options: WriteOptions = {},
  ): Promise<void> {
    return this.engine.setMany(scopeOf(options), entries, writeOptionsOf(options));
  }

  /**
   * `getOrSet` for several keys: hits are served, and the misses are loaded with one
   * `loader(missing)` call that resolves a Map. A key the loader omits is treated as
   * `undefined`; keys it was not asked for are ignored. `lock: true` is not supported.
   */
  getOrSetMany<T>(
    keys: readonly string[],
    loader: (missing: string[]) => Promise<ReadonlyMap<string, T>>,
    options: GetOrSetOptions<T> = {},
  ): Promise<(T | undefined)[]> {
    return this.engine.getOrSetMany(scopeOf(options), keys, loader, loadOptionsOf(options));
  }
}
