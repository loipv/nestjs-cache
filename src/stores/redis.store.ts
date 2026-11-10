import type { CacheStore, InvalidationBus, LockProvider } from './cache-store.interface.js';
import { RedisLock } from './redis-lock.js';
import type { RedisClientAdapter } from './redis-client.adapter.js';
import { createRedisBus, DEFAULT_CHANNEL, toRedisAdapter } from './redis-invalidation-bus.js';
import type { RedisStoreOptions } from './redis-invalidation-bus.js';

export type { RedisStoreOptions } from './redis-invalidation-bus.js';

const SCAN_COUNT = 100;

/** Backslash-escapes `\ * ? [ ]` so a literal can be used inside a Redis MATCH pattern. */
export function escapeGlob(literal: string): string {
  return literal.replace(/[\\*?[\]]/g, '\\$&');
}

type LockCapable = Required<Pick<RedisClientAdapter, 'setIfAbsent' | 'deleteIfEquals'>>;

function supportsLock(adapter: RedisClientAdapter): adapter is RedisClientAdapter & LockCapable {
  return typeof adapter.setIfAbsent === 'function' && typeof adapter.deleteIfEquals === 'function';
}

export class RedisStore implements CacheStore {
  readonly invalidation: InvalidationBus;
  /** Present only when the adapter implements `setIfAbsent` and `deleteIfEquals`. */
  declare readonly lock?: LockProvider;
  /** Present only when the adapter implements `ping`. */
  declare readonly ping?: () => Promise<void>;
  private readonly adapter: RedisClientAdapter;

  constructor(options: RedisStoreOptions) {
    this.adapter = toRedisAdapter(options.client);
    this.invalidation = createRedisBus(this.adapter, options.channel ?? DEFAULT_CHANNEL);
    if (supportsLock(this.adapter)) this.lock = new RedisLock(this.adapter);
    if (this.adapter.ping !== undefined) {
      const adapter = this.adapter;
      this.ping = () => adapter.ping?.() ?? Promise.resolve();
    }
  }

  get(key: string): Promise<string | undefined> {
    return this.adapter.get(key);
  }

  set(key: string, value: string, ttlMs: number): Promise<void> {
    return this.adapter.set(key, value, ttlMs);
  }

  delete(keys: readonly string[]): Promise<void> {
    return this.adapter.unlink(keys);
  }

  async clear(prefix: string): Promise<void> {
    const match = `${escapeGlob(prefix)}*`;
    let cursor = '0';
    do {
      const page = await this.adapter.scan(cursor, match, SCAN_COUNT);
      cursor = page.cursor;
      if (page.keys.length > 0) await this.adapter.unlink(page.keys);
    } while (cursor !== '0');
  }

  getAndTouch(key: string, ttlMs: number): Promise<string | undefined> {
    return this.adapter.getex(key, ttlMs);
  }

  /** Closes the bus's subscriber connection; the caller's client is left open. */
  close(): Promise<void> {
    return this.invalidation.close();
  }
}

export function redisStore(options: RedisStoreOptions): RedisStore {
  return new RedisStore(options);
}
