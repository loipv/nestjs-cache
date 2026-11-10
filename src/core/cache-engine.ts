import type { StrategyOptions } from '../decorators/options.js';
import { CacheConfigError } from '../errors.js';
import type { ResolvedCacheOptions } from '../module/cache.options.js';
import type { CacheStore } from '../stores/cache-store.interface.js';
import { isEnvelope, unwrap, type CacheEnvelope } from './envelope.js';
import type { CacheEvents, CacheOperation } from './events.js';
import { fullKey, namespacePrefix } from './key-builder.js';
import { SingleFlight } from './single-flight.js';
import { createStrategy, type ExpiryStrategy } from './strategies/expiry-strategy.js';

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

/** `lock` takes effect from the locking work; it is accepted and forwarded already. */
export type LoadOptions<T> = PutOptions<T> & { lock?: boolean };

export type SetOptions = { ttl?: number } & StrategyOptions;

interface Target {
  name: string;
  store: CacheStore;
}

type Lookup = { found: true; value: unknown; stale: boolean } | { found: false };

/** Empty values always use `fixed`: it is the strategy that keeps the `nil` marker. */
const EMPTY_STRATEGY = createStrategy();

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

/**
 * Validates the strategy options and builds the strategy. `ttl` is the effective ttl the
 * entry is written with; it is omitted by `get`, which writes nothing.
 */
function strategyOf(options: StrategyOptions, ttl: number | undefined): ExpiryStrategy {
  const { staleTtl, maxTtl } = options;
  checkDuration('staleTtl', staleTtl);
  checkDuration('maxTtl', maxTtl);
  const strategy = createStrategy(options);
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

function isEmpty(value: unknown): value is null | undefined {
  return value === null || value === undefined;
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

  /** Never refreshes; `options` selects the read command and the classification only. */
  async get<T>(ref: KeyRef, options: StrategyOptions = {}): Promise<T | undefined> {
    const target = this.resolve(ref.store);
    const strategy = strategyOf(options, undefined);
    const result = await this.read(target, ref, strategy, this.options.defaults.ttl);
    if (!result.found) {
      this.miss(target.name, ref);
      return undefined;
    }
    this.hit(target.name, ref, result.stale);
    return result.value as T | undefined;
  }

  async getOrSet<T>(
    ref: KeyRef,
    loader: () => Promise<T>,
    options: LoadOptions<T> = {},
  ): Promise<T> {
    const target = this.resolve(ref.store);
    checkDuration('ttl', options.ttl);
    checkDuration('nullTtl', options.nullTtl);
    const ttl = options.ttl ?? this.options.defaults.ttl;
    const strategy = strategyOf(options, ttl);
    const cached = await this.read(target, ref, strategy, ttl);
    // A stale entry is served only under swr; any other reader has a loader and reloads now.
    if (cached.found && (!cached.stale || strategy.kind === 'swr')) {
      this.hit(target.name, ref, cached.stale);
      return cached.value as T;
    }
    this.miss(target.name, ref);
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
      await this.store(target, ref, value, options, strategy, false);
      return value;
    });
  }

  async set(ref: KeyRef, value: unknown, options: SetOptions = {}): Promise<void> {
    const target = this.resolve(ref.store);
    checkDuration('ttl', options.ttl);
    const ttl = options.ttl ?? this.options.defaults.ttl;
    const requested = strategyOf(options, ttl);
    // `set` has no cacheNull/nullTtl: an empty value keeps the 0.1 ttl, but always as `fixed`.
    const strategy = isEmpty(value) ? EMPTY_STRATEGY : requested;
    await this.write(target, ref, value, strategy, this.ttlFor(strategy, ttl));
  }

  async put<T>(ref: KeyRef, value: T, options: PutOptions<T> = {}): Promise<void> {
    const target = this.resolve(ref.store);
    checkDuration('ttl', options.ttl);
    checkDuration('nullTtl', options.nullTtl);
    const strategy = strategyOf(options, options.ttl ?? this.options.defaults.ttl);
    await this.store(target, ref, value, options, strategy, true);
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
    // With a prefix, '' would wipe every namespace; without one it would clear nothing.
    if (typeof namespace !== 'string' || namespace === '') {
      throw new CacheConfigError('clear requires a non-empty namespace');
    }
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

  /**
   * Reads and classifies an entry without emitting `hit`/`miss`; callers decide which one
   * applies. `ttl` is the effective ttl, used as the sliding touch ttl.
   */
  private async read(
    { name, store }: Target,
    ref: KeyRef,
    strategy: ExpiryStrategy,
    ttl: number,
  ): Promise<Lookup> {
    const key = fullKey(this.options.prefix, ref.namespace, ref.key);
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
    const state = strategy.classify(envelope, Date.now());
    if (state === 'expired') return { found: false };
    if (reSet) {
      // Never reached for an expired entry, so maxTtl still bounds a sliding entry. Not atomic.
      try {
        await store.set(key, raw, touchTtl);
      } catch (error) {
        this.reportError(name, 'set', error);
      }
    }
    return { found: true, value: unwrap(envelope), stale: state === 'stale' };
  }

  private async store<T>(
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

  private emitLoad(store: string, ref: KeyRef, started: number, success: boolean): void {
    this.events.emit('load', {
      store,
      namespace: ref.namespace,
      key: ref.key,
      durationMs: Date.now() - started,
      success,
    });
  }

  /** `ttl` is an integer >= 1, already jittered when the strategy asks for it. */
  private async write(
    { name, store }: Target,
    ref: KeyRef,
    value: unknown,
    strategy: ExpiryStrategy,
    ttl: number,
  ): Promise<void> {
    const key = fullKey(this.options.prefix, ref.namespace, ref.key);
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

  private hit(store: string, ref: KeyRef, stale: boolean): void {
    this.events.emit('hit', { store, namespace: ref.namespace, key: ref.key, stale });
  }

  private miss(store: string, ref: KeyRef): void {
    this.events.emit('miss', { store, namespace: ref.namespace, key: ref.key });
  }

  private ttlFor(strategy: ExpiryStrategy, ttl: number): number {
    return strategy.jittered ? this.jittered(ttl) : toIntegerMs(ttl);
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
