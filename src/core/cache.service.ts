import type { StrategyOptions } from '../decorators/options.js';
import type { CacheEngine } from './cache-engine.js';

export interface KeyOptions {
  namespace?: string;
  store?: string;
}

export interface WriteOptions extends KeyOptions {
  ttl?: number;
}

export type GetOrSetOptions<T> = WriteOptions &
  StrategyOptions & { cacheNull?: boolean; nullTtl?: number; unless?: (result: T) => boolean };

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

  get<T>(key: string, options: KeyOptions = {}): Promise<T | undefined> {
    return this.engine.get<T>(refOf(key, options));
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- public API (spec 5.3)
  set<T>(key: string, value: T, options: WriteOptions = {}): Promise<void> {
    return this.engine.set(refOf(key, options), value, options.ttl);
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
    const { ttl, cacheNull, nullTtl, unless } = options;
    const put: { ttl?: number; cacheNull?: boolean; nullTtl?: number; unless?: (r: T) => boolean } =
      {};
    if (ttl !== undefined) put.ttl = ttl;
    if (cacheNull !== undefined) put.cacheNull = cacheNull;
    if (nullTtl !== undefined) put.nullTtl = nullTtl;
    if (unless !== undefined) put.unless = unless;
    return this.engine.getOrSet(refOf(key, options), loader, put);
  }
}
