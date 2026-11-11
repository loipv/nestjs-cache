import type { StrategyOptions } from '../decorators/options.js';
import { CacheConfigError } from '../errors.js';
import type { ResolvedCacheOptions } from '../module/cache.options.js';
import { CircuitOpenError } from '../resilience/circuit-breaker.store.js';
import { jsonSerializer } from '../serializers/json.serializer.js';
import type { CacheStore } from '../stores/cache-store.interface.js';
import { isEnvelope, unwrap, type CacheEnvelope } from './envelope.js';
import type { CacheEventMap, CacheEvents, CacheOperation } from './events.js';
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

/** One entry of a batch: its plain key (in `ref`, for events) and its resolved keys. */
export interface BatchItem {
  ref: KeyRef;
  key: ResolvedKey;
}

/** A batch entry ready to write; `ttl` is an integer >= 1, already jittered if needed. */
export interface WriteItem extends BatchItem {
  value: unknown;
  strategy: ExpiryStrategy;
  ttl: number;
}

/** How a value is written: with a strategy and ttl, or not at all (`empty`: uncached null). */
type WritePlan = { strategy: ExpiryStrategy; ttl: number } | 'skip' | 'empty';

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
   * its token; on a failure it reports one `version` error and falls back to the last token this
   * process knew for the namespace, or resolves `undefined` when there is none, and the caller
   * then skips the cache.
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

  /**
   * The keys of every `keys` entry in one namespace, in input order. As `resolveKey`, but one
   * version read serves the whole batch. A failed read reports one `version` error and falls back
   * as `resolveKey` does, or resolves `undefined`.
   */
  resolveKeys(
    target: Target,
    namespace: string | undefined,
    keys: readonly string[],
  ): ResolvedKey[] | Promise<ResolvedKey[] | undefined> {
    if (namespace === undefined || !this.versions.isVersioned(namespace)) {
      return keys.map((key) => this.keysOf(namespace, key));
    }
    return this.versionedNamespace(target, namespace).then((resolved) =>
      resolved === undefined ? undefined : keys.map((key) => this.keysOf(resolved, key)),
    );
  }

  private keysOf(namespace: string | undefined, key: string): ResolvedKey {
    const { prefix } = this.options;
    return { full: fullKey(prefix, namespace, key), lock: lockKey(prefix, namespace, key) };
  }

  /**
   * `<ns>@<v>`. When the version read fails it reports one `version` error. A store with
   * `getStrict` then uses the last token this process knew (even past `cacheTtl`) for this call
   * only, so the next call reads the store again; `undefined` when no token was ever known, and
   * always for a store without `getStrict`. Never rejects. Deletes do not use it.
   */
  private async versionedNamespace(target: Target, namespace: string): Promise<string | undefined> {
    try {
      return `${namespace}@${await this.versions.current(target, namespace)}`;
    } catch (error) {
      this.reportError(target.name, 'version', error);
      // Only stores with getStrict (tiered, or a breaker over one) opt into the fallback.
      if (target.store.getStrict === undefined) return undefined;
      const known = this.versions.cached(target, namespace);
      return known === undefined ? undefined : `${namespace}@${known}`;
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
    target: Target,
    { full: key }: ResolvedKey,
    strategy: ExpiryStrategy,
    ttl: number,
  ): Promise<Lookup> {
    const { name, store } = target;
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
    return this.decode(target, key, raw, strategy, plan.touch, reSet ? touchTtl : undefined);
  }

  /**
   * Reads several entries, in input order, as `read` would, without emitting `hit`/`miss`. A
   * touching strategy (sliding) reads each key with `read`, so each entry's window is reset;
   * any other reads them all with one `store.getMany` (one `get` per key without it). A failing
   * batch read is one `get` error and misses.
   */
  async readMany(
    target: Target,
    keys: readonly ResolvedKey[],
    strategy: ExpiryStrategy,
    ttl: number,
  ): Promise<Lookup[]> {
    if (strategy.read(toIntegerMs(ttl)).touch) {
      return Promise.all(keys.map((key) => this.read(target, key, strategy, ttl)));
    }
    const raws = await this.fetchMany(
      target,
      keys.map((key) => key.full),
    );
    return Promise.all(
      keys.map((key, i) => this.decode(target, key.full, raws[i], strategy, false, undefined)),
    );
  }

  /** The raw strings of `keys`; a failure is one `get` error, its keys then read as misses. */
  private async fetchMany(
    { name, store }: Target,
    keys: readonly string[],
  ): Promise<(string | undefined)[]> {
    if (keys.length === 0) return [];
    if (store.getMany !== undefined) {
      try {
        return await store.getMany(keys);
      } catch (error) {
        this.reportError(name, 'get', error);
        return [];
      }
    }
    const settled = await Promise.allSettled(keys.map(async (key) => store.get(key)));
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed !== undefined) this.reportError(name, 'get', failed.reason);
    return settled.map((result) => (result.status === 'fulfilled' ? result.value : undefined));
  }

  /**
   * Classifies a raw string read from `key`. `touched` tells whether the read reset the
   * entry's TTL; `reSetTtl` is set when a touching read had to use `get` and must re-set.
   */
  private async decode(
    { name, store }: Target,
    key: string,
    raw: string | undefined,
    strategy: ExpiryStrategy,
    touched: boolean,
    reSetTtl: number | undefined,
  ): Promise<Lookup> {
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
      if (touched || classifyEnvelope(envelope, now) !== 'expired') {
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
    if (reSetTtl !== undefined && state === 'fresh') {
      try {
        await store.set(key, raw, reSetTtl);
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
    const plan = this.writePlan(target, value, options, strategy);
    if (plan === 'skip') return;
    if (plan === 'empty') {
      // Through `delete`, so a versioned namespace reads its token fresh, as any delete does.
      if (deleteWhenEmpty) {
        await this.delete({ store: ref.store, namespace: ref.namespace }, [ref.key]);
      }
      return;
    }
    await this.write(target, ref, key, value, plan.strategy, plan.ttl);
  }

  /** `store` for loaded batch values, written with one `writeMany`; it never deletes. */
  async storeMany<T>(
    target: Target,
    items: readonly (BatchItem & { value: T })[],
    options: PutOptions<T>,
    strategy: ExpiryStrategy,
  ): Promise<void> {
    const writes: WriteItem[] = [];
    for (const item of items) {
      const plan = this.writePlan(target, item.value, options, strategy);
      if (typeof plan === 'object') writes.push({ ...item, ...plan });
    }
    await this.writeMany(target, writes);
  }

  /** The `unless`/`cacheNull` policy of a value; a throwing `unless` is a `set` error. */
  private writePlan<T>(
    target: Target,
    value: T,
    options: PutOptions<T>,
    strategy: ExpiryStrategy,
  ): WritePlan {
    try {
      if (options.unless?.(value) === true) return 'skip';
    } catch (error) {
      this.reportError(target.name, 'set', error);
      return 'skip';
    }
    if (isEmpty(value)) {
      if (!(options.cacheNull ?? this.options.defaults.cacheNull)) return 'empty';
      const nullTtl = toIntegerMs(options.nullTtl ?? this.options.defaults.nullTtl);
      return { strategy: EMPTY_STRATEGY, ttl: nullTtl };
    }
    return { strategy, ttl: this.ttlFor(strategy, options.ttl ?? this.options.defaults.ttl) };
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

  /**
   * Writes several entries with one `store.setMany` (one `set` per entry without it), each as
   * `write` would, emitting `set` per written entry. A value that cannot be serialized is a
   * `set` error and is left out; a failing batch write is one `set` error. Keys are unique.
   */
  async writeMany({ name, store }: Target, items: readonly WriteItem[]): Promise<void> {
    const entries: { key: string; value: string; ttlMs: number }[] = [];
    const written: { ref: KeyRef; ttl: number }[] = [];
    for (const { ref, key, value, strategy, ttl } of items) {
      try {
        const wrapped = strategy.wrap(value, Date.now(), ttl);
        const serialized = this.options.serializer.serialize(wrapped.envelope);
        entries.push({ key: key.full, value: serialized, ttlMs: wrapped.storeTtl });
        written.push({ ref, ttl: wrapped.storeTtl });
      } catch (error) {
        this.reportError(name, 'set', error);
      }
    }
    if (entries.length === 0) return;
    let stored: boolean[];
    if (store.setMany !== undefined) {
      try {
        await store.setMany(entries);
      } catch (error) {
        this.reportError(name, 'set', error);
        return;
      }
      stored = entries.map(() => true);
    } else {
      const settled = await Promise.allSettled(
        entries.map(async (e) => store.set(e.key, e.value, e.ttlMs)),
      );
      const failed = settled.find((result) => result.status === 'rejected');
      if (failed !== undefined) this.reportError(name, 'set', failed.reason);
      stored = settled.map((result) => result.status === 'fulfilled');
    }
    written.forEach(({ ref, ttl }, i) => {
      if (stored[i] !== true) return;
      this.events.emit('set', { store: name, namespace: ref.namespace, key: ref.key, ttl });
    });
  }

  async delete(
    scope: { store?: string | undefined; namespace?: string | undefined },
    keys: readonly string[],
  ): Promise<void> {
    const target = this.resolve(scope.store);
    if (keys.length === 0) return;
    const { name, store } = target;
    const { namespace } = scope;
    let namespaces: readonly (string | undefined)[] = [namespace];
    if (namespace !== undefined && this.versions.isVersioned(namespace)) {
      const versioned = await this.deleteNamespaces(target, namespace);
      if (versioned === undefined) return;
      namespaces = versioned;
    }
    const fullKeys = namespaces.flatMap((ns) =>
      keys.map((key) => fullKey(this.options.prefix, ns, key)),
    );
    try {
      await store.delete(fullKeys);
    } catch (error) {
      this.reportError(name, 'delete', error);
      return;
    }
    this.events.emit('delete', { store: name, namespace, keys });
  }

  /**
   * The `<ns>@<v>` forms a delete removes: the token read fresh from the store, so an entry
   * another instance wrote after its clear is deleted within `cacheTtl` too, plus any other
   * token this instance had cached (its own writes may sit under it). One version read for the
   * whole call; `undefined` after reporting a `version` error.
   */
  private async deleteNamespaces(target: Target, namespace: string): Promise<string[] | undefined> {
    const previous = this.versions.cached(target, namespace);
    let token: string;
    try {
      token = await this.versions.fresh(target, namespace);
    } catch (error) {
      this.reportError(target.name, 'version', error);
      return undefined;
    }
    // A bump during the read leaves its newer token cached: delete under it as well.
    const tokens = new Set([token]);
    for (const other of [previous, this.versions.cached(target, namespace)]) {
      if (other !== undefined) tokens.add(other);
    }
    return [...tokens].map((t) => `${namespace}@${t}`);
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

  /** `keys` is set by a batch load only, so a single-key `load` keeps its 0.3 shape. */
  emitLoad(
    store: string,
    ref: KeyRef,
    started: number,
    success: boolean,
    keys?: readonly string[],
  ): void {
    const payload: CacheEventMap['load'] = {
      store,
      namespace: ref.namespace,
      key: ref.key,
      durationMs: Date.now() - started,
      success,
    };
    if (keys !== undefined) payload.keys = keys;
    this.events.emit('load', payload);
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
