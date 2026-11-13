import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ioredisAdapter, isRedisClientAdapter } from '../../src/stores/ioredis.adapter.js';
import type { RedisClientAdapter } from '../../src/stores/redis-client.adapter.js';
import { startRedis } from './helpers/redis.js';

describe('ioredisAdapter', () => {
  let redis: { url: string; stop(): Promise<void> };
  let client: Redis;
  let adapter: RedisClientAdapter;

  beforeAll(async () => {
    redis = await startRedis();
    client = new Redis(redis.url);
    adapter = ioredisAdapter(client);
  });

  beforeEach(async () => {
    await client.flushall();
  });

  afterAll(async () => {
    await client.quit();
    await redis.stop();
  });

  it('accepts a real ioredis client without a cast', () => {
    const typed: RedisClientAdapter = ioredisAdapter(client);
    expect(typed).toBeDefined();
  });

  it('set stores with a millisecond TTL', async () => {
    await adapter.set('a', 'v', 5_000);
    expect(await adapter.get('a')).toBe('v');
    const pttl = await client.pttl('a');
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(5_000);
  });

  it('setMany writes 100 entries with a TTL', async () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      key: `m${String(i)}`,
      value: `v${String(i)}`,
      ttlMs: 60_000,
    }));
    await adapter.setMany?.(entries);
    for (const e of entries) {
      expect(await client.get(e.key)).toBe(e.value);
      expect(await client.pttl(e.key)).toBeGreaterThan(0);
    }
  });

  it('get returns undefined for a missing key', async () => {
    expect(await adapter.get('nope')).toBeUndefined();
  });

  it('getex returns the value and resets the TTL', async () => {
    await adapter.set('b', 'v', 1_000);
    expect(await adapter.getex('b', 60_000)).toBe('v');
    expect(await client.pttl('b')).toBeGreaterThan(1_000);
    expect(await adapter.getex('nope', 1_000)).toBeUndefined();
  });

  it('unlink removes several keys and ignores an empty list', async () => {
    await adapter.set('c1', 'v', 5_000);
    await adapter.set('c2', 'v', 5_000);
    await adapter.unlink(['c1', 'c2']);
    await adapter.unlink([]);
    expect(await adapter.get('c1')).toBeUndefined();
    expect(await adapter.get('c2')).toBeUndefined();
  });

  it('scan walks every matching key', async () => {
    for (let i = 0; i < 250; i++) await adapter.set(`scan:${i}`, 'v', 60_000);
    for (let i = 0; i < 5; i++) await adapter.set(`other:${i}`, 'v', 60_000);
    const found = new Set<string>();
    let cursor = '0';
    do {
      const page = await adapter.scan(cursor, 'scan:*', 100);
      page.keys.forEach((k) => found.add(k));
      cursor = page.cursor;
    } while (cursor !== '0');
    expect(found).toEqual(new Set(Array.from({ length: 250 }, (_, i) => `scan:${i}`)));
  });

  it('delivers published messages to a subscriber', async () => {
    const sub = adapter.createSubscriber();
    const got: string[] = [];
    await sub.subscribe('chan', (m) => {
      got.push(m);
    });
    await adapter.publish('chan', 'hello');
    await vi.waitFor(() => {
      expect(got).toEqual(['hello']);
    });
    await sub.close();
    await sub.close();
    expect(client.status).toBe('ready');
  });

  it('recognises adapters', () => {
    expect(isRedisClientAdapter(adapter)).toBe(true);
    expect(isRedisClientAdapter(client)).toBe(false);
  });
});
