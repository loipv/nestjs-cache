import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CacheEvents } from '../../src/core/events.js';
import type { BreakerState } from '../../src/core/events.js';
import { CacheService } from '../../src/core/cache.service.js';
import { CacheModule } from '../../src/module/cache.module.js';
import { circuitBreaker } from '../../src/resilience/circuit-breaker.store.js';
import { redisStore } from '../../src/stores/redis.store.js';
import { startRedis } from './helpers/redis.js';

describe('circuit breaker with a stopped Redis (integration)', () => {
  let redis: { url: string; stop(): Promise<void> };
  let client: Redis;
  let ref: TestingModule;
  let cache: CacheService;
  let events: CacheEvents;

  beforeAll(async () => {
    redis = await startRedis();
    client = new Redis(redis.url, { maxRetriesPerRequest: 1 });
    client.on('error', () => undefined);
    ref = await Test.createTestingModule({
      imports: [
        CacheModule.forRoot({
          stores: {
            default: circuitBreaker(redisStore({ client }), {
              failureThreshold: 2,
              timeout: 200,
              openDuration: 60_000,
            }),
          },
        }),
      ],
    }).compile();
    await ref.init();
    cache = ref.get(CacheService);
    events = ref.get(CacheEvents);
  });

  afterAll(async () => {
    await ref.close();
    client.disconnect();
    // redis was stopped by the test; stopping again is a no-op or harmless
    await redis.stop().catch(() => undefined);
  });

  it('keeps answering and opens the circuit when Redis stops', async () => {
    expect(await cache.getOrSet('warm', async () => 'w')).toBe('w');

    const states: BreakerState[] = [];
    const errors: { operation: string }[] = [];
    events.on('breaker', (e) => states.push(e.state));
    events.on('error', (e) => errors.push({ operation: e.operation }));

    await redis.stop();

    expect(await cache.getOrSet('k1', async () => 'v1')).toBe('v1');
    expect(await cache.getOrSet('k2', async () => 'v2')).toBe('v2');
    const started = Date.now();
    expect(await cache.getOrSet('k3', async () => 'v3')).toBe('v3');
    expect(Date.now() - started).toBeLessThan(100);

    expect(states).toContain('open');
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.operation === 'get' || e.operation === 'set')).toBe(true);
  });
});
