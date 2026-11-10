import { CacheConfigError } from '../errors.js';
import type { ResolvedCacheOptions } from '../module/cache.options.js';
import type { CacheStore } from '../stores/cache-store.interface.js';
import { isEnvelope, isExpired, unwrap, wrap } from './envelope.js';
import type { CacheEvents, CacheOperation } from './events.js';
import { fullKey, namespacePrefix } from './key-builder.js';
import { SingleFlight } from './single-flight.js';

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

type Lookup = { found: true; value: unknown } | { found: false };

function checkDuration(option: string, value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new CacheConfigError(
      `Invalid ${option}: ${String(value)}. Durations are milliseconds, finite numbers greater than 0.`,
    );
  }
}

function toIntegerMs(ms: number): number {
  return Math.max(1, Math.round(ms));
}

export class CacheEngine {
  private readonly singleFlight = new SingleFlight();

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
    const result = await this.lookup(this.resolve(ref.store), ref);
    return result.found ? (result.value as T | undefined) : undefined;
  }

  async getOrSet<T>(
    ref: KeyRef,
    loader: () => Promise<T>,
    options: PutOptions<T> = {},
  ): Promise<T> {
    const target = this.resolve(ref.store);
    checkDuration('ttl', options.ttl);
    checkDuration('nullTtl', options.nullTtl);
    const cached = await this.lookup(target, ref);
    if (cached.found) return cached.value as T;
    const flightKey = `${target.name}\u0000${fullKey(this.options.prefix, ref.namespace, ref.key)}`;
    return this.singleFlight.run(flightKey, async () => {
      const started = Date.now();
      let value: T;
      try {
        value = await loader();
      } catch (error) {
        this.emitLoad(target.name, ref, started, false);
        throw error;
      }
      this.emitLoad(target.name, ref, started, true);
      await this.store(target, ref, value, options, false);
      return value;
    });
  }

  async set(ref: KeyRef, value: unknown, ttl?: number): Promise<void> {
    const target = this.resolve(ref.store);
    checkDuration('ttl', ttl);
    await this.write(target, ref, value, this.jittered(ttl ?? this.options.defaults.ttl));
  }

  async put<T>(ref: KeyRef, value: T, options: PutOptions<T> = {}): Promise<void> {
    const target = this.resolve(ref.store);
    checkDuration('ttl', options.ttl);
    checkDuration('nullTtl', options.nullTtl);
    await this.store(target, ref, value, options, true);
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

  private async lookup({ name, store }: Target, ref: KeyRef): Promise<Lookup> {
    const key = fullKey(this.options.prefix, ref.namespace, ref.key);
    let raw: string | undefined;
    try {
      raw = await store.get(key);
    } catch (error) {
      this.reportError(name, 'get', error);
      this.miss(name, ref);
      return { found: false };
    }
    if (raw === undefined) {
      this.miss(name, ref);
      return { found: false };
    }
    let envelope;
    try {
      envelope = this.options.serializer.deserialize(raw);
      if (!isEnvelope(envelope)) throw new TypeError('Deserialized value is not a cache envelope');
    } catch (error) {
      this.reportError(name, 'deserialize', error);
      try {
        await store.delete([key]);
      } catch {
        // cleanup is best effort; the failure is already reported
      }
      this.miss(name, ref);
      return { found: false };
    }
    if (isExpired(envelope, Date.now())) {
      this.miss(name, ref);
      return { found: false };
    }
    this.events.emit('hit', { store: name, namespace: ref.namespace, key: ref.key, stale: false });
    return { found: true, value: unwrap(envelope) };
  }

  private async store<T>(
    target: Target,
    ref: KeyRef,
    value: T,
    options: PutOptions<T>,
    deleteWhenEmpty: boolean,
  ): Promise<void> {
    try {
      if (options.unless?.(value) === true) return;
    } catch (error) {
      this.reportError(target.name, 'set', error);
      return;
    }
    if (value === null || value === undefined) {
      if (!(options.cacheNull ?? this.options.defaults.cacheNull)) {
        if (deleteWhenEmpty) {
          await this.delete({ store: ref.store, namespace: ref.namespace }, [ref.key]);
        }
        return;
      }
      await this.write(
        target,
        ref,
        value,
        toIntegerMs(options.nullTtl ?? this.options.defaults.nullTtl),
      );
      return;
    }
    await this.write(target, ref, value, this.jittered(options.ttl ?? this.options.defaults.ttl));
  }

  private emitLoad(store: string, ref: KeyRef, started: number, success: boolean): void {
    this.events.emit('load', {
      store,
      namespace: ref.namespace,
      key: ref.key,
      durationMs: Date.now() - started,
      success,
    });
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
    return toIntegerMs(ttl * (1 + (Math.random() * 2 - 1) * jitter));
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
