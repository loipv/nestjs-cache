import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CacheService } from '../../src/core/cache.service.js';
import { CacheModule } from '../../src/module/cache.module.js';
import type { IoredisLike } from '../../src/stores/ioredis.adapter.js';
import { redisStore } from '../../src/stores/redis.store.js';
import { selectedAdapters, startAdapter, type StartedAdapter } from './helpers/adapters.js';

/** Runs every step in order; each later step runs in a `finally`, so one failure leaks nothing. */
async function closeAll(steps: readonly (() => Promise<unknown>)[]): Promise<void> {
  const [first, ...rest] = steps;
  if (first === undefined) return;
  try {
    await first();
  } finally {
    await closeAll(rest);
  }
}

describe.each(selectedAdapters())('RedisLock primitives on %s', (adapterName) => {
  let redis: StartedAdapter;

  beforeAll(async () => {
    redis = await startAdapter(adapterName);
  });

  beforeEach(async () => {
    await redis.flush();
  });

  afterAll(async () => {
    await redis.stop();
  });

  it('acquire, contend, release against real Redis', async () => {
    const store = redisStore({ client: redis.client });
    const a = await store.lock!.acquire('app:__lock__:it:k', 5_000);
    expect(a).toBeDefined();
    expect(await store.lock!.acquire('app:__lock__:it:k', 5_000)).toBeUndefined();
    const pttl = await redis.raw.pttl('app:__lock__:it:k');
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(5_000);
    await a!.release();
    expect(await redis.raw.get('app:__lock__:it:k')).toBeNull();
  });

  it('a stale handle does not release a newer owner', async () => {
    const store = redisStore({ client: redis.client });
    const old = await store.lock!.acquire('app:__lock__:it:s', 5_000);
    await redis.raw.del('app:__lock__:it:s');
    const fresh = await store.lock!.acquire('app:__lock__:it:s', 5_000);
    expect(fresh).toBeDefined();
    await old!.release();
    expect(await redis.raw.get('app:__lock__:it:s')).not.toBeNull();
    await fresh!.release();
    expect(await redis.raw.get('app:__lock__:it:s')).toBeNull();
  });
});

describe('RedisLock typing, ioredis only', () => {
  it('a real ioredis client is assignable to IoredisLike without a cast', () => {
    const client = new Redis({ lazyConnect: true });
    const like: IoredisLike = client;
    expect(like).toBeDefined();
    client.disconnect();
  });
});

describe.each(selectedAdapters())('distributed lock across two apps on %s', (adapterName) => {
  let redis: StartedAdapter;
  const refs: TestingModule[] = [];
  let cacheA: CacheService;
  let cacheB: CacheService;

  async function startApp(): Promise<CacheService> {
    const ref = await Test.createTestingModule({
      imports: [
        CacheModule.forRoot({
          stores: { default: redisStore({ client: redis.client }) },
          defaults: { lock: { enabled: true } },
        }),
      ],
    }).compile();
    await ref.init();
    refs.push(ref);
    return ref.get(CacheService);
  }

  beforeAll(async () => {
    redis = await startAdapter(adapterName);
    await redis.flush(); // the cluster container is shared between the cluster adapters
    cacheA = await startApp();
    cacheB = await startApp();
  });

  afterAll(async () => {
    await closeAll([...refs.map((ref) => () => ref.close()), () => redis.stop()]);
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
