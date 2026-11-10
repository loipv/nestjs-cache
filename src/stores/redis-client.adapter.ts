/** Minimal Redis surface the cache needs; implemented over ioredis by `ioredisAdapter`. */
export interface RedisClientAdapter {
  get(key: string): Promise<string | undefined>;
  /** SET key value PX ttlMs */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** GETEX key PX ttlMs */
  getex(key: string, ttlMs: number): Promise<string | undefined>;
  /** An empty list sends no command. */
  unlink(keys: readonly string[]): Promise<void>;
  scan(cursor: string, match: string, count: number): Promise<{ cursor: string; keys: string[] }>;
  /**
   * Optional. SET key value PX ttlMs NX. Resolves `true` when the key was set, `false` when it
   * already existed.
   */
  setIfAbsent?(key: string, value: string, ttlMs: number): Promise<boolean>;
  /**
   * Optional. Deletes `key` only if it holds `value`, atomically. Resolves `true` when it
   * deleted the key.
   */
  deleteIfEquals?(key: string, value: string): Promise<boolean>;
  publish(channel: string, message: string): Promise<void>;
  createSubscriber(): RedisSubscriberAdapter;
}

export interface RedisSubscriberAdapter {
  /**
   * Subscribes to `channel`. If it rejects (for example Redis was unreachable), the adapter
   * should subscribe again once the connection is ready, and a later call retries too.
   */
  subscribe(channel: string, onMessage: (message: string) => void): Promise<void>;
  /**
   * Fires on every 'ready' after the first (the first is the initial connect), and when a
   * subscription that had failed is established later: messages may have been missed meanwhile.
   */
  onReconnect(handler: () => void): void;
  /**
   * Optional. Registers a handler for errors of the dedicated connection (connection errors,
   * failed re-subscribes). Handlers must not throw.
   */
  onError?(handler: (error: unknown) => void): void;
  /** Quits the dedicated connection; calling it again is a no-op. Never rejects. */
  close(): Promise<void>;
}
