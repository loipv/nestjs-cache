import type { CacheStore, InvalidationBus } from './cache-store.interface.js';
import type { RedisClientAdapter } from './redis-client.adapter.js';
import { createRedisBus, toRedisAdapter } from './redis-invalidation-bus.js';
import type { RedisStoreOptions } from './redis-invalidation-bus.js';

export type { RedisStoreOptions } from './redis-invalidation-bus.js';

const SCAN_COUNT = 100;

/** Backslash-escapes `\ * ? [ ]` so a literal can be used inside a Redis MATCH pattern. */
export function escapeGlob(literal: string): string {
  return literal.replace(/[\\*?[\]]/g, '\\$&');
}

export class RedisStore implements CacheStore {
  readonly invalidation: InvalidationBus;
  private readonly adapter: RedisClientAdapter;

  constructor(options: RedisStoreOptions) {
    this.adapter = toRedisAdapter(options.client);
    this.invalidation = createRedisBus(this.adapter, options.channel ?? 'nestjs-cache:invalidate');
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
