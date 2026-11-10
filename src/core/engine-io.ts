import type { StrategyOptions } from '../decorators/options.js';
import { CacheConfigError } from '../errors.js';
import type { ResolvedCacheOptions } from '../module/cache.options.js';
import { CircuitOpenError } from '../resilience/circuit-breaker.store.js';
import type { CacheStore } from '../stores/cache-store.interface.js';
import { isEnvelope, unwrap, type CacheEnvelope } from './envelope.js';
import type { CacheEvents, CacheOperation } from './events.js';
import { fullKey, namespacePrefix } from './key-builder.js';
import {
  classifyEnvelope,
  createStrategy,
  type ExpiryStrategy,
} from './strategies/expiry-strategy.js';

export interface KeyRef {
  store?: string;
  namespace?: string;
  key: string;
}

export type PutOptions<T> = {
  ttl?: number;
  cacheNull?: boolean;
  nullTtl?: number;
  unless?: (result: T) => boolean;
} & StrategyOptions;

export interface Target {
  name: string;
  store: CacheStore;
}

export type Lookup = { found: true; value: unknown; stale: boolean } | { found: false };

/** Empty values always use `fixed`: it is the strategy that keeps the `nil` marker. */
export const EMPTY_STRATEGY = createStrategy();

export function toIntegerMs(ms: number): number {
  return Math.max(1, Math.round(ms));
}

/** A stale entry is served only under swr; any other reader has a loader and reloads now. */
export function servable(
  lookup: Lookup,
  strategy: ExpiryStrategy,
): lookup is Extract<Lookup, { found: true }> {
  return lookup.found && (!lookup.stale || strategy.kind === 'swr');
}

export function isEmpty(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * Store reads and writes plus the events they emit, shared by the engine facade and the
 * load orchestration. Nothing here validates options; the facade does that first.
 */
export class EngineIO {
  constructor(
    private readonly options: ResolvedCacheOptions,
    private readonly events: CacheEvents,
  ) {}

  keyOf(ref: { namespace?: string | undefined; key: string }): string {
    return fullKey(this.options.prefix, ref.namespace, ref.key);
  }

  resolve(name: string | undefined): Target {
    const resolved = name ?? 'default';
    const store = this.options.stores.get(resolved);
    if (store === undefined) {
      throw new CacheConfigError(
        `Unknown cache store "${resolved}". Configured stores: ${[...this.options.stores.keys()].join(', ')}`,
      );
    }
    return { name: resolved, store };
  }

  reportError(store: string | undefined, operation: CacheOperation, error: unknown): void {
    // An open circuit means the store is temporarily absent, not broken: no `error` event.
    if (error instanceof CircuitOpenError) return;
    this.events.emit('error', { store: store ?? 'default', operation, error });
  }

  /**
   * Reads and classifies an entry without emitting `hit`/`miss`; callers decide which one
   * applies. `ttl` is the effective ttl, used as the sliding touch ttl.
   */
  async read(
    { name, store }: Target,
    ref: KeyRef,
    strategy: ExpiryStrategy,
    ttl: number,
  ): Promise<Lookup> {
    const key = this.keyOf(ref);
    const plan = strategy.read(toIntegerMs(ttl));
    const touchTtl = plan.touch ? plan.touchTtl : undefined;
    // Without getAndTouch, a touching read is a get, then a re-set of the same string.
    const reSet = touchTtl !== undefined && store.getAndTouch === undefined;
    let raw: string | undefined;
    try {
      raw =
        touchTtl !== undefined && store.getAndTouch !== undefined
          ? await store.getAndTouch(key, touchTtl)
          : await store.get(key);
    } catch (error) {
      this.reportError(name, 'get', error);
      return { found: false };
    }
    if (raw === undefined) return { found: false };
    let envelope: CacheEnvelope;
    try {
      const candidate = this.options.serializer.deserialize(raw);
      if (!isEnvelope(candidate)) throw new TypeError('Deserialized value is not a cache envelope');
      envelope = candidate;
    } catch (error) {
      this.reportError(name, 'deserialize', error);
      try {
        await store.delete([key]);
      } catch {
        // cleanup is best effort; the failure is already reported
      }
      return { found: false };
    }
    const now = Date.now();
    const state = strategy.classify(envelope, now);
    if (state === 'expired') {
      // The store TTL would keep the entry alive when only the strategy expired it (sliding
      // maxTtl), or when this read just touched it. A non-touching read of an entry past its
      // own expiresAt is left for the store to drop, as in 0.1: no delete command is added.
      if (plan.touch || classifyEnvelope(envelope, now) !== 'expired') {
        try {
          await store.delete([key]);
        } catch {
          // cleanup is best effort; the read is a miss either way
        }
      }
      return { found: false };
    }
    // Only a touching reader re-sets, and only a fresh entry: an expired one returned above, so
    // maxTtl still bounds a sliding entry, and a stale one is reloaded (getOrSet) or only read
    // (get) by a reader that is not swr. Not atomic.
    if (reSet && state === 'fresh') {
      try {
        await store.set(key, raw, touchTtl);
      } catch (error) {
        this.reportError(name, 'set', error);
      }
    }
    return { found: true, value: unwrap(envelope), stale: state === 'stale' };
  }

  /** Applies the `unless`/`cacheNull` policy, then writes with the matching strategy. */
  async store<T>(
    target: Target,
    ref: KeyRef,
    value: T,
    options: PutOptions<T>,
    strategy: ExpiryStrategy,
    deleteWhenEmpty: boolean,
  ): Promise<void> {
    try {
      if (options.unless?.(value) === true) return;
    } catch (error) {
      this.reportError(target.name, 'set', error);
      return;
    }
    if (isEmpty(value)) {
      if (!(options.cacheNull ?? this.options.defaults.cacheNull)) {
        if (deleteWhenEmpty) {
          await this.delete({ store: ref.store, namespace: ref.namespace }, [ref.key]);
        }
        return;
      }
      const nullTtl = toIntegerMs(options.nullTtl ?? this.options.defaults.nullTtl);
      await this.write(target, ref, value, EMPTY_STRATEGY, nullTtl);
      return;
    }
    const ttl = this.ttlFor(strategy, options.ttl ?? this.options.defaults.ttl);
    await this.write(target, ref, value, strategy, ttl);
  }

  /** `ttl` is an integer >= 1, already jittered when the strategy asks for it. */
  async write(
    { name, store }: Target,
    ref: KeyRef,
    value: unknown,
    strategy: ExpiryStrategy,
    ttl: number,
  ): Promise<void> {
    const key = this.keyOf(ref);
    let storeTtl: number;
    try {
      const wrapped = strategy.wrap(value, Date.now(), ttl);
      storeTtl = wrapped.storeTtl;
      await store.set(key, this.options.serializer.serialize(wrapped.envelope), storeTtl);
    } catch (error) {
      this.reportError(name, 'set', error);
      return;
    }
    this.events.emit('set', { store: name, namespace: ref.namespace, key: ref.key, ttl: storeTtl });
  }

  async delete(
    scope: { store?: string | undefined; namespace?: string | undefined },
    keys: readonly string[],
  ): Promise<void> {
    const { name, store } = this.resolve(scope.store);
    if (keys.length === 0) return;
    const fullKeys = keys.map((key) => this.keyOf({ namespace: scope.namespace, key }));
    try {
      await store.delete(fullKeys);
    } catch (error) {
      this.reportError(name, 'delete', error);
      return;
    }
    this.events.emit('delete', { store: name, namespace: scope.namespace, keys });
  }

  async clear(storeName: string | undefined, namespace: string): Promise<void> {
    const { name, store } = this.resolve(storeName);
    try {
      await store.clear(namespacePrefix(this.options.prefix, namespace));
    } catch (error) {
      this.reportError(name, 'clear', error);
      return;
    }
    this.events.emit('clear', { store: name, namespace });
  }

  emitLoad(store: string, ref: KeyRef, started: number, success: boolean): void {
    this.events.emit('load', {
      store,
      namespace: ref.namespace,
      key: ref.key,
      durationMs: Date.now() - started,
      success,
    });
  }

  emitLock(store: string, ref: KeyRef, waitedMs: number, acquired: boolean): void {
    this.events.emit('lock', { store, namespace: ref.namespace, key: ref.key, waitedMs, acquired });
  }

  hit(store: string, ref: KeyRef, stale: boolean): void {
    this.events.emit('hit', { store, namespace: ref.namespace, key: ref.key, stale });
  }

  miss(store: string, ref: KeyRef): void {
    this.events.emit('miss', { store, namespace: ref.namespace, key: ref.key });
  }

  ttlFor(strategy: ExpiryStrategy, ttl: number): number {
    return strategy.jittered ? this.jittered(ttl) : toIntegerMs(ttl);
  }

  private jittered(ttl: number): number {
    const { jitter } = this.options.defaults;
    return toIntegerMs(ttl * (1 + (Math.random() * 2 - 1) * jitter));
  }
}
