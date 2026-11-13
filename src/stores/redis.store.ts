import type { CacheStore, InvalidationBus, LockProvider } from './cache-store.interface.js';
import { RedisLock } from './redis-lock.js';
import type { RedisClientAdapter } from './redis-client.adapter.js';
import { createRedisBus, DEFAULT_CHANNEL, toRedisAdapter } from './redis-invalidation-bus.js';
import type { RedisInvalidationBusOptions } from './redis-invalidation-bus.js';
import { unlinkPages } from './unlink-pages.js';

/**
 * Options of `redisStore`: the client and the invalidation channel, the same fields as
 * `RedisInvalidationBusOptions`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- its own name, same fields as the bus options
export interface RedisStoreOptions extends RedisInvalidationBusOptions {}

const SCAN_COUNT = 1_000;
const UNLINK_CONCURRENCY = 4;

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
  /** Present only when the adapter implements `setIfAbsent`. */
  declare readonly setIfAbsent?: (key: string, value: string, ttlMs: number) => Promise<boolean>;
  private readonly adapter: RedisClientAdapter;

  constructor(options: RedisStoreOptions) {
    this.adapter = toRedisAdapter(options.client);
    this.invalidation = createRedisBus(this.adapter, options.channel ?? DEFAULT_CHANNEL);
    if (supportsLock(this.adapter)) this.lock = new RedisLock(this.adapter);
    if (this.adapter.setIfAbsent !== undefined) {
      const setIfAbsent = this.adapter.setIfAbsent.bind(this.adapter);
      this.setIfAbsent = (key, value, ttlMs) => setIfAbsent(key, value, ttlMs);
    }
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

  /** Scans `prefix*` and unlinks each page while the scan goes on, with up to `UNLINK_CONCURRENCY` in flight. */
  async clear(prefix: string): Promise<void> {
    const match = `${escapeGlob(prefix)}*`;
    const adapter = this.adapter;
    const pages: AsyncIterable<string[]> =
      adapter.scanIterator !== undefined
        ? adapter.scanIterator(match, SCAN_COUNT)
        : (async function* (): AsyncGenerator<string[]> {
            let cursor = '0';
            do {
              const page = await adapter.scan(cursor, match, SCAN_COUNT);
              cursor = page.cursor;
              yield page.keys;
            } while (cursor !== '0');
          })();
    await unlinkPages(pages, (keys) => adapter.unlink(keys), UNLINK_CONCURRENCY);
  }

  getAndTouch(key: string, ttlMs: number): Promise<string | undefined> {
    return this.adapter.getex(key, ttlMs);
  }

  /** One `GETEX` per key, in parallel; the values are ignored and a missing key is not created. */
  async touch(keys: readonly string[], ttlMs: number): Promise<void> {
    await Promise.all(keys.map((key) => this.adapter.getex(key, ttlMs)));
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
