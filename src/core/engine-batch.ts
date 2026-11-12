import type { ResolvedCacheOptions } from '../module/cache.options.js';
import type { CacheTracing } from '../observability/cache-tracing.js';
import {
  EMPTY_STRATEGY,
  isEmpty,
  servable,
  uncertain,
  type BatchPutOptions,
} from './engine-envelope.js';
import type { BatchItem, EngineIO } from './engine-io.js';
import type { Target } from './engine-keys.js';
import type { BatchTagOption } from './engine-tags.js';
import type { BatchPlan, EngineLoad, LoadItem } from './engine-load.js';
import { keyErrorOf } from './key-builder.js';
import type { ExpiryStrategy } from './strategies/expiry-strategy.js';

/** The store and namespace a batch call works in. */
export interface BatchScope {
  store?: string;
  namespace?: string;
}

export type BatchLoader<T> = (missing: string[]) => Promise<ReadonlyMap<string, T>>;

/**
 * The batch calls of the engine (`getMany`, `setMany`, `getOrSetMany`), run after the facade
 * has validated their arguments and built their strategy.
 */
export class EngineBatch {
  constructor(
    private readonly options: ResolvedCacheOptions,
    private readonly io: EngineIO,
    private readonly load: EngineLoad,
    private readonly tracing: CacheTracing,
  ) {}

  /** `CacheEngine.getMany` after validation. */
  async getMany<T>(
    target: Target,
    scope: BatchScope,
    keys: readonly string[],
    strategy: ExpiryStrategy,
  ): Promise<(T | undefined)[]> {
    const items = await this.batchItems(
      target,
      scope,
      this.uniqueKeys(target, scope.namespace, keys),
    );
    if (items === undefined) return keys.map(() => undefined);
    const read = await this.io.readMany(
      target,
      items.map((item) => item.key),
      strategy,
      this.options.defaults.ttl,
    );
    // One tag check for the batch; awaited only when an entry is tagged (no 0.6 tick added).
    const checked = this.io.checkStamps(target, read);
    const lookups = checked instanceof Promise ? await checked : checked;
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
   * `CacheEngine.setMany` after validation; `ttl` is the effective ttl. With `tags`, the entries
   * are stamped together (one token call); an entry whose tags fail is not written.
   */
  async setMany<T>(
    target: Target,
    scope: BatchScope,
    entries: readonly (readonly [key: string, value: T])[],
    requested: ExpiryStrategy,
    ttl: number,
    tags?: BatchTagOption<T>,
  ): Promise<void> {
    const values = new Map<string, T>();
    for (const [key, value] of entries) values.set(key, value);
    const items = await this.batchItems(
      target,
      scope,
      this.uniqueKeys(target, scope.namespace, [...values.keys()]),
    );
    if (items === undefined) return;
    const writes = items.map((item) => {
      const value = values.get(item.ref.key) as T;
      // As `set`: an empty value keeps the 0.1 ttl, but always as `fixed`.
      const strategy = isEmpty(value) ? EMPTY_STRATEGY : requested;
      return { ...item, value, strategy, ttl: this.io.ttlFor(strategy, ttl) };
    });
    await this.io.writeMany(target, await this.io.tags.stampWrites(target, tags, writes));
  }

  /** `CacheEngine.getOrSetMany` after validation; `ttl` is the effective ttl. */
  async getOrSetMany<T>(
    target: Target,
    scope: BatchScope,
    keys: readonly string[],
    loader: BatchLoader<T>,
    options: BatchPutOptions<T>,
    strategy: ExpiryStrategy,
    ttl: number,
  ): Promise<(T | undefined)[]> {
    const unique = this.uniqueKeys(target, scope.namespace, keys);
    const plan: BatchPlan<T> = { target, namespace: scope.namespace, loader, options, strategy };
    const items = await this.batchItems(target, scope, unique);
    const values = new Map<string, unknown>();
    if (items === undefined) {
      // A version failure skips the cache: every key is loaded and nothing is written.
      const loaded = await this.load.runLoader(plan, unique, false);
      for (const key of unique) values.set(key, loaded.get(key));
      return keys.map((key) => values.get(key) as T | undefined);
    }
    const read = await this.io.readMany(
      target,
      items.map((item) => item.key),
      strategy,
      ttl,
    );
    const checked = this.io.checkStamps(target, read);
    const lookups = checked instanceof Promise ? await checked : checked;
    const missing: LoadItem[] = [];
    const stale: BatchItem[] = [];
    items.forEach((item, i) => {
      const lookup = lookups[i] ?? { found: false };
      if (!servable(lookup, strategy)) {
        this.io.miss(target.name, item.ref);
        // Its tag tokens could not be read: loaded, but not written (spec 3.2 step 4).
        missing.push(uncertain(lookup) ? { ...item, noWrite: true } : item);
        return;
      }
      this.io.hit(target.name, item.ref, lookup.stale);
      values.set(item.ref.key, lookup.value);
      if (lookup.stale) stale.push(item);
    });
    // Both start before anything is awaited, so their flights are registered at once.
    const loading = missing.length > 0 ? this.load.onMissMany(plan, missing) : undefined;
    const refreshing =
      stale.length > 0 ? this.load.refreshMany(plan, stale, options.softTimeout) : undefined;
    if (loading !== undefined) {
      for (const [key, value] of await loading) values.set(key, value);
    }
    // Without softTimeout the refresh runs in the background, as in 0.7. With it, the stale keys
    // share one wait window, and those refreshed in time get their new values.
    if (refreshing !== undefined && options.softTimeout !== undefined) {
      for (const [key, value] of await refreshing) values.set(key, value);
    }
    return keys.map((key) => values.get(key) as T | undefined);
  }

  /** `keys` deduped, first occurrence first, without invalid keys (one key error per call). */
  private uniqueKeys(
    target: Target,
    namespace: string | undefined,
    keys: readonly string[],
  ): string[] {
    const unique = new Set<string>();
    let invalid: TypeError | undefined;
    for (const key of keys) {
      const error = keyErrorOf(namespace, key);
      if (error === undefined) unique.add(key);
      else invalid ??= error;
    }
    if (invalid !== undefined) this.io.reportError(target.name, 'key', invalid);
    return [...unique];
  }

  /**
   * The batch items of `keys` (unique, neither empty nor reserved) in `scope`, with one version
   * read for a versioned namespace; `undefined` after a version failure (already reported). With
   * `recordKeys`, their full keys are the call's `cache.key`, set without an added tick.
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
    if (this.tracing.recordKeys) this.tracing.key(items.map((item) => item.key.full));
    return items;
  }
}
