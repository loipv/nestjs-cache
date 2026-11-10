import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CacheService } from '../../src/core/cache.service.js';
import { CacheModule } from '../../src/module/cache.module.js';
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

describe('distributed lock across two apps', () => {
  let redis: { url: string; stop(): Promise<void> };
  const clients: Redis[] = [];
  const refs: TestingModule[] = [];
  let cacheA: CacheService;
  let cacheB: CacheService;

  async function startApp(): Promise<CacheService> {
    const client = new Redis(redis.url);
    clients.push(client);
    const ref = await Test.createTestingModule({
      imports: [
        CacheModule.forRoot({
          stores: { default: redisStore({ client }) },
          defaults: { lock: { enabled: true } },
        }),
      ],
    }).compile();
    await ref.init();
    refs.push(ref);
    return ref.get(CacheService);
  }

  beforeAll(async () => {
    redis = await startRedis();
    cacheA = await startApp();
    cacheB = await startApp();
  });

  afterAll(async () => {
    for (const ref of refs) await ref.close();
    for (const client of clients) await client.quit();
    await redis.stop();
  });

  it('loads once across the cluster when two instances miss together', async () => {
    let calls = 0;
    const loader = async (): Promise<{ n: number }> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { n: 1 };
    };
    const key = 'lock-hot:cluster';
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => cacheA.getOrSet(key, loader)),
      ...Array.from({ length: 5 }, () => cacheB.getOrSet(key, loader)),
    ]);
    expect(calls).toBe(1);
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.n === 1)).toBe(true);
  });
});
