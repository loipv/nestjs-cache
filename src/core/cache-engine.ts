import type { StrategyOptions } from '../decorators/options.js';
import { CacheConfigError } from '../errors.js';
import type { ResolvedCacheOptions } from '../module/cache.options.js';
import {
  EMPTY_STRATEGY,
  EngineIO,
  isEmpty,
  servable,
  type KeyRef,
  type PutOptions,
} from './engine-io.js';
import { EngineLoad } from './engine-load.js';
import type { CacheEvents, CacheLogLevel, CacheOperation } from './events.js';
import { createStrategy, type ExpiryStrategy } from './strategies/expiry-strategy.js';

export type { KeyRef, PutOptions } from './engine-io.js';

/** `lock` overrides `defaults.lock.enabled`; it has no effect on a store without `lock`. */
export type LoadOptions<T> = PutOptions<T> & { lock?: boolean };

export type SetOptions = { ttl?: number } & StrategyOptions;

function checkDuration(option: string, value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new CacheConfigError(
      `Invalid ${option}: ${String(value)}. Durations are milliseconds, finite numbers greater than 0.`,
    );
  }
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

  constructor(
    private readonly options: ResolvedCacheOptions,
    events: CacheEvents,
  ) {
    this.logLevel = options.logging.level;
    this.io = new EngineIO(options, events);
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
    const strategy = strategyOf(options, undefined);
    const result = await this.io.read(target, ref, strategy, this.options.defaults.ttl);
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
    checkDuration('ttl', options.ttl);
    checkDuration('nullTtl', options.nullTtl);
    const ttl = options.ttl ?? this.options.defaults.ttl;
    const strategy = strategyOf(options, ttl, preset);
    const cached = await this.io.read(target, ref, strategy, ttl);
    const locking = options.lock ?? this.options.defaults.lock.enabled;
    const lock = locking ? target.store.lock : undefined;
    const plan = { target, ref, loader, options, strategy, ttl, lock };
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
    checkDuration('ttl', options.ttl);
    const ttl = options.ttl ?? this.options.defaults.ttl;
    const requested = strategyOf(options, ttl);
    // `set` has no cacheNull/nullTtl: an empty value keeps the 0.1 ttl, but always as `fixed`.
    const strategy = isEmpty(value) ? EMPTY_STRATEGY : requested;
    await this.io.write(target, ref, value, strategy, this.io.ttlFor(strategy, ttl));
  }

  /** @param preset Internal: as for `getOrSet`. */
  async put<T>(
    ref: KeyRef,
    value: T,
    options: PutOptions<T> = {},
    preset?: ExpiryStrategy,
  ): Promise<void> {
    const target = this.io.resolve(ref.store);
    checkDuration('ttl', options.ttl);
    checkDuration('nullTtl', options.nullTtl);
    const strategy = strategyOf(options, options.ttl ?? this.options.defaults.ttl, preset);
    await this.io.store(target, ref, value, options, strategy, true);
  }

  delete(scope: { store?: string; namespace?: string }, keys: readonly string[]): Promise<void> {
    return this.io.delete(scope, keys);
  }

  async clear(namespace: string, storeName?: string): Promise<void> {
    // With a prefix, '' would wipe every namespace; without one it would clear nothing.
    if (typeof namespace !== 'string' || namespace === '') {
      throw new CacheConfigError('clear requires a non-empty namespace');
    }
    await this.io.clear(storeName, namespace);
  }

  reportError(store: string | undefined, operation: CacheOperation, error: unknown): void {
    this.io.reportError(store, operation, error);
  }
}
