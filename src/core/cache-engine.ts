import type { StrategyOptions } from '../decorators/options.js';
import { CacheConfigError } from '../errors.js';
import type { ResolvedCacheOptions } from '../module/cache.options.js';
import {
  EMPTY_STRATEGY,
  EngineIO,
  isEmpty,
  servable,
  type BatchItem,
  type KeyRef,
  type PutOptions,
  type Target,
} from './engine-io.js';
import { EngineLoad, type BatchPlan } from './engine-load.js';
import { emptyKeyError, isEmptyKey, isReservedNamespace } from './key-builder.js';
import type { CacheEvents, CacheLogLevel, CacheOperation } from './events.js';
import { NamespaceVersions } from './namespace-versions.js';
import { createStrategy, type ExpiryStrategy } from './strategies/expiry-strategy.js';

export type { KeyRef, PutOptions } from './engine-io.js';

/** `lock` overrides `defaults.lock.enabled`; it has no effect on a store without `lock`. */
export type LoadOptions<T> = PutOptions<T> & { lock?: boolean };

export type SetOptions = { ttl?: number } & StrategyOptions;

/** The store and namespace a batch call works in. */
export interface BatchScope {
  store?: string;
  namespace?: string;
}

export type BatchLoader<T> = (missing: string[]) => Promise<ReadonlyMap<string, T>>;

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

function checkBoolean(option: string, value: boolean | undefined): void {
  if (value === undefined || typeof value === 'boolean') return;
  throw new CacheConfigError(`Invalid ${option}: ${String(value)}. It must be a boolean.`);
}

/**
 * Validates the strategy options and builds the strategy. `ttl` is the effective ttl the
 * entry is written with; it is omitted by `get`, which writes nothing. `preset` is a strategy
 * already built from these same options; every check still runs, in the same order.
 */
function strategyOf(
  options: StrategyOptions,
  ttl: number | undefined,
  preset?: ExpiryStrategy,
): ExpiryStrategy {
  const { staleTtl, maxTtl } = options;
  checkDuration('staleTtl', staleTtl);
  checkDuration('maxTtl', maxTtl);
  const strategy = preset ?? createStrategy(options);
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

  /** The module's `logging.level`. */
  readonly logLevel: CacheLogLevel;

  /** The module's `escapeKeyArgs`; decorators pass it to template key rendering at call time. */
  readonly escapeKeyArgs: boolean;

  constructor(
    private readonly options: ResolvedCacheOptions,
    events: CacheEvents,
  ) {
    this.logLevel = options.logging.level;
    this.escapeKeyArgs = options.escapeKeyArgs;
    const versions = new NamespaceVersions(
      options.prefix,
      options.versionedNamespaces,
      options.versionCacheTtl,
    );
    this.io = new EngineIO(options, events, versions);
    this.load = new EngineLoad(this.io, options.defaults.lock);
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
  async get<T>(ref: KeyRef, options: StrategyOptions = {}): Promise<T | undefined> {
    const target = this.io.resolve(ref.store);
    this.checkNamespace(ref.namespace);
    const strategy = strategyOf(options, undefined);
    if (this.emptyKey(target, ref.key)) return undefined;
    const pending = this.io.resolveKey(target, ref);
    const key = pending instanceof Promise ? await pending : pending;
    // A version failure is already reported; like a key error, it is no miss.
    if (key === undefined) return undefined;
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
  async getOrSet<T>(
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
    const ttl = options.ttl ?? this.options.defaults.ttl;
    const strategy = strategyOf(options, ttl, preset);
    if (this.emptyKey(target, ref.key)) return loader();
    // Awaited only for a versioned namespace: the swr refresh below must register its flight
    // without an added tick, as in 0.3.
    const pending = this.io.resolveKey(target, ref);
    const key = pending instanceof Promise ? await pending : pending;
    if (key === undefined) return loader();
    const cached = await this.io.read(target, key, strategy, ttl);
    const locking = options.lock ?? this.options.defaults.lock.enabled;
    const lock = locking ? target.store.lock : undefined;
    const plan = { target, ref, key, loader, options, strategy, ttl, lock };
    if (servable(cached, strategy)) {
      this.io.hit(target.name, ref, cached.stale);
      if (cached.stale) this.load.refresh(plan);
      return cached.value as T;
    }
    this.io.miss(target.name, ref);
    return this.load.onMiss(plan);
  }

  async set(ref: KeyRef, value: unknown, options: SetOptions = {}): Promise<void> {
    const target = this.io.resolve(ref.store);
    this.checkNamespace(ref.namespace);
    checkDuration('ttl', options.ttl);
    const ttl = options.ttl ?? this.options.defaults.ttl;
    const requested = strategyOf(options, ttl);
    if (this.emptyKey(target, ref.key)) return;
    const pending = this.io.resolveKey(target, ref);
    const key = pending instanceof Promise ? await pending : pending;
    if (key === undefined) return;
    // `set` has no cacheNull/nullTtl: an empty value keeps the 0.1 ttl, but always as `fixed`.
    const strategy = isEmpty(value) ? EMPTY_STRATEGY : requested;
    await this.io.write(target, ref, key, value, strategy, this.io.ttlFor(strategy, ttl));
  }

  /** @param preset Internal: as for `getOrSet`. */
  async put<T>(
    ref: KeyRef,
    value: T,
    options: PutOptions<T> = {},
    preset?: ExpiryStrategy,
  ): Promise<void> {
    const target = this.io.resolve(ref.store);
    this.checkNamespace(ref.namespace);
    checkDuration('ttl', options.ttl);
    checkDuration('nullTtl', options.nullTtl);
    checkBoolean('cacheNull', options.cacheNull);
    const strategy = strategyOf(options, options.ttl ?? this.options.defaults.ttl, preset);
    if (this.emptyKey(target, ref.key)) return;
    const pending = this.io.resolveKey(target, ref);
    const key = pending instanceof Promise ? await pending : pending;
    if (key === undefined) return;
    await this.io.store(target, ref, key, value, options, strategy, true);
  }

  /**
   * `get` for several keys of one namespace: one store read for the batch (per key under
   * `sliding`), results in input order. A duplicate is read once; an empty key is `undefined`.
   */
  async getMany<T>(
    scope: BatchScope,
    keys: readonly string[],
    options: StrategyOptions = {},
  ): Promise<(T | undefined)[]> {
    const target = this.io.resolve(scope.store);
    this.checkNamespace(scope.namespace);
    const strategy = strategyOf(options, undefined);
    checkKeys(keys);
    const items = await this.batchItems(target, scope, this.uniqueKeys(target, keys));
    if (items === undefined) return keys.map(() => undefined);
    const lookups = await this.io.readMany(
      target,
      items.map((item) => item.key),
      strategy,
      this.options.defaults.ttl,
    );
    const values = new Map<string, unknown>();
    items.forEach(({ ref }, i) => {
      const lookup = lookups[i];
      if (lookup?.found !== true) {
        this.io.miss(target.name, ref);
        return;
      }
      this.io.hit(target.name, ref, lookup.stale);
      values.set(ref.key, lookup.value);
    });
    return keys.map((key) => values.get(key) as T | undefined);
  }

  /**
   * `set` for several entries, written with one store call. A repeated key is written once,
   * with its last value; empty keys are dropped and reported once as a key error.
   */
  async setMany(
    scope: BatchScope,
    entries: readonly (readonly [key: string, value: unknown])[],
    options: SetOptions = {},
  ): Promise<void> {
    const target = this.io.resolve(scope.store);
    this.checkNamespace(scope.namespace);
    checkDuration('ttl', options.ttl);
    const ttl = options.ttl ?? this.options.defaults.ttl;
    const requested = strategyOf(options, ttl);
    checkEntries(entries);
    const values = new Map<string, unknown>();
    for (const [key, value] of entries) values.set(key, value);
    const items = await this.batchItems(target, scope, this.uniqueKeys(target, [...values.keys()]));
    if (items === undefined) return;
    await this.io.writeMany(
      target,
      items.map((item) => {
        const value = values.get(item.ref.key);
        // As `set`: an empty value keeps the 0.1 ttl, but always as `fixed`.
        const strategy = isEmpty(value) ? EMPTY_STRATEGY : requested;
        return { ...item, value, strategy, ttl: this.io.ttlFor(strategy, ttl) };
      }),
    );
  }

  /**
   * `getOrSet` for several keys of one namespace. Hits (stale `swr` ones too) are served; the
   * misses go to one `loader(missing)` call, except those another call is loading, which are
   * awaited. A key the loader omits counts as `undefined`; keys it was not asked for are
   * ignored. Stale `swr` keys are refreshed in the background with one more loader call.
   * Results are in input order, duplicates included; an empty key is `undefined`. Never locks.
   */
  async getOrSetMany<T>(
    scope: BatchScope,
    keys: readonly string[],
    loader: BatchLoader<T>,
    options: LoadOptions<T> = {},
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
    const unique = this.uniqueKeys(target, keys);
    const plan: BatchPlan<T> = { target, namespace: scope.namespace, loader, options, strategy };
    const items = await this.batchItems(target, scope, unique);
    const values = new Map<string, unknown>();
    if (items === undefined) {
      // A version failure skips the cache: every key is loaded and nothing is written.
      const loaded = await this.load.runLoader(plan, unique, false);
      for (const key of unique) values.set(key, loaded.get(key));
      return keys.map((key) => values.get(key) as T | undefined);
    }
    const lookups = await this.io.readMany(
      target,
      items.map((item) => item.key),
      strategy,
      ttl,
    );
    const missing: BatchItem[] = [];
    const stale: BatchItem[] = [];
    items.forEach((item, i) => {
      const lookup = lookups[i] ?? { found: false };
      if (!servable(lookup, strategy)) {
        this.io.miss(target.name, item.ref);
        missing.push(item);
        return;
      }
      this.io.hit(target.name, item.ref, lookup.stale);
      values.set(item.ref.key, lookup.value);
      if (lookup.stale) stale.push(item);
    });
    // Both start before anything is awaited, so their flights are registered at once.
    const loading = missing.length > 0 ? this.load.onMissMany(plan, missing) : undefined;
    if (stale.length > 0) this.load.refreshMany(plan, stale);
    if (loading !== undefined) {
      for (const [key, value] of await loading) values.set(key, value);
    }
    return keys.map((key) => values.get(key) as T | undefined);
  }

  /** Empty keys are dropped and reported once as a key error; every other key is deleted. */
  async delete(
    scope: { store?: string; namespace?: string },
    keys: readonly string[],
  ): Promise<void> {
    const target = this.io.resolve(scope.store);
    this.checkNamespace(scope.namespace);
    const valid = keys.filter((key) => !isEmptyKey(key));
    if (valid.length < keys.length) this.io.reportError(target.name, 'key', emptyKeyError());
    await this.io.delete(scope, valid);
  }

  async clear(namespace: string, storeName?: string): Promise<void> {
    // With a prefix, '' would wipe every namespace; without one it would clear nothing.
    if (typeof namespace !== 'string' || namespace === '') {
      throw new CacheConfigError('clear requires a non-empty namespace');
    }
    this.io.resolve(storeName);
    this.checkNamespace(namespace);
    await this.io.clear(storeName, namespace);
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

  /** `keys` deduped, first occurrence first, without empty keys (reported once as a key error). */
  private uniqueKeys(target: Target, keys: readonly string[]): string[] {
    const unique = new Set<string>();
    let empty = false;
    for (const key of keys) {
      if (isEmptyKey(key)) empty = true;
      else unique.add(key);
    }
    if (empty) this.io.reportError(target.name, 'key', emptyKeyError());
    return [...unique];
  }

  /**
   * The batch items of `keys` (unique, non-empty) in `scope`, with one version read for a
   * versioned namespace; `undefined` after a version failure (already reported).
   */
  private async batchItems(
    target: Target,
    scope: BatchScope,
    keys: readonly string[],
  ): Promise<BatchItem[] | undefined> {
    if (keys.length === 0) return [];
    const pending = this.io.resolveKeys(target, scope.namespace, keys);
    const resolved = pending instanceof Promise ? await pending : pending;
    if (resolved === undefined) return undefined;
    const items: BatchItem[] = [];
    keys.forEach((key, i) => {
      const resolvedKey = resolved[i];
      if (resolvedKey !== undefined) items.push({ ref: { ...scope, key }, key: resolvedKey });
    });
    return items;
  }

  /** Reports an empty key as a key error; the caller then skips the cache. */
  private emptyKey(target: Target, key: string): boolean {
    if (!isEmptyKey(key)) return false;
    this.io.reportError(target.name, 'key', emptyKeyError());
    return true;
  }
}
