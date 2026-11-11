import { CacheConfigError } from '../errors.js';
import type { ResolvedCacheOptions } from '../module/cache.options.js';
import { CircuitOpenError } from '../resilience/circuit-breaker.store.js';
import type { CacheEventMap, CacheEvents, CacheOperation, ReportError } from './events.js';
import {
  decode,
  deleteInvalid,
  stamped,
  toIntegerMs,
  writePlan,
  type BatchPutOptions,
  type EnvelopeContext,
  type Lookup,
  type PutOptions,
} from './engine-envelope.js';
import { EngineKeys, type ResolvedKey, type Target } from './engine-keys.js';
import { EngineTags, type Stamping, type TagCheck, type TagStamp } from './engine-tags.js';
import { fullKey, namespacePrefix } from './key-builder.js';
import type { NamespaceVersions } from './namespace-versions.js';
import type { ExpiryStrategy } from './strategies/expiry-strategy.js';
import type { VersionTokens } from './version-tokens.js';

export interface KeyRef {
  store?: string;
  namespace?: string;
  key: string;
}

export type { BatchPutOptions, Lookup, PutOptions } from './engine-envelope.js';
export { EMPTY_STRATEGY, isEmpty, servable, toIntegerMs, uncertain } from './engine-envelope.js';
export type { ResolvedKey, Target } from './engine-keys.js';

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
  /** The entry's tag stamp; absent (or empty) for an untagged entry. */
  tags?: TagStamp;
}

/**
 * Store reads and writes plus the events they emit, shared by the engine facade and the
 * load orchestration. Nothing here validates options; the facade does that first.
 */
export class EngineIO {
  private readonly resolver: EngineKeys;
  private readonly envelope: EnvelopeContext;
  /** Tag stamps for writes; their failures are reported through `reportError`. */
  readonly tags: EngineTags;

  constructor(
    private readonly options: ResolvedCacheOptions,
    private readonly events: CacheEvents,
    private readonly versions: NamespaceVersions,
    tokens: VersionTokens,
  ) {
    const reportError: ReportError = (store, operation, error) => {
      this.reportError(store, operation, error);
    };
    this.resolver = new EngineKeys(options, versions, reportError);
    this.tags = new EngineTags(tokens, reportError);
    this.envelope = {
      options,
      reportError,
      ttlFor: (strategy, ttl) => this.ttlFor(strategy, ttl),
    };
  }

  /** The keys of `ref` in `target`; see `EngineKeys.resolveKey`. */
  resolveKey(
    target: Target,
    ref: { namespace?: string | undefined; key: string },
  ): ResolvedKey | Promise<ResolvedKey | undefined> {
    return this.resolver.resolveKey(target, ref);
  }

  /** The keys of every `keys` entry in one namespace; see `EngineKeys.resolveKeys`. */
  resolveKeys(
    target: Target,
    namespace: string | undefined,
    keys: readonly string[],
  ): ResolvedKey[] | Promise<ResolvedKey[] | undefined> {
    return this.resolver.resolveKeys(target, namespace, keys);
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
  read(target: Target, key: ResolvedKey, strategy: ExpiryStrategy, ttl: number): Promise<Lookup> {
    return this.readEntry(target, key, strategy, ttl, true);
  }

  /**
   * `read`; with `verify` a tagged entry is checked against the current tag tokens, without it
   * the stamp is left in the lookup's `tags` (a batch checks them all at once).
   */
  private async readEntry(
    target: Target,
    { full: key }: ResolvedKey,
    strategy: ExpiryStrategy,
    ttl: number,
    verify: boolean,
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
    return decode(
      this.envelope,
      target,
      key,
      raw,
      strategy,
      plan.touch,
      reSet ? touchTtl : undefined,
      verify ? (stamp) => this.verifyOne(target, stamp) : undefined,
    );
  }

  private async verifyOne(target: Target, stamp: TagStamp): Promise<TagCheck> {
    const [check] = await this.tags.verify(target, [stamp]);
    return check ?? 'uncertain';
  }

  /**
   * Reads several entries, in input order, as `read` would, without emitting `hit`/`miss`. A
   * touching strategy (sliding) reads each key on its own, so each entry's window is reset;
   * any other reads them all with one `store.getMany` (one `get` per key without it). A failing
   * batch read is one `get` error and misses. Tag stamps are not checked here: a tagged entry
   * keeps its stamp in `tags`, and the caller passes the lookups to `checkStamps`.
   */
  async readMany(
    target: Target,
    keys: readonly ResolvedKey[],
    strategy: ExpiryStrategy,
    ttl: number,
  ): Promise<Lookup[]> {
    if (strategy.read(toIntegerMs(ttl)).touch) {
      return Promise.all(keys.map((key) => this.readEntry(target, key, strategy, ttl, false)));
    }
    const raws = await this.fetchMany(
      target,
      keys.map((key) => key.full),
    );
    return Promise.all(
      keys.map((key, i) =>
        decode(this.envelope, target, key.full, raws[i], strategy, false, undefined),
      ),
    );
  }

  /**
   * `lookups` from `readMany` with their tag stamps checked: one `currentMany` for all their tags
   * and at most one `version` error (spec 3.2). The store-confirmed invalid entries a
   * `getAndTouch` read extended are deleted with one `store.delete` (spec 3.3, T4-C); an
   * `unconfirmed` one is a plain miss. Synchronous when no entry is tagged, so an
   * untagged batch gains no await.
   */
  checkStamps(target: Target, lookups: readonly Lookup[]): readonly Lookup[] | Promise<Lookup[]> {
    const stamps = lookups.flatMap((lookup) =>
      lookup.found && lookup.tags !== undefined ? [lookup.tags] : [],
    );
    if (stamps.length === 0) return lookups;
    return this.tags.verify(target, stamps).then((checks) => {
      let next = 0;
      const extended: string[] = [];
      const checked = lookups.map((lookup): Lookup => {
        if (!lookup.found || lookup.tags === undefined) return lookup;
        const check = checks[next++];
        if (check === 'valid') return { found: true, value: lookup.value, stale: lookup.stale };
        // Only a store-confirmed mismatch deletes (T4-C); `unconfirmed` is a plain miss.
        if (check === 'invalid' && lookup.touched !== undefined) extended.push(lookup.touched);
        return check === 'invalid' || check === 'unconfirmed'
          ? { found: false }
          : { found: false, uncertain: true };
      });
      if (extended.length === 0) return checked;
      return deleteInvalid(this.envelope, target, extended).then(() => checked);
    });
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
   * Applies the `unless`/`cacheNull` policy, then writes with the matching strategy. `taken` is
   * the stamp of tags known before a load; without it, `options.tags` is stamped only once the
   * write is decided (a tag function gets the value). An entry without tags adds no await.
   */
  async store<T>(
    target: Target,
    ref: KeyRef,
    key: ResolvedKey,
    value: T,
    options: PutOptions<T>,
    strategy: ExpiryStrategy,
    deleteWhenEmpty: boolean,
    taken?: Stamping,
  ): Promise<void> {
    const plan = writePlan(this.envelope, target, value, options, strategy);
    if (plan === 'skip') return;
    if (plan === 'empty') {
      // Through `delete`, so a versioned namespace reads its token fresh, as any delete does.
      if (deleteWhenEmpty) {
        await this.delete({ store: ref.store, namespace: ref.namespace }, [ref.key]);
      }
      return;
    }
    const { tags } = options;
    const stamping =
      taken ?? (tags === undefined ? undefined : await this.tags.stampFor(target, tags, value));
    if (stamping === 'skip') return;
    await this.write(target, ref, key, value, plan.strategy, plan.ttl, stamping);
  }

  /**
   * `store` for loaded batch values, written with one `writeMany`; it never deletes. `taken` is
   * as for `store`; without it, the entries to write are stamped together (one token call).
   */
  async storeMany<T>(
    target: Target,
    items: readonly (BatchItem & { value: T })[],
    options: BatchPutOptions<T>,
    strategy: ExpiryStrategy,
    taken?: Stamping,
  ): Promise<void> {
    const planned: (WriteItem & { value: T })[] = [];
    for (const item of items) {
      const plan = writePlan(this.envelope, target, item.value, options, strategy);
      if (typeof plan === 'object') planned.push({ ...item, ...plan });
    }
    let writes: readonly WriteItem[];
    if (taken === undefined) {
      writes = await this.tags.stampWrites(target, options.tags, planned);
    } else {
      writes = taken === 'skip' ? [] : planned.map((write) => ({ ...write, tags: taken }));
    }
    await this.writeMany(target, writes);
  }

  /**
   * `ttl` is an integer >= 1, already jittered when the strategy asks for it. `tags` is the
   * entry's stamp, written as the envelope's `tags` unless absent or empty.
   */
  async write(
    { name, store }: Target,
    ref: KeyRef,
    { full: key }: ResolvedKey,
    value: unknown,
    strategy: ExpiryStrategy,
    ttl: number,
    tags?: TagStamp,
  ): Promise<void> {
    let storeTtl: number;
    try {
      const wrapped = strategy.wrap(value, Date.now(), ttl);
      storeTtl = wrapped.storeTtl;
      const envelope = stamped(wrapped.envelope, tags);
      await store.set(key, this.options.serializer.serialize(envelope), storeTtl);
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
    for (const { ref, key, value, strategy, ttl, tags } of items) {
      try {
        const wrapped = strategy.wrap(value, Date.now(), ttl);
        const serialized = this.options.serializer.serialize(stamped(wrapped.envelope, tags));
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
      const versioned = await this.resolver.deleteNamespaces(target, namespace);
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
