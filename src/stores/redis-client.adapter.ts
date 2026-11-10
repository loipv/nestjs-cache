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
  publish(channel: string, message: string): Promise<void>;
  createSubscriber(): RedisSubscriberAdapter;
}

export interface RedisSubscriberAdapter {
  subscribe(channel: string, onMessage: (message: string) => void): Promise<void>;
  /** Fires on every 'ready' after the first (the first is the initial connect). */
  onReconnect(handler: () => void): void;
  /** Quits the dedicated connection; calling it again is a no-op. */
  close(): Promise<void>;
}
