import { CacheConfigError } from '../errors.js';
import type { ResolvedCacheOptions } from '../module/cache.options.js';
import type { CacheStore } from '../stores/cache-store.interface.js';
import { isExpired, unwrap, wrap } from './envelope.js';
import type { CacheEvents, CacheOperation } from './events.js';
import { fullKey, namespacePrefix } from './key-builder.js';

export interface KeyRef {
  store?: string;
  namespace?: string;
  key: string;
}

export interface PutOptions<T> {
  ttl?: number;
  cacheNull?: boolean;
  nullTtl?: number;
  unless?: (result: T) => boolean;
}

interface Target {
  name: string;
  store: CacheStore;
}

export class CacheEngine {
  constructor(
    private readonly options: ResolvedCacheOptions,
    private readonly events: CacheEvents,
  ) {}

  hasStore(name: string): boolean {
    return this.options.stores.has(name);
  }

  storeNames(): string[] {
    return [...this.options.stores.keys()];
  }

  async get<T>(ref: KeyRef): Promise<T | undefined> {
    const { name, store } = this.resolve(ref.store);
    const key = fullKey(this.options.prefix, ref.namespace, ref.key);
    let raw: string | undefined;
    try {
      raw = await store.get(key);
    } catch (error) {
      this.reportError(name, 'get', error);
      this.miss(name, ref);
      return undefined;
    }
    if (raw === undefined) {
      this.miss(name, ref);
      return undefined;
    }
    let envelope;
    try {
      envelope = this.options.serializer.deserialize(raw);
    } catch (error) {
      this.reportError(name, 'deserialize', error);
      try {
        await store.delete([key]);
      } catch {
        // cleanup is best effort; the failure is already reported
      }
      this.miss(name, ref);
      return undefined;
    }
    if (isExpired(envelope, Date.now())) {
      this.miss(name, ref);
      return undefined;
    }
    this.events.emit('hit', {
      store: name,
      namespace: ref.namespace,
      key: ref.key,
      stale: false,
    });
    return unwrap(envelope) as T | undefined;
  }

  async set(ref: KeyRef, value: unknown, ttl?: number): Promise<void> {
    const target = this.resolve(ref.store);
    const effective = this.jittered(ttl ?? this.options.defaults.ttl);
    await this.write(target, ref, value, effective);
  }

  async put<T>(ref: KeyRef, value: T, options: PutOptions<T> = {}): Promise<void> {
    const target = this.resolve(ref.store);
    try {
      if (options.unless?.(value) === true) return;
    } catch (error) {
      this.reportError(target.name, 'set', error);
      return;
    }
    if (value === null || value === undefined) {
      if (!(options.cacheNull ?? this.options.defaults.cacheNull)) {
        await this.delete({ store: ref.store, namespace: ref.namespace }, [ref.key]);
        return;
      }
      await this.write(target, ref, value, options.nullTtl ?? this.options.defaults.nullTtl);
      return;
    }
    await this.write(target, ref, value, this.jittered(options.ttl ?? this.options.defaults.ttl));
  }

  async delete(
    scope: { store?: string; namespace?: string },
    keys: readonly string[],
  ): Promise<void> {
    const { name, store } = this.resolve(scope.store);
    if (keys.length === 0) return;
    const fullKeys = keys.map((k) => fullKey(this.options.prefix, scope.namespace, k));
    try {
      await store.delete(fullKeys);
    } catch (error) {
      this.reportError(name, 'delete', error);
      return;
    }
    this.events.emit('delete', { store: name, namespace: scope.namespace, keys });
  }

  async clear(namespace: string, storeName?: string): Promise<void> {
    const { name, store } = this.resolve(storeName);
    try {
      await store.clear(namespacePrefix(this.options.prefix, namespace));
    } catch (error) {
      this.reportError(name, 'clear', error);
      return;
    }
    this.events.emit('clear', { store: name, namespace });
  }

  reportError(store: string | undefined, operation: CacheOperation, error: unknown): void {
    this.events.emit('error', { store: store ?? 'default', operation, error });
  }

  private async write(
    { name, store }: Target,
    ref: KeyRef,
    value: unknown,
    ttl: number,
  ): Promise<void> {
    const key = fullKey(this.options.prefix, ref.namespace, ref.key);
    try {
      const raw = this.options.serializer.serialize(wrap(value, Date.now(), ttl));
      await store.set(key, raw, ttl);
    } catch (error) {
      this.reportError(name, 'set', error);
      return;
    }
    this.events.emit('set', { store: name, namespace: ref.namespace, key: ref.key, ttl });
  }

  private miss(store: string, ref: KeyRef): void {
    this.events.emit('miss', { store, namespace: ref.namespace, key: ref.key });
  }

  private jittered(ttl: number): number {
    const { jitter } = this.options.defaults;
    return Math.max(1, Math.round(ttl * (1 + (Math.random() * 2 - 1) * jitter)));
  }

  private resolve(name: string | undefined): Target {
    const resolved = name ?? 'default';
    const store = this.options.stores.get(resolved);
    if (store === undefined) {
      throw new CacheConfigError(
        `Unknown cache store "${resolved}". Configured stores: ${this.storeNames().join(', ')}`,
      );
    }
    return { name: resolved, store };
  }
}
