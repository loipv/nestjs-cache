import type { CacheStore, InvalidationBus, LockProvider } from './cache-store.interface.js';
import { RedisLock } from './redis-lock.js';
import type { RedisClientAdapter } from './redis-client.adapter.js';
import { createRedisBus, DEFAULT_CHANNEL, toRedisAdapter } from './redis-invalidation-bus.js';
import type { RedisInvalidationBusOptions } from './redis-invalidation-bus.js';

/**
 * Options of `redisStore`: the client and the invalidation channel, the same fields as
 * `RedisInvalidationBusOptions`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- its own name, same fields as the bus options
export interface RedisStoreOptions extends RedisInvalidationBusOptions {}

const SCAN_COUNT = 100;

/** Backslash-escapes `\ * ? [ ]` so a literal can be used inside a Redis MATCH pattern. */
export function escapeGlob(literal: string): string {
  return literal.replace(/[\\*?[\]]/g, '\\$&');
}

type LockCapable = Required<Pick<RedisClientAdapter, 'setIfAbsent' | 'deleteIfEquals'>>;

function supportsLock(adapter: RedisClientAdapter): adapter is RedisClientAdapter & LockCapable {
  return typeof adapter.setIfAbsent === 'function' && typeof adapter.deleteIfEquals === 'function';
}

/**
 * A Redis store over an ioredis client or Cluster, or any `RedisClientAdapter` (node-redis via
 * `nodeRedisAdapter`). It brings a pub/sub invalidation bus on `channel`, and a lock when the
 * adapter can `setIfAbsent` and `deleteIfEquals`. The caller's client is never closed.
 */
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

  getMany(keys: readonly string[]): Promise<(string | undefined)[]> {
    if (keys.length === 0) return Promise.resolve([]);
    if (this.adapter.mget !== undefined) return this.adapter.mget(keys);
    return Promise.all(keys.map((key) => this.adapter.get(key)));
  }

  async setMany(entries: readonly { key: string; value: string; ttlMs: number }[]): Promise<void> {
    await Promise.all(entries.map((e) => this.adapter.set(e.key, e.value, e.ttlMs)));
  }

  delete(keys: readonly string[]): Promise<void> {
    return this.adapter.unlink(keys);
  }

  async clear(prefix: string): Promise<void> {
    const match = `${escapeGlob(prefix)}*`;
    if (this.adapter.scanIterator !== undefined) {
      for await (const keys of this.adapter.scanIterator(match, SCAN_COUNT)) {
        if (keys.length > 0) await this.adapter.unlink(keys);
      }
      return;
    }
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

/** Builds a `RedisStore`; requires Redis 6.2 or later (`GETEX`). */
export function redisStore(options: RedisStoreOptions): RedisStore {
  return new RedisStore(options);
}
