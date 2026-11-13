/** The state of a `CircuitBreakerStore`, as `breaker` events report it. */
export type BreakerState = 'closed' | 'open' | 'half-open';

/** How much the library logs: nothing, errors and warnings (the default), or also one debug line per event. */
export type CacheLogLevel = 'off' | 'error' | 'debug';

/**
 * The operation an `error` event reports as failed.
 *
 * Provided by the library. New members, events, fields or values may be added in a minor release;
 * handle unknown ones.
 */
export type CacheOperation =
  | 'get'
  | 'set'
  | 'delete'
  | 'clear'
  | 'deserialize'
  | 'key'
  | 'publish'
  | 'subscribe'
  | 'refresh'
  | 'lock'
  | 'version'
  /** An invalid tag list (a throwing tag callback included); the entry is not written. */
  | 'tag'
  /** A background refresh of version token key TTLs (`store.touch`) failed; no call fails. */
  | 'touch';

/**
 * Internal: the operations `CacheLogger` logs; `'metrics'` is a failing metrics update and
 * `'tracing'` a throwing tracer or span method.
 */
export type LogOperation = CacheOperation | 'metrics' | 'tracing';

/** Internal: reports a cache failure as an `error` event; `EngineIO.reportError`. */
export type ReportError = (
  store: string | undefined,
  operation: CacheOperation,
  error: unknown,
) => void;

/**
 * The payload of each `CacheEvents` event. `store` is the store name; `key` and `keys` are the
 * user keys, without the prefix, namespace or version token.
 *
 * Provided by the library. New members, events, fields or values may be added in a minor release;
 * handle unknown ones.
 */
export interface CacheEventMap {
  /** A read found the entry; `stale` is an `swr` entry past its `ttl`. */
  hit: { store: string; namespace: string | undefined; key: string; stale: boolean };
  miss: { store: string; namespace: string | undefined; key: string };
  set: {
    store: string;
    namespace: string | undefined;
    key: string;
    /**
     * The TTL the store was given, in ms: under `swr` it includes `staleTtl`, and it carries the
     * `defaults.jitter` (not under `sliding`).
     */
    ttl: number;
  };
  delete: {
    store: string;
    namespace: string | undefined;
    /** The user keys deleted, as passed (not the store keys). */
    keys: readonly string[];
  };
  clear: { store: string; namespace: string };
  /** One loader call finished (`success: false` when it threw). */
  load: {
    store: string;
    namespace: string | undefined;
    /** The loaded key; on a batch load, the first of `keys`. */
    key: string;
    /** Only on a batch load (`getOrSetMany`): every key passed to the loader; `key` is the first. */
    keys?: readonly string[];
    durationMs: number;
    success: boolean;
  };
  /** A cache failure the call did not surface; see `CacheOperation`. */
  error: { store: string; operation: CacheOperation; error: unknown };
  lock: {
    store: string;
    namespace: string | undefined;
    key: string;
    waitedMs: number;
    acquired: boolean;
  };
  breaker: { store: string; state: BreakerState };
}

/**
 * What a store gets from `CacheStore.bind`: it reports its own failures (`error`) and breaker
 * state changes (`breaker`) through it; the module adds the store name.
 *
 * Provided by the library. New members, events, fields or values may be added in a minor release;
 * handle unknown ones.
 */
export interface CacheEventSink {
  emit(event: 'error', payload: { operation: CacheOperation; error: unknown }): void;
  emit(event: 'breaker', payload: { state: BreakerState }): void;
  /**
   * The module's log level, so a store can skip its own warnings at `'off'`. Sinks from
   * `CacheModule` always set it; a missing value (a hand-built sink) means `'error'`.
   */
  readonly logLevel?: CacheLogLevel;
}

/** One tuple per sink overload, so the event name narrows its payload. */
type SinkArgs =
  | [event: 'error', payload: { operation: CacheOperation; error: unknown }]
  | [event: 'breaker', payload: { state: BreakerState }];

type Listener<E extends keyof CacheEventMap> = (payload: CacheEventMap[E]) => void;

/**
 * The cache event bus, provided by `CacheModule`: inject it and subscribe with `on`. Only the
 * library emits events.
 *
 * Created by Nest; inject it, do not construct it. Constructor parameters are not part of the
 * public API.
 */
export class CacheEvents {
  private readonly listeners = new Map<keyof CacheEventMap, Set<{ fn: unknown }>>();

  constructor(private readonly onListenerError?: (error: unknown) => void) {}

  /**
   * Calls `listener` with the payload of every `event`, synchronously, in registration order.
   * A listener that throws is isolated: the module logs it (unless `logging.level` is `'off'`)
   * and it never reaches the cache call. Returns a function that removes this registration.
   */
  on<E extends keyof CacheEventMap>(event: E, listener: Listener<E>): () => void {
    // A fresh entry object per registration keeps duplicates of the same function distinct.
    const entry = { fn: listener as unknown };
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(entry);
    return () => {
      this.listeners.get(event)?.delete(entry);
    };
  }

  /** @internal Used by the library to publish events; not part of the public API. */
  emit<E extends keyof CacheEventMap>(event: E, payload: CacheEventMap[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const entry of [...set]) {
      try {
        (entry.fn as Listener<E>)(payload);
      } catch (error) {
        try {
          this.onListenerError?.(error);
        } catch {
          // a failing error handler must never reach the emitter
        }
      }
    }
  }

  /**
   * @internal Builds the sink passed to `CacheStore.bind`; not part of the public API.
   * The event name alone picks the event; the overloads tie each name to its payload.
   */
  sinkFor(store: string, logLevel: CacheLogLevel = 'error'): CacheEventSink {
    return {
      logLevel,
      emit: (...[event, payload]: SinkArgs): void => {
        switch (event) {
          case 'error':
            this.emit('error', { store, operation: payload.operation, error: payload.error });
            return;
          case 'breaker':
            this.emit('breaker', { store, state: payload.state });
            return;
          default: {
            // Unreachable for typed callers; an untyped store's unknown event is ignored.
            const unreachable: never = event;
            return unreachable;
          }
        }
      },
    };
  }
}
