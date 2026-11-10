import type { BreakerState, CacheEventSink } from '../core/events.js';
import { CacheConfigError } from '../errors.js';
import type {
  CacheStore,
  InvalidationBus,
  LockHandle,
  LockProvider,
} from '../stores/cache-store.interface.js';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. Integer >= 1; defaults to 5. */
  failureThreshold?: number;
  /** How long the circuit stays open before a probe is allowed, in ms. Defaults to 10_000. */
  openDuration?: number;
  /** Per-operation timeout in ms; a timeout counts as a failure. Defaults to 500. */
  timeout?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_OPEN_DURATION = 10_000;
const DEFAULT_TIMEOUT = 500;

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
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new CacheConfigError(
      `Invalid circuitBreaker option ${name}: ${String(value)} (must be a finite number > 0)`,
    );
  }
  return value;
}

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new CacheConfigError(
      `Invalid circuitBreaker option ${name}: ${String(value)} (must be an integer >= 1)`,
    );
  }
  return value;
}

/**
 * Wraps a store with a circuit breaker (spec 0.2, 4.6). `get`, `set`, `delete`, `clear`,
 * `getAndTouch`, `lock.acquire` and `LockHandle.release` are guarded: each races a timeout, and
 * `failureThreshold` consecutive failures open the circuit so calls reject with
 * `CircuitOpenError` without reaching the store. After `openDuration` one probe is let through.
 * `invalidation`, `bind` and `close` are forwarded unchanged.
 */
export class CircuitBreakerStore implements CacheStore {
  /** Present only when the inner store has `getAndTouch`. */
  declare readonly getAndTouch?: (key: string, ttlMs: number) => Promise<string | undefined>;
  /** Present only when the inner store has a lock; `acquire` and `release` are guarded. */
  declare readonly lock?: LockProvider;
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

  constructor(inner: CacheStore, options: CircuitBreakerOptions = {}) {
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
    if (inner.lock !== undefined) {
      const lock = inner.lock;
      this.lock = {
        acquire: async (key, ttlMs) => {
          const handle = await this.guard(() => lock.acquire(key, ttlMs));
          return handle === undefined ? undefined : this.guardHandle(handle);
        },
      };
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
    return this.guard(() => this.inner.clear(prefix));
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
   * Admits the call or rejects it with `CircuitOpenError`, then races it against the timeout.
   * The first outcome (result, rejection or timeout) settles the call and is recorded once.
   */
  private guard<T>(call: () => Promise<T>): Promise<T> {
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
export function circuitBreaker(
  store: CacheStore,
  options?: CircuitBreakerOptions,
): CircuitBreakerStore {
  return new CircuitBreakerStore(store, options);
}
