export type BreakerState = 'closed' | 'open' | 'half-open';

/** How much the library logs: nothing, errors and warnings (the default), or also one debug line per event. */
export type CacheLogLevel = 'off' | 'error' | 'debug';

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
  /** Only used in logs, for a failing metrics update; an `error` event never carries it. */
  | 'metrics';

export interface CacheEventMap {
  hit: { store: string; namespace: string | undefined; key: string; stale: boolean };
  miss: { store: string; namespace: string | undefined; key: string };
  set: { store: string; namespace: string | undefined; key: string; ttl: number };
  delete: { store: string; namespace: string | undefined; keys: readonly string[] };
  clear: { store: string; namespace: string };
  load: {
    store: string;
    namespace: string | undefined;
    key: string;
    /** Only on a batch load (`getOrSetMany`): every key passed to the loader; `key` is the first. */
    keys?: readonly string[];
    durationMs: number;
    success: boolean;
  };
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

export class CacheEvents {
  private readonly listeners = new Map<keyof CacheEventMap, Set<{ fn: unknown }>>();

  constructor(private readonly onListenerError?: (error: unknown) => void) {}

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
