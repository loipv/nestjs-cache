import type { EngineIO, KeyRef, PutOptions, Target } from './engine-io.js';
import { SingleFlight } from './single-flight.js';
import type { ExpiryStrategy } from './strategies/expiry-strategy.js';

/** Everything a load needs once the facade has validated the call. */
export interface LoadPlan<T> {
  target: Target;
  ref: KeyRef;
  loader: () => Promise<T>;
  options: PutOptions<T>;
  strategy: ExpiryStrategy;
}

/**
 * Miss loads and background refreshes. A miss and a refresh of the same key share one flight,
 * keyed `<store>\u0000<fullKey>`.
 */
export class EngineLoad {
  private readonly singleFlight = new SingleFlight();

  constructor(private readonly io: EngineIO) {}

  flightKey(target: Target, ref: KeyRef): string {
    return `${target.name}\u0000${this.io.keyOf(ref)}`;
  }

  /** Loads and stores a missing entry; concurrent misses of the key share the load. */
  onMiss<T>(plan: LoadPlan<T>): Promise<T> {
    return this.singleFlight.run(this.flightKey(plan.target, plan.ref), () =>
      this.loadAndStore(plan, false),
    );
  }

  /**
   * Fire and forget, one flight per key; shutdown does not wait for it. A failed load keeps
   * the stale value; the flight still rejects, so a miss that joined it gets the loader error.
   */
  refresh<T>(plan: LoadPlan<T>): void {
    const flightKey = this.flightKey(plan.target, plan.ref);
    if (this.singleFlight.has(flightKey)) return;
    void this.singleFlight
      .run(flightKey, () => this.loadAndStore(plan, true))
      .catch(() => undefined);
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
