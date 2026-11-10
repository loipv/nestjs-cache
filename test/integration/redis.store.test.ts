import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../../src/core/cache.service.js';
import { CacheModule } from '../../src/module/cache.module.js';
import type { InvalidationMessage } from '../../src/stores/cache-store.interface.js';
import { redisStore } from '../../src/stores/redis.store.js';
import { startRedis } from './helpers/redis.js';

describe('RedisStore (integration)', () => {
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

  it('works end to end with a raw ioredis client', async () => {
    const store = redisStore({ client });
    await store.set('i:a', 'v', 5_000);
    expect(await store.get('i:a')).toBe('v');
    await store.delete(['i:a']);
    expect(await store.get('i:a')).toBeUndefined();
  });

  it('clear removes only the prefix, including glob characters', async () => {
    const store = redisStore({ client });
    for (let i = 0; i < 250; i += 1) await store.set(`a[1]:${i}`, 'v', 60_000);
    await store.set('a1:x', 'v', 60_000);
    await store.set('b:x', 'v', 60_000);
    await store.clear('a[1]:');
    expect((await client.keys('*')).sort()).toEqual(['a1:x', 'b:x']);
  });

  it('carries invalidation messages between two stores', async () => {
    const other = new Redis(redis.url);
    const a = redisStore({ client });
    const b = redisStore({ client: other });
    const got: InvalidationMessage[] = [];
    try {
      await b.invalidation.subscribe((m) => got.push(m));
      await a.invalidation.publish({ origin: 'a', keys: ['k'] });
      await vi.waitFor(() => {
        expect(got).toEqual([{ origin: 'a', keys: ['k'] }]);
      });
    } finally {
      await a.close();
      await b.close();
      await other.quit();
    }
  });

  it('drives CacheModule with a Redis default store', async () => {
    const ref = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ stores: { default: redisStore({ client }) } })],
    }).compile();
    await ref.init();
    const cache = ref.get(CacheService);
    const loader = vi.fn(() => Promise.resolve('loaded'));
    expect(await cache.getOrSet('m:k', loader)).toBe('loaded');
    expect(await cache.getOrSet('m:k', loader)).toBe('loaded');
    expect(loader).toHaveBeenCalledTimes(1);
    await ref.close();
  });
});
