import type { StrategyOptions } from '../decorators/options.js';
import { CacheConfigError } from '../errors.js';
import type { ResolvedCacheOptions } from '../module/cache.options.js';
import { CircuitOpenError } from '../resilience/circuit-breaker.store.js';
import { jsonSerializer } from '../serializers/json.serializer.js';
import type { CacheStore } from '../stores/cache-store.interface.js';
import { isEnvelope, unwrap, type CacheEnvelope } from './envelope.js';
import type { CacheEvents, CacheOperation } from './events.js';
import { fullKey, lockKey, namespacePrefix } from './key-builder.js';
import type { NamespaceVersions } from './namespace-versions.js';
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

/** The data key and the lock key of one entry, carrying the namespace version if any. */
export interface ResolvedKey {
  full: string;
  lock: string;
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

function hasOwnVersion(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'v')
  );
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
    private readonly versions: NamespaceVersions,
  ) {}

  /**
   * The keys of `ref` in `target`. A namespace that is not versioned resolves synchronously, so
   * callers await only a promise and the 0.3 path gains no await. A versioned namespace reads
   * its token; on a failure it reports one `version` error and resolves `undefined`, and the
   * caller then skips the cache.
   */
  resolveKey(
    target: Target,
    ref: { namespace?: string | undefined; key: string },
  ): ResolvedKey | Promise<ResolvedKey | undefined> {
    const { namespace, key } = ref;
    if (namespace === undefined || !this.versions.isVersioned(namespace)) {
      return this.keysOf(namespace, key);
    }
    return this.versionedNamespace(target, namespace).then((resolved) =>
      resolved === undefined ? undefined : this.keysOf(resolved, key),
    );
  }

  private keysOf(namespace: string | undefined, key: string): ResolvedKey {
    const { prefix } = this.options;
    return { full: fullKey(prefix, namespace, key), lock: lockKey(prefix, namespace, key) };
  }

  /** `<ns>@<v>`, or `undefined` after reporting a `version` error. Never rejects. */
  private async versionedNamespace(target: Target, namespace: string): Promise<string | undefined> {
    try {
      return `${namespace}@${await this.versions.current(target, namespace)}`;
    } catch (error) {
      this.reportError(target.name, 'version', error);
      return undefined;
    }
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
    { full: key }: ResolvedKey,
    strategy: ExpiryStrategy,
    ttl: number,
  ): Promise<Lookup> {
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
    let decoded: { value: unknown } | undefined;
    try {
      const candidate: unknown = this.options.serializer.deserialize(raw);
      decoded = { value: candidate };
      if (!isEnvelope(candidate)) throw new TypeError('Deserialized value is not a cache envelope');
      envelope = candidate;
    } catch (error) {
      this.reportError(name, 'deserialize', error);
      // Keys can name entries this library did not write (a lock token, another app's key on
      // a shared Redis): only an entry that looks like one of our envelopes is deleted.
      if (this.ownEnvelope(raw, decoded)) {
        try {
          await store.delete([key]);
        } catch {
          // cleanup is best effort; the failure is already reported
        }
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

  /**
   * Whether an unreadable entry was written by this library: a corrupted envelope or one of
   * another version, i.e. an object with an own `v`. `decoded` is what the serializer returned,
   * or `undefined` when it threw. The built-in JSON serializer validates the envelope itself, so
   * for it the raw JSON is inspected; a throwing custom serializer never leads to a delete.
   * Never throws: a value that cannot even be inspected (a revoked Proxy) is not ours.
   */
  private ownEnvelope(raw: string, decoded: { value: unknown } | undefined): boolean {
    try {
      if (decoded !== undefined) return hasOwnVersion(decoded.value);
      if (this.options.serializer !== jsonSerializer) return false;
      return hasOwnVersion(JSON.parse(raw));
    } catch {
      return false;
    }
  }

  /** Applies the `unless`/`cacheNull` policy, then writes with the matching strategy. */
  async store<T>(
    target: Target,
    ref: KeyRef,
    key: ResolvedKey,
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
        if (deleteWhenEmpty) await this.remove(target, ref.namespace, [ref.key], [key.full]);
        return;
      }
      const nullTtl = toIntegerMs(options.nullTtl ?? this.options.defaults.nullTtl);
      await this.write(target, ref, key, value, EMPTY_STRATEGY, nullTtl);
      return;
    }
    const ttl = this.ttlFor(strategy, options.ttl ?? this.options.defaults.ttl);
    await this.write(target, ref, key, value, strategy, ttl);
  }

  /** `ttl` is an integer >= 1, already jittered when the strategy asks for it. */
  async write(
    { name, store }: Target,
    ref: KeyRef,
    { full: key }: ResolvedKey,
    value: unknown,
    strategy: ExpiryStrategy,
    ttl: number,
  ): Promise<void> {
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
    const target = this.resolve(scope.store);
    if (keys.length === 0) return;
    let namespace = scope.namespace;
    if (namespace !== undefined && this.versions.isVersioned(namespace)) {
      // One version read for the whole call: the keys share their namespace.
      namespace = await this.versionedNamespace(target, namespace);
      if (namespace === undefined) return;
    }
    const fullKeys = keys.map((key) => fullKey(this.options.prefix, namespace, key));
    await this.remove(target, scope.namespace, keys, fullKeys);
  }

  /** `namespace` and `keys` are the plain ones the event carries; `fullKeys` are deleted. */
  private async remove(
    { name, store }: Target,
    namespace: string | undefined,
    keys: readonly string[],
    fullKeys: readonly string[],
  ): Promise<void> {
    try {
      await store.delete(fullKeys);
    } catch (error) {
      this.reportError(name, 'delete', error);
      return;
    }
    this.events.emit('delete', { store: name, namespace, keys });
  }

  /** A versioned namespace gets a new token instead of a scan; its old keys expire by TTL. */
  async clear(storeName: string | undefined, namespace: string): Promise<void> {
    const target = this.resolve(storeName);
    const { name, store } = target;
    if (this.versions.isVersioned(namespace)) {
      try {
        await this.versions.bump(target, namespace);
      } catch (error) {
        this.reportError(name, 'version', error);
        return;
      }
    } else {
      try {
        await store.clear(namespacePrefix(this.options.prefix, namespace));
      } catch (error) {
        this.reportError(name, 'clear', error);
        return;
      }
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
