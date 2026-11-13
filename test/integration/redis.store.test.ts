import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../../src/core/cache.service.js';
import { CacheModule } from '../../src/module/cache.module.js';
import type { InvalidationMessage } from '../../src/stores/cache-store.interface.js';
import { redisStore } from '../../src/stores/redis.store.js';
import {
  canReachPubSub,
  skipTitle,
  selectedAdapters,
  startAdapter,
  type StartedAdapter,
} from './helpers/adapters.js';
import { startRedis } from './helpers/redis.js';

const PUBSUB = new Map(
  await Promise.all(
    selectedAdapters().map(async (name) => [name, await canReachPubSub(name)] as const),
  ),
);

describe('RedisStore (integration), ioredis standalone only', () => {
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

  /* getMany against a real Redis returns values in input order using exactly one MGET. */
  it('getMany returns the right order with one MGET', async () => {
    const counts = new Map<string, number>();
    const counted = new Proxy(client, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          counts.set(String(prop), (counts.get(String(prop)) ?? 0) + 1);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const store = redisStore({ client: counted });
    await store.setMany([
      { key: 'm:a', value: '1', ttlMs: 5_000 },
      { key: 'm:c', value: '3', ttlMs: 5_000 },
    ]);
    counts.clear();
    expect(await store.getMany(['m:c', 'm:b', 'm:a'])).toEqual(['3', undefined, '1']);
    expect(counts.get('mget')).toBe(1);
    expect(counts.get('get')).toBeUndefined();
    expect(await store.getMany([])).toEqual([]);
    expect(counts.get('mget')).toBe(1);
  });
});

describe.each(selectedAdapters())('RedisStore (integration) on %s', (adapterName) => {
  let redis: StartedAdapter;
  let client: StartedAdapter['client'];

  beforeAll(async () => {
    redis = await startAdapter(adapterName);
    client = redis.client;
  });

  beforeEach(async () => {
    await redis.flush();
  });

  afterAll(async () => {
    await redis.stop();
  });

  it('works end to end with the adapter client', async () => {
    const store = redisStore({ client });
    await store.set('i:a', 'v', 5_000);
    expect(await store.get('i:a')).toBe('v');
    await store.delete(['i:a']);
    expect(await store.get('i:a')).toBeUndefined();
  });

  /* getMany returns values in input order, with a missing key and a duplicate, and [] for []. */
  it('getMany returns the right order', async () => {
    const store = redisStore({ client });
    await store.setMany([
      { key: 'm:a', value: '1', ttlMs: 5_000 },
      { key: 'm:c', value: '3', ttlMs: 5_000 },
    ]);
    expect(await store.getMany(['m:c', 'm:b', 'm:a', 'm:c'])).toEqual(['3', undefined, '1', '3']);
    expect(await store.getMany([])).toEqual([]);
  });

  it('touch extends a live key and never creates a missing one', async () => {
    const store = redisStore({ client });
    await store.set('t:k', 'v', 1_000);
    await store.touch(['t:k', 't:nope'], 60_000);
    expect(await redis.raw.pttl('t:k')).toBeGreaterThan(50_000);
    expect(await redis.raw.pttl('t:nope')).toBe(-2);
    expect(await store.get('t:k')).toBe('v');
  });

  it('setIfAbsent returns true, then false, and keeps the first value', async () => {
    const store = redisStore({ client });
    expect(await store.setIfAbsent?.('t:abs', 'first', 5_000)).toBe(true);
    expect(await store.setIfAbsent?.('t:abs', 'second', 5_000)).toBe(false);
    expect(await store.get('t:abs')).toBe('first');
  });

  it('clear removes only the prefix, including glob characters', async () => {
    const store = redisStore({ client });
    for (let i = 0; i < 250; i += 1) await store.set(`a[1]:${String(i)}`, 'v', 60_000);
    await store.set('a1:x', 'v', 60_000);
    await store.set('b:x', 'v', 60_000);
    await store.clear('a[1]:');
    expect((await redis.raw.keys('*')).sort()).toEqual(['a1:x', 'b:x']);
  });

  it('clear removes 20 000 keys of a prefix and keeps other keys', async () => {
    const store = redisStore({ client });
    for (let start = 0; start < 20_000; start += 1_000) {
      await Promise.all(
        Array.from({ length: 1_000 }, (_, i) =>
          redis.raw.set(`p:k${String(start + i)}`, 'v', 600_000),
        ),
      );
    }
    await redis.raw.set('other:x', 'v', 600_000);
    await store.clear('p:');
    expect(await redis.raw.keys('p:*')).toHaveLength(0);
    expect(await redis.raw.get('other:x')).toBe('v');
  });

  // Skipped where the probe finds the adapter's pub/sub unreachable from this host (ruling T1-B).
  const title = 'carries invalidation messages between two stores';
  const reachable = PUBSUB.get(adapterName) === true;
  it.skipIf(!reachable)(reachable ? title : skipTitle(title), async () => {
    /* Both stores share one client: each store's subscriber is a duplicate of it. */
    const a = redisStore({ client });
    const b = redisStore({ client });
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
