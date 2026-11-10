import type { CacheEventSink } from '../core/events.js';

/**
 * A message announcing that keys were written or removed on one instance.
 * Receivers drop the matching entries from their local (L1) cache.
 *
 * `origin` identifies the publishing instance, so receivers can ignore their
 * own messages. A message carries either exact `keys` or a `prefix`.
 */
export type InvalidationMessage =
  { origin: string; keys: readonly string[] } | { origin: string; prefix: string };

/**
 * Cross-instance channel that keeps local caches in sync (for example Redis
 * Pub/Sub, NATS or Kafka). It only affects the freshness of L1 entries; the
 * data in the shared store is always correct.
 */
export interface InvalidationBus {
  /** Broadcasts a message to every subscribed instance. */
  publish(message: InvalidationMessage): Promise<void>;
  /**
   * Registers the handler that receives messages from the channel. If it rejects, the bus
   * should keep trying to subscribe (for example when its connection becomes ready), and a
   * later call should retry rather than return the same rejection.
   */
  subscribe(handler: (message: InvalidationMessage) => void): Promise<void>;
  /**
   * Registers a handler called after the connection is re-established, or after a
   * subscription that had failed is established later. Messages may have been missed
   * meanwhile, so receivers clear their L1.
   */
  onReconnect(handler: () => void): void;
  /**
   * Optional. Registers a handler for errors the bus handles internally, such as a lost
   * subscriber connection or a failed re-subscribe. `TieredStore` reports them as `error`
   * events with `operation: 'subscribe'`. Handlers must not throw.
   */
  onError?(handler: (error: unknown) => void): void;
  /** Releases the bus connection. Called at shutdown; must be idempotent. */
  close(): Promise<void>;
}

/**
 * Distributed mutual exclusion, used by the cache engine to avoid stampedes across instances.
 */
export interface LockProvider {
  /**
   * Tries to take the lock for `key` for at most `ttlMs` milliseconds (integer >= 1). Returns a
   * handle when acquired, or `undefined` when the lock is held by someone else. Never waits.
   */
  acquire(key: string, ttlMs: number): Promise<LockHandle | undefined>;
}

/** Proof of ownership of an acquired lock. */
export interface LockHandle {
  /**
   * Releases the lock only if it is still ours (it may have expired and been taken by another
   * owner). A second call is a no-op.
   */
  release(): Promise<void>;
}

/**
 * Contract for a cache backend. Values are opaque serialized strings.
 */
export interface CacheStore {
  /** Returns the stored string, or `undefined` for a miss or an expired entry. */
  get(key: string): Promise<string | undefined>;
  /**
   * Stores `value` under `key`.
   *
   * @param ttlMs Time to live in milliseconds; always an integer >= 1.
   */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Removes the given keys. Deleting an unknown key is a no-op. */
  delete(keys: readonly string[]): Promise<void>;
  /**
   * Removes every key that starts with `prefix`. An empty prefix (`''`)
   * removes everything.
   */
  clear(prefix: string): Promise<void>;
  /**
   * Optional. Reads the entry and resets its TTL to `ttlMs` in one step
   * (milliseconds, integer >= 1). Returns `undefined` for a miss. Used from 0.2.
   */
  getAndTouch?(key: string, ttlMs: number): Promise<string | undefined>;
  /**
   * Optional. Distributed lock backed by this store. Absent when the store cannot lock; the
   * engine then falls back to a per-process lock.
   */
  readonly lock?: LockProvider;
  /**
   * Optional bus that `TieredStore` uses to sync L1 caches when this store is
   * the L2.
   */
  readonly invalidation?: InvalidationBus;
  /**
   * Optional. Called once at module init with a sink scoped to this store's
   * name, so the store can report errors it handles internally.
   */
  bind?(events: CacheEventSink): void;
  /** Optional. Called at shutdown to release resources; must be idempotent. */
  close?(): Promise<void>;
}
