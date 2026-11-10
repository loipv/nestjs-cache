import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CacheService } from '../../src/core/cache.service.js';
import { CacheModule } from '../../src/module/cache.module.js';
import { redisStore } from '../../src/stores/redis.store.js';
import { startRedis } from './helpers/redis.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('sliding TTL via GETEX (integration)', () => {
  let redis: { url: string; stop(): Promise<void> };
  let client: Redis;
  let ref: TestingModule;
  let cache: CacheService;

  beforeAll(async () => {
    redis = await startRedis();
    client = new Redis(redis.url);
    ref = await Test.createTestingModule({
      imports: [
        CacheModule.forRoot({
          stores: { default: redisStore({ client }) },
          defaults: { ttl: 1_000 },
        }),
      ],
    }).compile();
    await ref.init();
    cache = ref.get(CacheService);
  });

  afterAll(async () => {
    await ref.close();
    await client.quit();
    await redis.stop();
  });

  it('GETEX extends the TTL on every sliding read', async () => {
    await cache.set('s', 'v', { strategy: 'sliding' });
    await sleep(600);
    expect(await cache.get('s', { strategy: 'sliding' })).toBe('v');
    expect(await client.pttl('s')).toBeGreaterThan(600);
    await sleep(600);
    expect(await cache.get('s', { strategy: 'sliding' })).toBe('v');
  });

  it('an untouched sliding entry expires', async () => {
    await cache.set('s2', 'v', { strategy: 'sliding', ttl: 500 });
    await sleep(700);
    expect(await cache.get('s2', { strategy: 'sliding' })).toBeUndefined();
  });
});
