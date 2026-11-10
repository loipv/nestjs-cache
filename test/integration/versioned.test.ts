import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CacheService } from '../../src/core/cache.service.js';
import { CacheModule } from '../../src/module/cache.module.js';
import type { CacheStore } from '../../src/stores/cache-store.interface.js';
import { memoryStore } from '../../src/stores/memory.store.js';
import { redisStore } from '../../src/stores/redis.store.js';
import { tieredStore } from '../../src/stores/tiered.store.js';
import { startRedis } from './helpers/redis.js';

const NAMESPACES = { users: { versioned: true } } as const;
const TWENTY_NINE_DAYS = 29 * 24 * 60 * 60 * 1_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startApp(
  store: CacheStore,
  versioning?: { cacheTtl: number },
): Promise<{ ref: TestingModule; cache: CacheService }> {
  const ref = await Test.createTestingModule({
    imports: [
      CacheModule.forRoot({
        prefix: 'app',
        namespaces: NAMESPACES,
        ...(versioning === undefined ? {} : { versioning }),
        stores: { default: store },
      }),
    ],
  }).compile();
  await ref.init();
  return { ref, cache: ref.get(CacheService) };
}

/** Waits until `to` drops an L1 entry when `from` deletes it: pub/sub starts in the background. */
async function waitForSync(from: CacheService, to: CacheService): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (let i = 0; Date.now() < deadline; i += 1) {
    const key = `sync-probe:${String(i)}`;
    await from.set(key, i);
    expect(await to.get(key)).toBe(i);
    await from.delete(key);
    await pause(50);
    if ((await to.get(key)) === undefined) return;
  }
  throw new Error('instances did not sync within 5 s');
}

describe('versioned namespaces (integration)', () => {
  let redis: { url: string; stop(): Promise<void> };
  let admin: Redis;

  beforeAll(async () => {
    redis = await startRedis();
    admin = new Redis(redis.url);
  });

  beforeEach(async () => {
    await admin.flushall();
  });

  afterAll(async () => {
    await admin.quit();
    await redis.stop();
  });

  describe('with redisStore', () => {
    let client: Redis;
    let app: { ref: TestingModule; cache: CacheService };

    beforeEach(async () => {
      client = new Redis(redis.url);
      app = await startApp(redisStore({ client }));
    });

    afterEach(async () => {
      await app.ref.close();
      await client.quit();
    });

    it('clear leaves the old key in Redis but get misses', async () => {
      /* Data lives under app:users@<v>:1; clear writes a new token instead of scanning, so
         the old key still exists in Redis, yet the next get misses. */
      await app.cache.set('1', { n: 1 }, { namespace: 'users' });
      const [oldKey, ...rest] = await admin.keys('app:users@*');
      expect(rest).toEqual([]);
      expect(oldKey).toMatch(/^app:users@[0-9a-z]{8}:1$/);
      expect(await app.cache.get('1', { namespace: 'users' })).toEqual({ n: 1 });
      await app.cache.clear('users');
      expect(await admin.exists(oldKey ?? '')).toBe(1);
      expect(await app.cache.get('1', { namespace: 'users' })).toBeUndefined();
    });

    it('the version key lives for 30 days', async () => {
      /* app:__version__:users is written with a TTL above 29 days, and again on clear. */
      await app.cache.set('1', 'x', { namespace: 'users' });
      expect(await admin.pttl('app:__version__:users')).toBeGreaterThan(TWENTY_NINE_DAYS);
      const before = await admin.get('app:__version__:users');
      await app.cache.clear('users');
      expect(await admin.get('app:__version__:users')).not.toBe(before);
      expect(await admin.pttl('app:__version__:users')).toBeGreaterThan(TWENTY_NINE_DAYS);
    });
  });

  describe('with two tieredStore instances', () => {
    let clients: Redis[];
    let apps: { ref: TestingModule; cache: CacheService }[];

    beforeEach(async () => {
      clients = [new Redis(redis.url), new Redis(redis.url)];
      apps = [];
      for (const client of clients) {
        const store = tieredStore({
          l1: memoryStore(),
          l2: redisStore({ client }),
          l1Ttl: 60_000,
        });
        apps.push(await startApp(store, { cacheTtl: 200 }));
      }
      const [a, b] = apps.map((app) => app.cache) as [CacheService, CacheService];
      await waitForSync(a, b);
      await waitForSync(b, a);
    });

    afterEach(async () => {
      for (const app of apps) await app.ref.close();
      for (const client of clients) await client.quit();
    });

    it("B sees A's clear once cacheTtl has passed", async () => {
      /* B caches the version for 200 ms. After A clears, B misses within 250 ms on the real
         clock: its version cache expired and pub/sub dropped the version key from its L1. */
      const [a, b] = apps.map((app) => app.cache) as [CacheService, CacheService];
      await a.set('1', { n: 1 }, { namespace: 'users' });
      expect(await b.get('1', { namespace: 'users' })).toEqual({ n: 1 });
      await a.clear('users');
      expect(await a.get('1', { namespace: 'users' })).toBeUndefined();
      await pause(250);
      expect(await b.get('1', { namespace: 'users' })).toBeUndefined();
    });
  });
});
