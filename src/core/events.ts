export type BreakerState = 'closed' | 'open' | 'half-open';

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
  | 'lock';

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
}

type SinkPayload = { operation: CacheOperation; error: unknown } | { state: BreakerState };

function isBreakerPayload(payload: SinkPayload): payload is { state: BreakerState } {
  return 'state' in payload;
}

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

  /** @internal Builds the sink passed to `CacheStore.bind`; not part of the public API. */
  sinkFor(store: string): CacheEventSink {
    return {
      emit: (event: 'error' | 'breaker', payload: SinkPayload): void => {
        if (event === 'breaker' && isBreakerPayload(payload)) {
          this.emit('breaker', { store, state: payload.state });
        } else if (!isBreakerPayload(payload)) {
          this.emit('error', { store, operation: payload.operation, error: payload.error });
        }
      },
    };
  }
}
