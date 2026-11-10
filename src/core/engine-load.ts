import type { ResolvedDefaults } from '../module/cache.options.js';
import type { LockProvider } from '../stores/cache-store.interface.js';
import {
  servable,
  toIntegerMs,
  type EngineIO,
  type KeyRef,
  type PutOptions,
  type Target,
} from './engine-io.js';
import { loadWithLock, refreshWithLock, type LockHooks, type LockSettings } from './lock-runner.js';
import { SingleFlight } from './single-flight.js';
import type { ExpiryStrategy } from './strategies/expiry-strategy.js';

/** Everything a load needs once the facade has validated the call. */
export interface LoadPlan<T> {
  target: Target;
  ref: KeyRef;
  loader: () => Promise<T>;
  options: PutOptions<T>;
  strategy: ExpiryStrategy;
  /** The effective ttl, used by the silent re-reads of a locked wait. */
  ttl: number;
  /** Set only when the lock is enabled for the call and the store has one. */
  lock: LockProvider | undefined;
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

  /** Loads and stores a missing entry; concurrent misses of the key share the load. */
  async onMiss<T>(plan: LoadPlan<T>): Promise<T> {
    const flightKey = this.flightKey(plan);
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
    const flightKey = this.flightKey(plan);
    if (this.singleFlight.has(flightKey)) return;
    void this.singleFlight
      .run<Outcome<T>>(flightKey, () => this.refreshTask(plan))
      .catch(() => undefined);
  }

  private flightKey({ target, ref }: Located): string {
    return `${target.name}\u0000${this.io.keyOf(ref)}`;
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
    const { target, ref, strategy, ttl } = plan;
    const result = await loadWithLock<{ value: T; stale: boolean }>(
      lock,
      this.io.lockKeyOf(ref),
      this.lockSettings,
      async () => {
        const cached = await this.io.read(target, ref, strategy, ttl);
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
      this.io.lockKeyOf(plan.ref),
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

  /** A synchronous loader throw is a failed load too; `refreshing` reports it as `refresh`. */
  private async loadAndStore<T>(plan: LoadPlan<T>, refreshing: boolean): Promise<T> {
    const { target, ref, loader, options, strategy } = plan;
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
    await this.io.store(target, ref, value, options, strategy, false);
    return value;
  }
}
