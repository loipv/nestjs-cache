import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CacheHealthIndicator } from '../../src/health/cache-health.indicator.js';
import { CacheModule } from '../../src/module/cache.module.js';
import { redisStore } from '../../src/stores/redis.store.js';
import { startRedis } from './helpers/redis.js';

describe('CacheHealthIndicator against a real Redis (integration)', () => {
  let redis: { url: string; stop(): Promise<void> };
  let client: Redis;
  let ref: TestingModule;

  beforeAll(async () => {
    redis = await startRedis();
    client = new Redis(redis.url, { maxRetriesPerRequest: 1 });
    client.on('error', () => undefined);
    ref = await Test.createTestingModule({
      imports: [
        CacheModule.forRoot({ isGlobal: true, stores: { default: redisStore({ client }) } }),
      ],
    }).compile();
    await ref.init();
  });

  afterAll(async () => {
    await ref.close();
    // no quit() on a dead connection
    client.disconnect();
    await redis.stop().catch(() => undefined);
  });

  it('reports up against a live Redis, then down after it stops', async () => {
    const health = ref.get(CacheHealthIndicator);
    expect(await health.check('cache')).toEqual({ cache: { status: 'up' } });

    await redis.stop();
    const started = Date.now();
    const result = await health.check('cache', { timeout: 500 });
    expect(result.cache.status).toBe('down');
    expect(Date.now() - started).toBeLessThan(1_500);
    const message = (result.cache as { message?: unknown }).message;
    expect(typeof message).toBe('string');
    expect((message as string).length).toBeGreaterThan(0);
  });
});
