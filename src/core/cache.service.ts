import type { StrategyOptions } from '../decorators/options.js';
import type { CacheEngine, LoadOptions, SetOptions } from './cache-engine.js';
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
    const write: SetOptions = strategyOptionsOf(options);
    if (options.ttl !== undefined) write.ttl = options.ttl;
    return this.engine.set(refOf(key, options), value, write);
  }

  delete(key: string | readonly string[], options: KeyOptions = {}): Promise<void> {
    const scope: { store?: string; namespace?: string } = {};
    if (options.store !== undefined) scope.store = options.store;
    if (options.namespace !== undefined) scope.namespace = options.namespace;
    return this.engine.delete(scope, typeof key === 'string' ? [key] : key);
  }

  clear(namespace: string, options: { store?: string } = {}): Promise<void> {
    return this.engine.clear(namespace, options.store);
  }

  getOrSet<T>(key: string, loader: () => Promise<T>, options: GetOrSetOptions<T> = {}): Promise<T> {
    const { ttl, cacheNull, nullTtl, unless, lock } = options;
    const load: LoadOptions<T> = strategyOptionsOf(options);
    if (ttl !== undefined) load.ttl = ttl;
    if (cacheNull !== undefined) load.cacheNull = cacheNull;
    if (nullTtl !== undefined) load.nullTtl = nullTtl;
    if (unless !== undefined) load.unless = unless;
    if (lock !== undefined) load.lock = lock;
    return this.engine.getOrSet(refOf(key, options), loader, load);
  }
}
