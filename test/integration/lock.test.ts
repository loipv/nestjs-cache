import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IoredisLike } from '../../src/stores/ioredis.adapter.js';
import { redisStore } from '../../src/stores/redis.store.js';
import { startRedis } from './helpers/redis.js';

describe('RedisLock primitives', () => {
  let redis: { url: string; stop(): Promise<void> };
  let client: Redis;

  beforeAll(async () => {
    redis = await startRedis();
    client = new Redis(redis.url);
  });

  beforeEach(async () => {
    await client.flushall();
  });

  afterAll(async () => {
    await client.quit();
    await redis.stop();
  });

  it('acquire, contend, release against real Redis', async () => {
    const store = redisStore({ client });
    const a = await store.lock!.acquire('it:k', 5_000);
    expect(a).toBeDefined();
    expect(await store.lock!.acquire('it:k', 5_000)).toBeUndefined();
    const pttl = await client.pttl('lock:it:k');
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(5_000);
    await a!.release();
    expect(await client.exists('lock:it:k')).toBe(0);
  });

  it('a stale handle does not release a newer owner', async () => {
    const store = redisStore({ client });
    const old = await store.lock!.acquire('it:s', 5_000);
    await client.del('lock:it:s');
    const fresh = await store.lock!.acquire('it:s', 5_000);
    expect(fresh).toBeDefined();
    await old!.release();
    expect(await client.exists('lock:it:s')).toBe(1);
    await fresh!.release();
    expect(await client.exists('lock:it:s')).toBe(0);
  });

  it('a real ioredis client is assignable to IoredisLike without a cast', () => {
    const like: IoredisLike = client;
    expect(like).toBeDefined();
  });
});
