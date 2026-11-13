import type { LoadStrategyOptions } from '../decorators/options.js';
import { CacheConfigError } from '../errors.js';
import type { ResolvedCacheOptions } from '../module/cache.options.js';
import { CacheTracing } from '../observability/cache-tracing.js';
import { MemoryStore } from '../stores/memory.store.js';
import {
  EMPTY_STRATEGY,
  EngineIO,
  isEmpty,
  servable,
  uncertain,
  type BatchPutOptions,
  type KeyRef,
  type PutOptions,
  type Target,
} from './engine-io.js';
import { EngineBatch, type BatchLoader, type BatchScope } from './engine-batch.js';
import { EngineLoad, settleWithin } from './engine-load.js';
import {
  normalizeTags,
  type BatchTagOption,
  type Stamping,
  type TagOption,
} from './engine-tags.js';
import { isReservedNamespace, keyErrorOf } from './key-builder.js';
import type { CacheEvents, CacheLogLevel, CacheOperation } from './events.js';
import { NamespaceVersions } from './namespace-versions.js';
import { createStrategy, type ExpiryStrategy } from './strategies/expiry-strategy.js';
import { MAX_TAG_TOKENS, tokenKeyPrefixes, VersionTokens } from './version-tokens.js';

export type { BatchPutOptions, KeyRef, PutOptions } from './engine-io.js';
export type { BatchLoader, BatchScope } from './engine-batch.js';

/** `lock` overrides `defaults.lock.enabled`; it has no effect on a store without `lock`. */
export type LoadOptions<T> = PutOptions<T> & { lock?: boolean };

/** `getOrSetMany` options: batch tags (D2); `lock: true` is rejected. */
export type BatchLoadOptions<T> = BatchPutOptions<T> & { lock?: boolean };

export type SetOptions<T = unknown> = { ttl?: number; tags?: TagOption<T> } & LoadStrategyOptions;

/** `setMany` options: a tag function also gets each entry's key (D2). */
export type BatchSetOptions<T = unknown> = {
  ttl?: number;
  tags?: BatchTagOption<T>;
} & LoadStrategyOptions;

function checkDuration(option: string, value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new CacheConfigError(
      `Invalid ${option}: ${String(value)}. Durations are milliseconds, finite numbers greater than 0.`,
    );
  }
}

function checkKeys(keys: unknown): void {
  if (Array.isArray(keys)) return;
  throw new CacheConfigError(`Invalid keys: ${String(keys)}. It must be an array of strings.`);
}

function checkEntries(entries: unknown): void {
  if (Array.isArray(entries)) return;
  throw new CacheConfigError(
    `Invalid entries: ${String(entries)}. It must be an array of [key, value] pairs.`,
  );
}

/** The tags of an `invalidateTags` call (spec 4): a non-empty list of valid tags. */
function tagsToInvalidate(tags: unknown): string[] {
  let names: string[];
  try {
    names = normalizeTags(tags);
  } catch (error) {
    throw new CacheConfigError(error instanceof Error ? error.message : String(error));
  }
  if (names.length === 0) {
    throw new CacheConfigError('Invalid tags: []. invalidateTags requires at least one tag.');
  }
  return names;
}

/**
 * The store and namespace of a traced call's span. Read without a throw, so a `ref` or `scope`
 * that is not an object makes the call reject inside its span, as it rejects untraced.
 */
function traceBase(ref: { store?: string; namespace?: string }): {
  store: string;
  namespace?: string;
} {
  const given = ref as { store?: string; namespace?: string } | null | undefined;
  if (typeof given !== 'object' || given === null) return { store: 'default' };
  return { store: given.store ?? 'default', namespace: given.namespace };
}

function checkBoolean(option: string, value: boolean | undefined): void {
  if (value === undefined || typeof value === 'boolean') return;
  throw new CacheConfigError(`Invalid ${option}: ${String(value)}. It must be a boolean.`);
}

/**
 * Validates the strategy options and builds the strategy. `ttl` is the effective ttl the
 * entry is written with; it is omitted by `get`, which writes nothing. `preset` is a strategy
 * already built from these same options; every check still runs, in the same order.
 * `noSoftTimeout` names a call that does not load (`get`, `set`, ...): any defined
 * `softTimeout` is then rejected. On a load call, `softTimeout` needs the `swr` strategy: only a
 * stale `swr` hit waits for its refresh.
 */
function strategyOf(
  options: LoadStrategyOptions,
  ttl: number | undefined,
  preset?: ExpiryStrategy,
  noSoftTimeout?: string,
): ExpiryStrategy {
  const { staleTtl, maxTtl } = options;
  if (noSoftTimeout !== undefined && options.softTimeout !== undefined) {
    throw new CacheConfigError(
      `Invalid softTimeout: ${String(options.softTimeout)}. ${noSoftTimeout} does not support softTimeout; only getOrSet and getOrSetMany do.`,
    );
  }
  checkDuration('staleTtl', staleTtl);
  checkDuration('maxTtl', maxTtl);
  checkDuration('softTimeout', options.softTimeout);
  const strategy = preset ?? createStrategy(options);
  if (options.softTimeout !== undefined && strategy.kind !== 'swr') {
    throw new CacheConfigError(
      `Invalid softTimeout: ${String(options.softTimeout)}. softTimeout needs the 'swr' strategy, but the strategy is '${strategy.kind}'.`,
    );
  }
  if (strategy.kind === 'swr' && staleTtl === undefined) {
    throw new CacheConfigError(
      "Invalid staleTtl: undefined. The 'swr' strategy requires staleTtl.",
    );
  }
  if (ttl !== undefined && maxTtl !== undefined && maxTtl < ttl) {
    throw new CacheConfigError(
      `Invalid maxTtl: ${String(maxTtl)}. It must be >= ttl (${String(ttl)}).`,
    );
  }
  return strategy;
}

/** Public facade: validates each call, then delegates to the store I/O and load orchestration. */
export class CacheEngine {
  private readonly io: EngineIO;
  private readonly load: EngineLoad;
  private readonly batch: EngineBatch;

  /** The module's `logging.level`. */
  readonly logLevel: CacheLogLevel;

  /** The module's `escapeKeyArgs`; decorators pass it to template key rendering at call time. */
  readonly escapeKeyArgs: boolean;

  /** Internal: the version tokens of namespaces and tags, one set per engine. */
  readonly tokens: VersionTokens;

  /**
   * @param tracing Internal: the module's tracing; until a tracer is registered with it, every
   * call runs untraced, as before 0.10.
   */
  constructor(
    private readonly options: ResolvedCacheOptions,
    events: CacheEvents,
    private readonly tracing: CacheTracing = new CacheTracing(),
  ) {
    this.logLevel = options.logging.level;
    this.escapeKeyArgs = options.escapeKeyArgs;
    // One token store for namespaces and tags; the facade serves the namespace calls.
    // A failed background touch is reported through `io`, built below: read it at call time.
    const tokens = new VersionTokens(
      options.prefix,
      options.versionCacheTtl,
      MAX_TAG_TOKENS,
      (store, error) => {
        this.io.reportError(store, 'touch', error);
      },
    );
    this.tokens = tokens;
    const versions = new NamespaceVersions(
      options.prefix,
      options.versionedNamespaces,
      options.versionCacheTtl,
      tokens,
    );
    // A memory store keeps the tokens apart from its data LRU, so data writes never evict them
    // (an evicted token is re-created and empties its namespace or tag). A tiered L1 is not
    // told: a token it drops is read again from L2.
    const reserved = tokenKeyPrefixes(options.prefix);
    for (const store of options.stores.values()) {
      if (store instanceof MemoryStore) store.reserveKeyPrefixes(reserved);
    }
    this.io = new EngineIO(options, events, versions, tokens, tracing);
    this.load = new EngineLoad(this.io, options.defaults, tracing);
    this.batch = new EngineBatch(options, this.io, this.load, tracing);
  }

  hasStore(name: string): boolean {
    return this.options.stores.has(name);
  }

  /** True when the store is configured and can lock; never throws for an unknown name. */
  hasLock(name: string): boolean {
    return this.options.stores.get(name)?.lock !== undefined;
  }

  storeNames(): string[] {
    return [...this.options.stores.keys()];
  }

  /** Never refreshes; `options` selects the read command and the classification only. */
  get<T>(ref: KeyRef, options?: LoadStrategyOptions): Promise<T | undefined> {
    if (!this.tracing.enabled) return this.getImpl<T>(ref, options);
    return this.tracing.span('cache.get', traceBase(ref), () => this.getImpl<T>(ref, options));
  }

  private async getImpl<T>(ref: KeyRef, options: LoadStrategyOptions = {}): Promise<T | undefined> {
    const target = this.io.resolve(ref.store);
    this.checkNamespace(ref.namespace);
    const strategy = strategyOf(options, undefined, undefined, 'get');
    if (this.invalidKey(target, ref.namespace, ref.key)) {
      this.tracing.result('bypass');
      return undefined;
    }
    const pending = this.io.resolveKey(target, ref);
    const key = pending instanceof Promise ? await pending : pending;
    // A version failure is already reported; like a key error, it is no miss.
    if (key === undefined) {
      this.tracing.result('bypass');
      return undefined;
    }
    this.tracing.key(key.full);
    const result = await this.io.read(target, key, strategy, this.options.defaults.ttl);
    if (!result.found) {
      this.io.miss(target.name, ref);
      return undefined;
    }
    this.io.hit(target.name, ref, result.stale);
    return result.value as T | undefined;
  }

  /**
   * @param preset Internal: the strategy built from `options` at decoration time, so a
   * decorated call does not rebuild it. It must come from `createStrategy(options)`.
   */
  getOrSet<T>(
    ref: KeyRef,
    loader: () => Promise<T>,
    options?: LoadOptions<T>,
    preset?: ExpiryStrategy,
  ): Promise<T> {
    if (!this.tracing.enabled) return this.getOrSetImpl(ref, loader, options, preset);
    return this.tracing.span('cache.getOrSet', traceBase(ref), () =>
      this.getOrSetImpl(ref, loader, options, preset),
    );
  }

  private async getOrSetImpl<T>(
    ref: KeyRef,
    loader: () => Promise<T>,
    options: LoadOptions<T> = {},
    preset?: ExpiryStrategy,
  ): Promise<T> {
    const target = this.io.resolve(ref.store);
    this.checkNamespace(ref.namespace);
    checkDuration('ttl', options.ttl);
    checkDuration('nullTtl', options.nullTtl);
    checkBoolean('cacheNull', options.cacheNull);
    checkBoolean('lock', options.lock);
    const ttl = options.ttl ?? this.options.defaults.ttl;
    const strategy = strategyOf(options, ttl, preset);
    if (this.invalidKey(target, ref.namespace, ref.key)) return this.bypass(loader);
    // Awaited only for a versioned namespace: the swr refresh below must register its flight
    // without an added tick, as in 0.3.
    const pending = this.io.resolveKey(target, ref);
    const key = pending instanceof Promise ? await pending : pending;
    if (key === undefined) return this.bypass(loader);
    this.tracing.key(key.full);
    const cached = await this.io.read(target, key, strategy, ttl);
    // An entry whose tags could not be checked is loaded without a write (spec 3.2 step 4), and
    // without the lock: nothing would be written for other instances to wait for.
    const noWrite = uncertain(cached);
    const locking = !noWrite && (options.lock ?? this.options.defaults.lock.enabled);
    const lock = locking ? target.store.lock : undefined;
    const plan = { target, ref, key, loader, options, strategy, ttl, lock, noWrite };
    if (servable(cached, strategy)) {
      this.io.hit(target.name, ref, cached.stale);
      if (!cached.stale) return cached.value as T;
      // A refresh already in flight is joined, even one that started before this stale entry
      // was written: its result is what the store will hold, so it is the value to wait for.
      const refreshing = this.load.refresh(plan);
      // Without softTimeout nothing is awaited here, as in 0.7.
      const { softTimeout } = options;
      if (softTimeout === undefined) return cached.value as T;
      const refreshed = await settleWithin(refreshing, softTimeout);
      return refreshed === undefined ? (cached.value as T) : refreshed.value;
    }
    this.io.miss(target.name, ref);
    return this.load.onMiss(plan);
  }

  /** With `tags`, the entry is stamped with their tokens; an invalid list skips the write. */
  set<T>(ref: KeyRef, value: T, options?: SetOptions<T>): Promise<void> {
    if (!this.tracing.enabled) return this.setImpl(ref, value, options);
    return this.tracing.span('cache.set', traceBase(ref), () => this.setImpl(ref, value, options));
  }

  private async setImpl<T>(ref: KeyRef, value: T, options: SetOptions<T> = {}): Promise<void> {
    const target = this.io.resolve(ref.store);
    this.checkNamespace(ref.namespace);
    checkDuration('ttl', options.ttl);
    const ttl = options.ttl ?? this.options.defaults.ttl;
    const requested = strategyOf(options, ttl, undefined, 'set');
    if (this.invalidKey(target, ref.namespace, ref.key)) {
      this.tracing.set('cache.written', false);
      return;
    }
    const pending = this.io.resolveKey(target, ref);
    const key = pending instanceof Promise ? await pending : pending;
    // A version failure is already reported; nothing is written.
    if (key === undefined) {
      this.tracing.set('cache.written', false);
      return;
    }
    this.tracing.key(key.full);
    // `set` has no cacheNull/nullTtl: an empty value keeps the 0.1 ttl, but always as `fixed`.
    const strategy = isEmpty(value) ? EMPTY_STRATEGY : requested;
    const { tags } = options;
    const stamping =
      tags === undefined ? undefined : await this.io.tags.stampFor(target, tags, value);
    if (stamping === 'skip') {
      this.tracing.set('cache.written', false);
      return;
    }
    const written = await this.io.write(
      target,
      ref,
      key,
      value,
      strategy,
      this.io.ttlFor(strategy, ttl),
      stamping,
    );
    this.tracing.set('cache.written', written);
  }

  /**
   * @param preset Internal: as for `getOrSet`.
   * @param taken Internal: the stamp `takeTags` gave before the value was produced (T4-B); the
   * write uses exactly those tokens and `options.tags` is not stamped again.
   */
  put<T>(
    ref: KeyRef,
    value: T,
    options?: PutOptions<T>,
    preset?: ExpiryStrategy,
    taken?: Stamping,
  ): Promise<void> {
    if (!this.tracing.enabled) return this.putImpl(ref, value, options, preset, taken);
    return this.tracing.span('cache.put', traceBase(ref), () =>
      this.putImpl(ref, value, options, preset, taken),
    );
  }

  private async putImpl<T>(
    ref: KeyRef,
    value: T,
    options: PutOptions<T> = {},
    preset?: ExpiryStrategy,
    taken?: Stamping,
  ): Promise<void> {
    const target = this.io.resolve(ref.store);
    this.checkNamespace(ref.namespace);
    checkDuration('ttl', options.ttl);
    checkDuration('nullTtl', options.nullTtl);
    checkBoolean('cacheNull', options.cacheNull);
    const strategy = strategyOf(options, options.ttl ?? this.options.defaults.ttl, preset);
    if (this.invalidKey(target, ref.namespace, ref.key)) {
      this.tracing.set('cache.written', false);
      return;
    }
    const pending = this.io.resolveKey(target, ref);
    const key = pending instanceof Promise ? await pending : pending;
    // A version failure is already reported; nothing is written.
    if (key === undefined) {
      this.tracing.set('cache.written', false);
      return;
    }
    this.tracing.key(key.full);
    const written = await this.io.store(target, ref, key, value, options, strategy, true, taken);
    this.tracing.set('cache.written', written);
  }

  /**
   * Internal: takes the tokens of tags known before a value is produced (spec 3.3), for a later
   * `put`, so an invalidation in between leaves that write stale. An invalid list is one `tag`
   * error, a failed token write one `version` error; either gives `'skip'` and never rejects.
   */
  takeTags(storeName: string | undefined, tags: readonly string[]): Promise<Stamping> {
    const target = this.io.resolve(storeName);
    return this.io.tags.stamp(target, () => tags);
  }

  /**
   * `get` for several keys of one namespace: one store read for the batch (per key under
   * `sliding`), results in input order. A duplicate is read once; an empty or reserved key is
   * `undefined`.
   */
  getMany<T>(
    scope: BatchScope,
    keys: readonly string[],
    options?: LoadStrategyOptions,
  ): Promise<(T | undefined)[]> {
    if (!this.tracing.enabled) return this.getManyImpl<T>(scope, keys, options);
    return this.tracing.span(
      'cache.getMany',
      traceBase(scope),
      () => this.getManyImpl<T>(scope, keys, options),
      'batch',
    );
  }

  private async getManyImpl<T>(
    scope: BatchScope,
    keys: readonly string[],
    options: LoadStrategyOptions = {},
  ): Promise<(T | undefined)[]> {
    const target = this.io.resolve(scope.store);
    this.checkNamespace(scope.namespace);
    const strategy = strategyOf(options, undefined, undefined, 'getMany');
    checkKeys(keys);
    this.tracing.set('cache.keys', keys.length);
    return this.batch.getMany(target, scope, keys, strategy);
  }

  /**
   * `set` for several entries, written with one store call. A repeated key is written once,
   * with its last value; empty or reserved keys are dropped and reported once as a key error.
   */
  setMany<T>(
    scope: BatchScope,
    entries: readonly (readonly [key: string, value: NoInfer<T>])[],
    options?: BatchSetOptions<T>,
  ): Promise<void> {
    if (!this.tracing.enabled) return this.setManyImpl<T>(scope, entries, options);
    // Not a `'batch'` scope: a write has no hits or misses to count.
    return this.tracing.span('cache.setMany', traceBase(scope), () =>
      this.setManyImpl<T>(scope, entries, options),
    );
  }

  private async setManyImpl<T>(
    scope: BatchScope,
    entries: readonly (readonly [key: string, value: T])[],
    options: BatchSetOptions<T> = {},
  ): Promise<void> {
    const target = this.io.resolve(scope.store);
    this.checkNamespace(scope.namespace);
    checkDuration('ttl', options.ttl);
    const ttl = options.ttl ?? this.options.defaults.ttl;
    const requested = strategyOf(options, ttl, undefined, 'setMany');
    checkEntries(entries);
    this.tracing.set('cache.keys', entries.length);
    await this.batch.setMany(target, scope, entries, requested, ttl, options.tags);
  }

  /**
   * `getOrSet` for several keys of one namespace. Hits (stale `swr` ones too) are served; the
   * misses go to one `loader(missing)` call, except those another call is loading, which are
   * awaited. A key the loader omits counts as `undefined`; keys it was not asked for are
   * ignored. Stale `swr` keys are refreshed in the background with one more loader call.
   * Results are in input order, duplicates included; an empty or reserved key is
   * `undefined`. Never locks.
   */
  getOrSetMany<T>(
    scope: BatchScope,
    keys: readonly string[],
    loader: BatchLoader<T>,
    options?: BatchLoadOptions<T>,
  ): Promise<(T | undefined)[]> {
    if (!this.tracing.enabled) return this.getOrSetManyImpl(scope, keys, loader, options);
    return this.tracing.span(
      'cache.getOrSetMany',
      traceBase(scope),
      () => this.getOrSetManyImpl(scope, keys, loader, options),
      'batch',
    );
  }

  private async getOrSetManyImpl<T>(
    scope: BatchScope,
    keys: readonly string[],
    loader: BatchLoader<T>,
    options: BatchLoadOptions<T> = {},
  ): Promise<(T | undefined)[]> {
    const target = this.io.resolve(scope.store);
    this.checkNamespace(scope.namespace);
    if (options.lock === true) {
      throw new CacheConfigError('Invalid lock: true. getOrSetMany does not support lock.');
    }
    checkDuration('ttl', options.ttl);
    checkDuration('nullTtl', options.nullTtl);
    checkBoolean('cacheNull', options.cacheNull);
    const ttl = options.ttl ?? this.options.defaults.ttl;
    const strategy = strategyOf(options, ttl);
    checkKeys(keys);
    this.tracing.set('cache.keys', keys.length);
    return this.batch.getOrSetMany(target, scope, keys, loader, options, strategy, ttl);
  }

  /** Empty keys are dropped and reported once as a key error; every other key is deleted. */
  delete(scope: { store?: string; namespace?: string }, keys: readonly string[]): Promise<void> {
    if (!this.tracing.enabled) return this.deleteImpl(scope, keys);
    return this.tracing.span('cache.delete', traceBase(scope), () => this.deleteImpl(scope, keys));
  }

  private async deleteImpl(
    scope: { store?: string; namespace?: string },
    keys: readonly string[],
  ): Promise<void> {
    const target = this.io.resolve(scope.store);
    this.checkNamespace(scope.namespace);
    let invalid: TypeError | undefined;
    const valid = keys.filter((key) => {
      const error = keyErrorOf(scope.namespace, key);
      if (error === undefined) return true;
      invalid ??= error;
      return false;
    });
    this.tracing.set('cache.keys', valid.length);
    if (invalid !== undefined) this.io.reportError(target.name, 'key', invalid);
    await this.io.delete(scope, valid, true);
  }

  clear(namespace: string, storeName?: string): Promise<void> {
    if (!this.tracing.enabled) return this.clearImpl(namespace, storeName);
    const base = {
      store: storeName ?? 'default',
      namespace: typeof namespace === 'string' && namespace !== '' ? namespace : undefined,
    };
    return this.tracing.span('cache.clear', base, () => this.clearImpl(namespace, storeName));
  }

  private async clearImpl(namespace: string, storeName?: string): Promise<void> {
    // With a prefix, '' would wipe every namespace; without one it would clear nothing.
    if (typeof namespace !== 'string' || namespace === '') {
      throw new CacheConfigError('clear requires a non-empty namespace');
    }
    this.io.resolve(storeName);
    this.checkNamespace(namespace);
    await this.io.clear(storeName, namespace);
  }

  /**
   * Gives each tag a new version in the store (spec 3.4), so every entry stamped with one of them
   * becomes a miss; this instance sees it at once, others once their cached token expires. Rejects
   * `CacheConfigError` for an invalid list (empty, an empty or non-string tag, more than 32 after
   * de-duplication) or an unknown store. A failed token write is one `version` error, and the
   * call rejects with the first failing tag's error once every tag was tried.
   */
  invalidateTags(tags: readonly string[], storeName?: string): Promise<void> {
    if (!this.tracing.enabled) return this.invalidateTagsImpl(tags, storeName);
    return this.tracing.span('cache.invalidateTags', { store: storeName ?? 'default' }, () =>
      this.invalidateTagsImpl(tags, storeName),
    );
  }

  private async invalidateTagsImpl(tags: readonly string[], storeName?: string): Promise<void> {
    const names = tagsToInvalidate(tags);
    this.tracing.set('cache.tags', names.length);
    this.tracing.key(names);
    const target = this.io.resolve(storeName);
    await this.io.tags.invalidate(target, names);
  }

  reportError(store: string | undefined, operation: CacheOperation, error: unknown): void {
    this.io.reportError(store, operation, error);
  }

  /** Names starting with `__` are reserved for internal keys (the lock keys). */
  private checkNamespace(namespace: string | undefined): void {
    if (namespace !== undefined && isReservedNamespace(namespace)) {
      throw new CacheConfigError(
        `Invalid namespace: ${namespace}. Names starting with "__" are reserved.`,
      );
    }
  }

  /** A `getOrSet` that skips the cache: `cache.result = 'bypass'`, the loader in `cache.load`. */
  private bypass<T>(loader: () => Promise<T>): Promise<T> {
    this.tracing.result('bypass');
    return this.tracing.child('cache.load', loader);
  }

  /** Reports an empty or reserved key as a key error; the caller then skips the cache. */
  private invalidKey(target: Target, namespace: string | undefined, key: string): boolean {
    const error = keyErrorOf(namespace, key);
    if (error === undefined) return false;
    this.io.reportError(target.name, 'key', error);
    return true;
  }
}
