import type { ResolvedDefaults } from '../module/cache.options.js';
import type { CacheTracing } from '../observability/cache-tracing.js';
import type { LockProvider } from '../stores/cache-store.interface.js';
import {
  isEmpty,
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

/**
 * A refresh that found the lock held settles its flight without a value. `unwritten` marks an
 * empty value (`undefined`/`null`, or an omitted batch key) that was not stored, by what the
 * write actually did (`EngineIO.store`/`storeMany`): `cacheNull` off, a load that does not
 * write, an `unless` veto or throw, a `'skip'` tag stamp or a failed set.
 */
type Outcome<T> = Loaded<T> | { loaded: false };

/** A flight that loaded a value; see `Outcome`. */
type Loaded<T> = { loaded: true; value: T; unwritten?: true };

/** A loaded value and whether its write happened. */
interface Stored<T> {
  value: T;
  written: boolean;
}

/**
 * The value a refresh wrote; `undefined` when it was skipped or failed, or loaded an empty value
 * it did not write (F-2): the store then still holds the stale entry, so the caller gets that,
 * as when the refresh misses the softTimeout window. An empty value written by `cacheNull` is
 * `{ value }`.
 */
export type Refreshed<T> = { value: T } | undefined;

/** A batch loader's result and the user keys of it that were written. */
interface LoadedMany<T> {
  loaded: ReadonlyMap<string, T>;
  written: ReadonlySet<string>;
}

const NOOP = (): void => undefined;

/** Node runs a longer `setTimeout` delay after 1 ms; the soft wait is capped at this instead. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Settles with `pending`'s value, or with `undefined` once `ms` have passed. `pending` must
 * never reject. The timer is unref'd and always cleared.
 */
export async function settleWithin<T>(pending: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    const started = setTimeout(
      () => {
        resolve(undefined);
      },
      Math.min(ms, MAX_TIMER_MS),
    );
    started.unref();
    timer = started;
  });
  try {
    return await Promise.race([pending, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** A batch loader's result; throws a `TypeError` unless it is a Map. */
function asMap<T>(loaded: unknown): ReadonlyMap<string, T> {
  if (!(loaded instanceof Map)) {
    const got = loaded === null ? 'null' : typeof loaded;
    throw new TypeError(`The getOrSetMany loader must resolve a Map, got ${got}.`);
  }
  return loaded as ReadonlyMap<string, T>;
}

/** A flight's outcome as a refresh result; never rejects. */
function refreshed<T>(flight: Promise<unknown>): Promise<Refreshed<T>> {
  return flight.then(
    (outcome) => {
      const settled = outcome as Outcome<T>;
      return settled.loaded && settled.unwritten !== true ? { value: settled.value } : undefined;
    },
    () => undefined,
  );
}

/**
 * Miss loads and background refreshes. A miss and a refresh of the same key share one flight,
 * keyed `<store>\u0000<fullKey>`.
 */
export class EngineLoad {
  private readonly singleFlight = new SingleFlight();
  private readonly lockSettings: LockSettings;

  constructor(
    private readonly io: EngineIO,
    defaults: Pick<ResolvedDefaults, 'lock'>,
    private readonly tracing: CacheTracing,
  ) {
    const { ttl, waitTimeout, retryDelay } = defaults.lock;
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
    // Traced, `cache.load.joined` is set once the joined flight has loaded (or failed its load),
    // not for a refresh that skipped its load: this call then loads on its own.
    const joining = this.tracing.enabled && this.singleFlight.has(flightKey);
    let joined: Outcome<T>;
    try {
      joined = await this.singleFlight.run<Outcome<T>>(flightKey, () => this.missTask(plan));
    } catch (error) {
      if (joining) this.tracing.set('cache.load.joined', true);
      throw error;
    }
    if (joined.loaded) {
      if (joining) this.tracing.set('cache.load.joined', true);
      return joined.value;
    }
    // The flight was a refresh that skipped its load: another instance holds the lock. A miss
    // that joins another miss's flight here shares its load, with the same rule as above.
    const sharing = this.tracing.enabled && this.singleFlight.has(flightKey);
    let own: Outcome<T>;
    try {
      own = await this.singleFlight.run<Outcome<T>>(flightKey, () => this.missTask(plan));
    } catch (error) {
      if (sharing) this.tracing.set('cache.load.joined', true);
      throw error;
    }
    if (own.loaded) {
      if (sharing) this.tracing.set('cache.load.joined', true);
      return own.value;
    }
    return (await this.missTask(plan)).value;
  }

  /**
   * One flight per key, registered before this returns; shutdown does not wait for it. A failed
   * load keeps the stale value; the flight still rejects, so a miss that joined it gets the
   * loader error. The result is the value the flight wrote, or `undefined` when it was skipped,
   * failed or loaded an empty value it did not write (`Refreshed`); it never rejects. A key
   * already in flight (a miss, a refresh or a batch) is not loaded again: its flight is joined.
   * Callers that do not wait ignore the result.
   */
  refresh<T>(plan: LoadPlan<T>): Promise<Refreshed<T>> {
    const flightKey = this.flightKey(plan.target, plan.key);
    const current = this.singleFlight.current(flightKey);
    if (current !== undefined) return refreshed(current);
    // Traced, the refresh is a root `cache.refresh` span linked to the call that started it.
    const task = this.tracing.enabled
      ? () =>
          this.tracing.root({ store: plan.target.name, namespace: plan.ref.namespace }, () =>
            this.refreshTask(plan),
          )
      : () => this.refreshTask(plan);
    return refreshed(this.singleFlight.run<Outcome<T>>(flightKey, task));
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
      const { loaded } = await this.loadMany(plan, skipped, false);
      for (const item of skipped) values.set(item.ref.key, loaded.get(item.ref.key));
    }
    return values;
  }

  /**
   * One loader call for the stale items not already in flight, as `refresh`; the items in
   * flight join theirs. A failure is one `refresh` error; the stale values stay. Never rejects:
   * the result holds, by plain key, each refreshed value that counts (`Refreshed`): a non-empty
   * one, and an empty one (an omitted key as `undefined`) only when it was actually written;
   * any other key keeps its stale value.
   * With `softTimeout`, it settles once every item is done or that many ms have passed,
   * whichever is first, with the keys done by then; the refreshes run on.
   */
  refreshMany<T>(
    plan: BatchPlan<T>,
    items: readonly BatchItem[],
    softTimeout?: number,
  ): Promise<ReadonlyMap<string, T>> {
    const done = new Map<string, T>();
    // `flights` joins the items in flight and loads the others with one loader call.
    const flights = this.flights(plan, items, true).map((flight, i) =>
      refreshed<T>(flight).then((result) => {
        const item = items[i];
        if (result !== undefined && item !== undefined) done.set(item.ref.key, result.value);
      }),
    );
    const all = Promise.all(flights).then(() => done);
    if (softTimeout === undefined) return all;
    return settleWithin(all, softTimeout).then(() => new Map(done));
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
    let batch: Promise<LoadedMany<T>> | undefined;
    return items.map((item) =>
      this.singleFlight.run<Outcome<unknown>>(this.flightKey(plan.target, item.key), async () => {
        // Traced, a refresh is one root `cache.refresh` span for the batch's own items.
        batch ??=
          refreshing && this.tracing.enabled
            ? this.tracing.root({ store: plan.target.name, namespace: plan.namespace }, () =>
                this.loadMany(plan, own, true),
              )
            : this.loadMany(plan, own, refreshing);
        const { loaded, written } = await batch;
        const { key } = item.ref;
        return this.outcome({ value: loaded.get(key), written: written.has(key) });
      }),
    );
  }

  /**
   * Runs the loader for `items` and stores what it returned for them, except `noWrite` items;
   * other keys are ignored. Tags known up front have their tokens taken before the loader runs,
   * as in `loadAndStore`, when any item is to be written. `written` holds the user keys stored.
   */
  private async loadMany<T>(
    plan: BatchPlan<T>,
    items: readonly LoadItem[],
    refreshing: boolean,
  ): Promise<LoadedMany<T>> {
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
    const written = await this.io.storeMany(
      plan.target,
      values,
      plan.options,
      plan.strategy,
      taken,
    );
    return { loaded, written };
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
    let loaded: ReadonlyMap<string, T>;
    try {
      // Traced, `cache.load` covers the Map check too, so a non-Map marks it `ERROR`. The async
      // wrapper costs one microtask after the loader settles, on the traced path only.
      loaded = this.tracing.enabled
        ? await this.tracing.child('cache.load', async () => asMap<T>(await loader([...keys])))
        : asMap<T>(await loader([...keys]));
    } catch (error) {
      this.io.emitLoad(target.name, ref, started, false, keys);
      if (refreshing) this.io.reportError(target.name, 'refresh', error);
      throw error;
    }
    this.io.emitLoad(target.name, ref, started, true, keys);
    return loaded;
  }

  private flightKey(target: Target, key: ResolvedKey): string {
    return `${target.name}\u0000${key.full}`;
  }

  /** A miss's flight outcome; `unwritten` as in `Outcome`, for a refresh that joins it. */
  private async missTask<T>(plan: LoadPlan<T>): Promise<Loaded<T>> {
    const stored =
      plan.lock === undefined
        ? await this.loadAndStore(plan, false)
        : await this.loadLocked(plan, plan.lock);
    return this.outcome(stored);
  }

  /**
   * A loaded value as a flight outcome: marked `unwritten` when it is empty and its write did
   * not happen. A non-empty value is fresh data whether or not it was written (F-6).
   */
  private outcome<T>({ value, written }: Stored<T>): Loaded<T> {
    if (isEmpty(value) && !written) return { loaded: true, value, unwritten: true };
    return { loaded: true, value };
  }

  /**
   * A value found while waiting for another holder is served with a single `hit`; it is in the
   * store, so it counts as written.
   */
  private async loadLocked<T>(plan: LoadPlan<T>, lock: LockProvider): Promise<Stored<T>> {
    const { target, ref, key, strategy, ttl } = plan;
    const result = await loadWithLock<Stored<T> & { stale: boolean }>(
      lock,
      key.lock,
      this.lockSettings,
      async () => {
        const cached = await this.io.read(target, key, strategy, ttl);
        return servable(cached, strategy)
          ? {
              found: true,
              value: { value: cached.value as T, written: true, stale: cached.stale },
            }
          : { found: false };
      },
      async () => ({ ...(await this.loadAndStore(plan, false)), stale: false }),
      this.hooks(plan),
    );
    // A stale swr value is served as is; the holder's own write is the refresh.
    if (result.from === 'cache') this.io.hit(target.name, ref, result.value.stale);
    return result.value;
  }

  private async refreshTask<T>(plan: LoadPlan<T>): Promise<Outcome<T>> {
    if (plan.lock === undefined) {
      return this.outcome(await this.loadAndStore(plan, true));
    }
    let outcome: Outcome<T> = { loaded: false };
    await refreshWithLock(
      plan.lock,
      plan.key.lock,
      this.lockSettings.ttl,
      async () => {
        outcome = this.outcome(await this.loadAndStore(plan, true));
      },
      this.hooks(plan),
    );
    return outcome;
  }

  /**
   * Traced, `cache.lock` runs from `onAcquireStart` to the first `onLock` or acquire error; its
   * `end` is idempotent, so a later release error lands on the current cache span instead.
   */
  private hooks({ target, ref }: Located): LockHooks {
    let lockSpan: { end(acquired: boolean | undefined): void } | undefined;
    return {
      onAcquireStart: this.tracing.enabled
        ? () => {
            lockSpan = this.tracing.lockSpan();
          }
        : NOOP,
      onLock: (acquired, waitedMs) => {
        lockSpan?.end(acquired);
        this.io.emitLock(target.name, ref, waitedMs, acquired);
      },
      onError: (error) => {
        lockSpan?.end(undefined);
        this.io.reportError(target.name, 'lock', error);
      },
    };
  }

  /**
   * A synchronous loader throw is a failed load too; `refreshing` reports it as `refresh`. Tags
   * known up front (an array) have their tokens taken before the loader runs, and the write uses
   * exactly those, so an invalidation during the load is not lost (spec 3.3). A `noWrite` plan
   * only loads. `written` is what `EngineIO.store` reports.
   */
  private async loadAndStore<T>(plan: LoadPlan<T>, refreshing: boolean): Promise<Stored<T>> {
    const { target, ref, key, loader, options, strategy } = plan;
    const writes = plan.noWrite !== true;
    // Awaited only with tags known up front: an untagged load keeps the 0.6 ticks.
    const { tags } = options;
    const taken =
      writes && knownTags(tags) ? await this.io.tags.stamp(target, () => tags) : undefined;
    const started = Date.now();
    let value: T;
    try {
      value = await this.tracing.child('cache.load', loader);
    } catch (error) {
      this.io.emitLoad(target.name, ref, started, false);
      if (refreshing) this.io.reportError(target.name, 'refresh', error);
      throw error;
    }
    this.io.emitLoad(target.name, ref, started, true);
    const written =
      writes && (await this.io.store(target, ref, key, value, options, strategy, false, taken));
    return { value, written };
  }
}
