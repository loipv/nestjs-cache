import type { BreakerState, CacheEventSink } from '../core/events.js';
import { CacheConfigError } from '../errors.js';
import type {
  CacheStore,
  InvalidationBus,
  LockHandle,
  LockProvider,
} from '../stores/cache-store.interface.js';

/** Options of `circuitBreakerStore`. */
export interface CircuitBreakerStoreOptions {
  /** Consecutive failures that open the circuit. Integer >= 1; defaults to 5. */
  failureThreshold?: number;
  /** How long the circuit stays open before a probe is allowed, in ms. Defaults to 10_000. */
  openDuration?: number;
  /**
   * Per-operation timeout in ms; a timeout counts as a failure. Does not apply to `clear`.
   * Defaults to 500.
   */
  timeout?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_OPEN_DURATION = 10_000;
const DEFAULT_TIMEOUT = 500;
/** Largest delay `setTimeout` accepts; anything above overflows to 1 ms. */
const MAX_TIMER_DELAY = 2_147_483_647;

/** Rejection of an operation that the circuit breaker did not pass to the store. */
export class CircuitOpenError extends Error {
  constructor(message = 'Cache store circuit is open') {
    super(message);
    this.name = 'CircuitOpenError';
  }

  /**
   * The ESM and CommonJS builds each define this class, so `instanceof` also accepts any `Error`
   * named `CircuitOpenError`. Subclasses keep the normal prototype check.
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    return this === CircuitOpenError && value instanceof Error && value.name === 'CircuitOpenError';
  }
}

function positiveNumber(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_TIMER_DELAY
  ) {
    throw new CacheConfigError(
      `Invalid circuitBreakerStore option ${name}: ${String(value)} (must be a finite number > 0 and <= ${String(MAX_TIMER_DELAY)})`,
    );
  }
  return value;
}

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new CacheConfigError(
      `Invalid circuitBreakerStore option ${name}: ${String(value)} (must be an integer >= 1)`,
    );
  }
  return value;
}

/**
 * Wraps a store with a circuit breaker (spec 0.2, 4.6). `get`, `set`, `delete`, `clear`,
 * `getAndTouch`, `getMany`, `setMany`, `touch`, `setIfAbsent`, `getStrict`, `setStrict`, `ping`, `lock.acquire` and
 * `LockHandle.release` are guarded: each races a timeout, except `clear`. `clear` runs only
 * while the circuit is closed (open or half-open it rejects with `CircuitOpenError`, and it is
 * never the half-open probe); it is not bounded by `timeout`, so set a command or socket timeout
 * on the client. Its real outcome is recorded once. `failureThreshold` consecutive failures open
 * the circuit so calls reject with
 * `CircuitOpenError` without reaching the store. After `openDuration` one probe is let through.
 * `invalidation`, `bind` and `close` are forwarded unchanged.
 */
export class CircuitBreakerStore implements CacheStore {
  /** Present only when the inner store has `getAndTouch`. */
  declare readonly getAndTouch?: (key: string, ttlMs: number) => Promise<string | undefined>;
  /** Present only when the inner store has `getMany`; one batch counts as one outcome. */
  declare readonly getMany?: (keys: readonly string[]) => Promise<(string | undefined)[]>;
  /** Present only when the inner store has `setMany`; one batch counts as one outcome. */
  declare readonly setMany?: (
    entries: readonly { key: string; value: string; ttlMs: number }[],
  ) => Promise<void>;
  /** Present only when the inner store has `getStrict`. */
  declare readonly getStrict?: (key: string) => Promise<string | undefined>;
  /** Present only when the inner store has `setStrict`. */
  declare readonly setStrict?: (key: string, value: string, ttlMs: number) => Promise<void>;
  /** Present only when the inner store has `touch`; one batch counts as one outcome. */
  declare readonly touch?: (keys: readonly string[], ttlMs: number) => Promise<void>;
  /** Present only when the inner store has `setIfAbsent`. */
  declare readonly setIfAbsent?: (key: string, value: string, ttlMs: number) => Promise<boolean>;
  /** Present only when the inner store has a lock; `acquire` and `release` are guarded. */
  declare readonly lock?: LockProvider;
  /** Present only when the inner store has `ping`; guarded like every other operation. */
  declare readonly ping?: () => Promise<void>;
  /** The inner store's bus, when it has one. */
  declare readonly invalidation?: InvalidationBus;

  private readonly inner: CacheStore;
  private readonly failureThreshold: number;
  private readonly openDuration: number;
  private readonly timeout: number;
  private current: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  /**
   * Bumped on every state change. An operation only affects the state if no change happened
   * since it was admitted, so late outcomes from an earlier state are ignored.
   */
  private generation = 0;
  private sink: CacheEventSink | undefined;

  constructor(inner: CacheStore, options: CircuitBreakerStoreOptions = {}) {
    this.failureThreshold = positiveInteger(
      'failureThreshold',
      options.failureThreshold,
      DEFAULT_FAILURE_THRESHOLD,
    );
    this.openDuration = positiveNumber('openDuration', options.openDuration, DEFAULT_OPEN_DURATION);
    this.timeout = positiveNumber('timeout', options.timeout, DEFAULT_TIMEOUT);
    this.inner = inner;
    if (inner.getAndTouch !== undefined) {
      const touch = inner.getAndTouch.bind(inner);
      this.getAndTouch = (key, ttlMs) => this.guard(() => touch(key, ttlMs));
    }
    if (inner.getMany !== undefined) {
      const getMany = inner.getMany.bind(inner);
      this.getMany = (keys) => this.guard(() => getMany(keys));
    }
    if (inner.setMany !== undefined) {
      const setMany = inner.setMany.bind(inner);
      this.setMany = (entries) => this.guard(() => setMany(entries));
    }
    if (inner.getStrict !== undefined) {
      const getStrict = inner.getStrict.bind(inner);
      this.getStrict = (key) => this.guard(() => getStrict(key));
    }
    if (inner.setStrict !== undefined) {
      const setStrict = inner.setStrict.bind(inner);
      this.setStrict = (key, value, ttlMs) => this.guard(() => setStrict(key, value, ttlMs));
    }
    if (inner.touch !== undefined) {
      const touch = inner.touch.bind(inner);
      this.touch = (keys, ttlMs) => this.guard(() => touch(keys, ttlMs));
    }
    if (inner.setIfAbsent !== undefined) {
      const setIfAbsent = inner.setIfAbsent.bind(inner);
      this.setIfAbsent = (key, value, ttlMs) => this.guard(() => setIfAbsent(key, value, ttlMs));
    }
    if (inner.lock !== undefined) {
      const lock = inner.lock;
      this.lock = {
        acquire: async (key, ttlMs) => {
          let raw: Promise<LockHandle | undefined> | undefined;
          let handle: LockHandle | undefined;
          try {
            handle = await this.guard(() => (raw = lock.acquire(key, ttlMs)));
          } catch (error) {
            // A handle that arrives after the call was rejected would hold the lock until its
            // ttl. Release it directly: unguarded, so it neither counts nor gets refused.
            raw
              ?.then(
                (late) => late?.release(),
                () => undefined,
              )
              .catch(() => undefined);
            throw error;
          }
          return handle === undefined ? undefined : this.guardHandle(handle);
        },
      };
    }
    if (inner.ping !== undefined) {
      const ping = inner.ping.bind(inner);
      this.ping = () => this.guard(() => ping());
    }
    if (inner.invalidation !== undefined) this.invalidation = inner.invalidation;
  }

  get state(): BreakerState {
    return this.current;
  }

  get(key: string): Promise<string | undefined> {
    return this.guard(() => this.inner.get(key));
  }

  set(key: string, value: string, ttlMs: number): Promise<void> {
    return this.guard(() => this.inner.set(key, value, ttlMs));
  }

  delete(keys: readonly string[]): Promise<void> {
    return this.guard(() => this.inner.delete(keys));
  }

  clear(prefix: string): Promise<void> {
    // Never the half-open probe: an untimed probe that hangs would pin the circuit half-open.
    if (this.current !== 'closed') return Promise.reject(new CircuitOpenError());
    // Not raced against `timeout`: a large clear legitimately runs long. Its outcome is recorded.
    return this.guard(() => this.inner.clear(prefix), false);
  }

  bind(sink: CacheEventSink): void {
    this.sink = sink;
    this.inner.bind?.(sink);
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }

  private guardHandle(handle: LockHandle): LockHandle {
    return { release: () => this.guard(() => handle.release()) };
  }

  /**
   * Admits the call or rejects it with `CircuitOpenError`, then races it against the timeout
   * (unless `timed` is false, as for `clear`). The first outcome (result, rejection or timeout)
   * settles the call and is recorded once.
   */
  private guard<T>(call: () => Promise<T>, timed = true): Promise<T> {
    if (this.current === 'half-open') return Promise.reject(new CircuitOpenError());
    if (this.current === 'open') {
      if (Date.now() - this.openedAt < this.openDuration) {
        return Promise.reject(new CircuitOpenError());
      }
      // This call becomes the single probe; half-open lasts until it settles.
      this.transition('half-open');
    }
    const admitted = this.generation;

    // The executor runs `call` at once and turns a synchronous throw into a rejection.
    const pending = new Promise<T>((resolve) => {
      resolve(call());
    });

    if (!timed) {
      return pending.then(
        (value) => {
          this.record(true, admitted);
          return value;
        },
        (error: unknown) => {
          this.record(false, admitted);
          throw error;
        },
      );
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.record(false, admitted);
        reject(new Error(`Cache store operation timed out after ${String(this.timeout)} ms`));
      }, this.timeout);
      timer.unref();
    });
    // Only the first outcome is recorded. After a timeout the late result is dropped, and a late
    // rejection is caught by the race below.
    const outcome = pending.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.record(true, admitted);
        }
        return value;
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.record(false, admitted);
        }
        throw error;
      },
    );
    return Promise.race([outcome, timedOut]);
  }

  private record(success: boolean, admitted: number): void {
    if (admitted !== this.generation) return;
    if (this.current === 'half-open') {
      if (success) this.reset();
      else this.open();
      return;
    }
    if (success) {
      this.failures = 0;
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.open();
  }

  private open(): void {
    this.openedAt = Date.now();
    this.transition('open');
  }

  private reset(): void {
    this.failures = 0;
    this.transition('closed');
  }

  private transition(state: BreakerState): void {
    this.current = state;
    this.generation += 1;
    if (this.sink === undefined) return;
    try {
      this.sink.emit('breaker', { state });
    } catch {
      // a failing sink must never reach the caller
    }
  }
}

/** Wraps `store` with a circuit breaker. Throws `CacheConfigError` for invalid options. */
export function circuitBreakerStore(
  store: CacheStore,
  options?: CircuitBreakerStoreOptions,
): CircuitBreakerStore {
  return new CircuitBreakerStore(store, options);
}
