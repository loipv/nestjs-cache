import type { ResolvedDefaults } from '../module/cache.options.js';
import type { LockProvider } from '../stores/cache-store.interface.js';
import {
  servable,
  toIntegerMs,
  type BatchItem,
  type BatchPutOptions,
  type EngineIO,
  type KeyRef,
  type PutOptions,
  type ResolvedKey,
  type Target,
} from './engine-io.js';
import { knownTags } from './engine-tags.js';
import { loadWithLock, refreshWithLock, type LockHooks, type LockSettings } from './lock-runner.js';
import { SingleFlight } from './single-flight.js';
import type { ExpiryStrategy } from './strategies/expiry-strategy.js';

/** Everything a load needs once the facade has validated the call. */
export interface LoadPlan<T> {
  target: Target;
  ref: KeyRef;
  /** Resolved once by the facade, so the load, its lock and its write use one version. */
  key: ResolvedKey;
  loader: () => Promise<T>;
  options: PutOptions<T>;
  strategy: ExpiryStrategy;
  /** The effective ttl, used by the silent re-reads of a locked wait. */
  ttl: number;
  /** Set only when the lock is enabled for the call and the store has one. */
  lock: LockProvider | undefined;
  /**
   * The read could not check the entry's tags (spec 3.2 step 4): the value is loaded but not
   * written, and no tag tokens are taken for it.
   */
  noWrite?: boolean;
}

/** A batch item to load; `noWrite` as in `LoadPlan`, per item. */
export type LoadItem = BatchItem & { noWrite?: boolean };

/** Everything a batch load needs once the facade has validated the call. Batches never lock. */
export interface BatchPlan<T> {
  target: Target;
  namespace: string | undefined;
  loader: (missing: string[]) => Promise<ReadonlyMap<string, T>>;
  options: BatchPutOptions<T>;
  strategy: ExpiryStrategy;
}

type Located = Pick<LoadPlan<unknown>, 'target' | 'ref'>;

/** A refresh that found the lock held settles its flight without a value. */
type Outcome<T> = { loaded: true; value: T } | { loaded: false };

/**
 * Miss loads and background refreshes. A miss and a refresh of the same key share one flight,
 * keyed `<store>\u0000<fullKey>`.
 */
export class EngineLoad {
  private readonly singleFlight = new SingleFlight();
  private readonly lockSettings: LockSettings;

  constructor(
    private readonly io: EngineIO,
    lockDefaults: ResolvedDefaults['lock'],
  ) {
    const { ttl, waitTimeout, retryDelay } = lockDefaults;
    this.lockSettings = { ttl: toIntegerMs(ttl), waitTimeout, retryDelay };
  }

  /**
   * Loads and stores a missing entry; concurrent misses of the key share the load. The flight
   * key ignores `noWrite`, so single-flight works in both directions: a caller that would write
   * can join a flight that does not (it gets the value, nothing is written for it), and a
   * caller that cannot write joins a flight that does (it gets the value, which is stored).
   */
  async onMiss<T>(plan: LoadPlan<T>): Promise<T> {
    const flightKey = this.flightKey(plan.target, plan.key);
    const joined = await this.singleFlight.run<Outcome<T>>(flightKey, () => this.missTask(plan));
    if (joined.loaded) return joined.value;
    // The flight was a refresh that skipped its load: another instance holds the lock.
    const own = await this.singleFlight.run<Outcome<T>>(flightKey, () => this.missTask(plan));
    return own.loaded ? own.value : (await this.missTask(plan)).value;
  }

  /**
   * Fire and forget, one flight per key; shutdown does not wait for it. A failed load keeps
   * the stale value; the flight still rejects, so a miss that joined it gets the loader error.
   */
  refresh<T>(plan: LoadPlan<T>): void {
    const flightKey = this.flightKey(plan.target, plan.key);
    if (this.singleFlight.has(flightKey)) return;
    void this.singleFlight
      .run<Outcome<T>>(flightKey, () => this.refreshTask(plan))
      .catch(() => undefined);
  }

  /**
   * Loads the missing batch items, by plain key. An item already in flight (a single-key load
   * or refresh, or another batch) joins it; the rest share one flight per key, all settled by
   * one loader call, so a concurrent single-key `getOrSet` joins them. A joined refresh that
   * skipped its load (another instance held its lock) leaves its items to one more loader
   * call, outside single-flight. A loader error rejects every flight and the caller.
   */
  async onMissMany<T>(
    plan: BatchPlan<T>,
    items: readonly LoadItem[],
  ): Promise<Map<string, unknown>> {
    const outcomes = await Promise.all(this.flights(plan, items, false));
    const values = new Map<string, unknown>();
    const skipped: LoadItem[] = [];
    items.forEach((item, i) => {
      const outcome = outcomes[i];
      if (outcome?.loaded === true) values.set(item.ref.key, outcome.value);
      else skipped.push(item);
    });
    if (skipped.length > 0) {
      const loaded = await this.loadMany(plan, skipped, false);
      for (const item of skipped) values.set(item.ref.key, loaded.get(item.ref.key));
    }
    return values;
  }

  /**
   * Fire and forget: one loader call for the stale items not already in flight, as `refresh`.
   * A failure is one `refresh` error; the stale values stay.
   */
  refreshMany<T>(plan: BatchPlan<T>, items: readonly BatchItem[]): void {
    const pending = items.filter(
      (item) => !this.singleFlight.has(this.flightKey(plan.target, item.key)),
    );
    for (const flight of this.flights(plan, pending, true)) void flight.catch(() => undefined);
  }

  /**
   * One flight per item: an item in flight joins it; the others run one shared `loadMany`,
   * started by the first of them, so every flight is registered before anything is awaited.
   */
  private flights<T>(
    plan: BatchPlan<T>,
    items: readonly LoadItem[],
    refreshing: boolean,
  ): Promise<Outcome<unknown>>[] {
    const own = items.filter(
      (item) => !this.singleFlight.has(this.flightKey(plan.target, item.key)),
    );
    let loaded: Promise<ReadonlyMap<string, T>> | undefined;
    return items.map((item) =>
      this.singleFlight.run<Outcome<unknown>>(this.flightKey(plan.target, item.key), async () => {
        loaded ??= this.loadMany(plan, own, refreshing);
        return { loaded: true, value: (await loaded).get(item.ref.key) };
      }),
    );
  }

  /**
   * Runs the loader for `items` and stores what it returned for them, except `noWrite` items;
   * other keys are ignored. Tags known up front have their tokens taken before the loader runs,
   * as in `loadAndStore`, when any item is to be written.
   */
  private async loadMany<T>(
    plan: BatchPlan<T>,
    items: readonly LoadItem[],
    refreshing: boolean,
  ): Promise<ReadonlyMap<string, T>> {
    const { tags } = plan.options;
    const writable = items.filter((item) => item.noWrite !== true);
    const taken =
      knownTags(tags) && writable.length > 0
        ? await this.io.tags.stamp(plan.target, () => tags)
        : undefined;
    const loaded = await this.runLoader(
      plan,
      items.map((item) => item.ref.key),
      refreshing,
    );
    // An omitted key is stored as if the loader had returned `undefined` for it.
    const values = writable.map(({ ref, key }) => ({ ref, key, value: loaded.get(ref.key) as T }));
    await this.io.storeMany(plan.target, values, plan.options, plan.strategy, taken);
    return loaded;
  }

  /**
   * One batch loader call and its `load` event (`key` the first key, `keys` all of them). A
   * rejection, a synchronous throw or a result that is not a Map reaches the caller;
   * `refreshing` also reports it as `refresh`.
   */
  async runLoader<T>(
    plan: BatchPlan<T>,
    keys: readonly string[],
    refreshing: boolean,
  ): Promise<ReadonlyMap<string, T>> {
    const { target, namespace, loader } = plan;
    const ref = { namespace, key: keys[0] ?? '' };
    const started = Date.now();
    let loaded: unknown;
    try {
      loaded = await loader([...keys]);
      if (!(loaded instanceof Map)) {
        const got = loaded === null ? 'null' : typeof loaded;
        throw new TypeError(`The getOrSetMany loader must resolve a Map, got ${got}.`);
      }
    } catch (error) {
      this.io.emitLoad(target.name, ref, started, false, keys);
      if (refreshing) this.io.reportError(target.name, 'refresh', error);
      throw error;
    }
    this.io.emitLoad(target.name, ref, started, true, keys);
    return loaded as ReadonlyMap<string, T>;
  }

  private flightKey(target: Target, key: ResolvedKey): string {
    return `${target.name}\u0000${key.full}`;
  }

  private async missTask<T>(plan: LoadPlan<T>): Promise<{ loaded: true; value: T }> {
    const value =
      plan.lock === undefined
        ? await this.loadAndStore(plan, false)
        : await this.loadLocked(plan, plan.lock);
    return { loaded: true, value };
  }

  /** A value found while waiting for another holder is served with a single `hit`. */
  private async loadLocked<T>(plan: LoadPlan<T>, lock: LockProvider): Promise<T> {
    const { target, ref, key, strategy, ttl } = plan;
    const result = await loadWithLock<{ value: T; stale: boolean }>(
      lock,
      key.lock,
      this.lockSettings,
      async () => {
        const cached = await this.io.read(target, key, strategy, ttl);
        return servable(cached, strategy)
          ? { found: true, value: { value: cached.value as T, stale: cached.stale } }
          : { found: false };
      },
      async () => ({ value: await this.loadAndStore(plan, false), stale: false }),
      this.hooks(plan),
    );
    // A stale swr value is served as is; the holder's own write is the refresh.
    if (result.from === 'cache') this.io.hit(target.name, ref, result.value.stale);
    return result.value.value;
  }

  private async refreshTask<T>(plan: LoadPlan<T>): Promise<Outcome<T>> {
    if (plan.lock === undefined) {
      return { loaded: true, value: await this.loadAndStore(plan, true) };
    }
    let outcome: Outcome<T> = { loaded: false };
    await refreshWithLock(
      plan.lock,
      plan.key.lock,
      this.lockSettings.ttl,
      async () => {
        outcome = { loaded: true, value: await this.loadAndStore(plan, true) };
      },
      this.hooks(plan),
    );
    return outcome;
  }

  private hooks({ target, ref }: Located): LockHooks {
    return {
      onLock: (acquired, waitedMs) => {
        this.io.emitLock(target.name, ref, waitedMs, acquired);
      },
      onError: (error) => {
        this.io.reportError(target.name, 'lock', error);
      },
    };
  }

  /**
   * A synchronous loader throw is a failed load too; `refreshing` reports it as `refresh`. Tags
   * known up front (an array) have their tokens taken before the loader runs, and the write uses
   * exactly those, so an invalidation during the load is not lost (spec 3.3). A `noWrite` plan
   * only loads.
   */
  private async loadAndStore<T>(plan: LoadPlan<T>, refreshing: boolean): Promise<T> {
    const { target, ref, key, loader, options, strategy } = plan;
    const writes = plan.noWrite !== true;
    // Awaited only with tags known up front: an untagged load keeps the 0.6 ticks.
    const { tags } = options;
    const taken =
      writes && knownTags(tags) ? await this.io.tags.stamp(target, () => tags) : undefined;
    const started = Date.now();
    let value: T;
    try {
      value = await loader();
    } catch (error) {
      this.io.emitLoad(target.name, ref, started, false);
      if (refreshing) this.io.reportError(target.name, 'refresh', error);
      throw error;
    }
    this.io.emitLoad(target.name, ref, started, true);
    if (writes) await this.io.store(target, ref, key, value, options, strategy, false, taken);
    return value;
  }
}
