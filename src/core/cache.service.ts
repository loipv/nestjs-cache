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
   * Strategy options pick the read command (`sliding` touches) and how the entry is
   * classified; a stale entry is returned as a hit. `get` never refreshes.
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
