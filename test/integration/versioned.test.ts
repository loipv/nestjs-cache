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
import {
  canReachPubSub,
  skipTitle,
  selectedAdapters,
  startAdapter,
  type StartedAdapter,
} from './helpers/adapters.js';
import { startRedis } from './helpers/redis.js';

const NAMESPACES = { users: { versioned: true } } as const;
const TWENTY_NINE_DAYS = 29 * 24 * 60 * 60 * 1_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startApp(
  store: CacheStore,
  versioning?: { cacheTtl: number },
  logging?: { level: 'off' },
): Promise<{ ref: TestingModule; cache: CacheService }> {
  const ref = await Test.createTestingModule({
    imports: [
      CacheModule.forRoot({
        prefix: 'app',
        namespaces: NAMESPACES,
        ...(versioning === undefined ? {} : { versioning }),
        ...(logging === undefined ? {} : { logging }),
        stores: { default: store },
      }),
    ],
  }).compile();
  await ref.init();
  return { ref, cache: ref.get(CacheService) };
}

async function scanKeys(client: Redis, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', pattern);
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  return found;
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

const PUBSUB = new Map(
  await Promise.all(
    selectedAdapters().map(async (name) => [name, await canReachPubSub(name)] as const),
  ),
);

describe.each(selectedAdapters())('versioned namespaces (integration) on %s', (adapterName) => {
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

  describe('with redisStore', () => {
    let app: { ref: TestingModule; cache: CacheService };

    beforeEach(async () => {
      app = await startApp(redisStore({ client: redis.client }));
    });

    afterEach(async () => {
      await app.ref.close();
    });

    it('clear leaves the old key in Redis but get misses', async () => {
      /* Data lives under app:users@<v>:1; clear writes a new token instead of scanning, so
         the old key still exists in Redis, yet the next get misses. */
      await app.cache.set('1', { n: 1 }, { namespace: 'users' });
      const [oldKey, ...rest] = await redis.raw.keys('app:users@*');
      expect(rest).toEqual([]);
      expect(oldKey).toMatch(/^app:users@[0-9a-z]{8}:1$/);
      expect(await app.cache.get('1', { namespace: 'users' })).toEqual({ n: 1 });
      await app.cache.clear('users');
      expect(await redis.raw.get(oldKey ?? '')).not.toBeNull();
      expect(await app.cache.get('1', { namespace: 'users' })).toBeUndefined();
    });

    it('the version key lives for 30 days', async () => {
      /* app:__version__:users is written with a TTL above 29 days, and again on clear. */
      await app.cache.set('1', 'x', { namespace: 'users' });
      expect(await redis.raw.pttl('app:__version__:users')).toBeGreaterThan(TWENTY_NINE_DAYS);
      const before = await redis.raw.get('app:__version__:users');
      await app.cache.clear('users');
      expect(await redis.raw.get('app:__version__:users')).not.toBe(before);
      expect(await redis.raw.pttl('app:__version__:users')).toBeGreaterThan(TWENTY_NINE_DAYS);
    });
  });

  // Two tiered stores sync over pub/sub: skipped where the probe finds it unreachable (ruling T1-B).
  const reachable = PUBSUB.get(adapterName) === true;
  const tieredTitle = 'with two tieredStore instances';
  describe.skipIf(!reachable)(reachable ? tieredTitle : skipTitle(tieredTitle), () => {
    let apps: { ref: TestingModule; cache: CacheService }[];

    beforeEach(async () => {
      apps = [];
      for (let i = 0; i < 2; i += 1) {
        const store = tieredStore({
          l1: memoryStore(),
          l2: redisStore({ client: redis.client }),
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
    });

    it("B sees A's clear once cacheTtl has passed", async () => {
      /* B caches the version for 200 ms. After A clears, B misses within 250 ms on the real
         clock: its version cache expired and pub/sub dropped the version key from its L1. */
      const [a, b] = apps.map((app) => app.cache) as [CacheService, CacheService];
      await a.set('1', { n: 1 }, { namespace: 'users' });
      const [oldKey] = await redis.raw.keys('app:users@*');
      expect(oldKey).toMatch(/^app:users@[0-9a-z]{8}:1$/);
      expect(await b.get('1', { namespace: 'users' })).toEqual({ n: 1 });
      await a.clear('users');
      expect(await a.get('1', { namespace: 'users' })).toBeUndefined();
      // clear only writes a new token: the old data key is still in Redis (0.3 deleted it)
      expect(await redis.raw.get(oldKey ?? '')).not.toBeNull();
      await pause(250);
      expect(await b.get('1', { namespace: 'users' })).toBeUndefined();
    });
  });
});

describe('versioned namespaces (integration), ioredis standalone only', () => {
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

  describe('with a tiered store over a paused Redis', () => {
    it('a tiered versioned namespace keeps its token while Redis is paused', async () => {
      /* R5: the namespace was read once (token T). Once cacheTtl and l1Ttl have passed, Redis
         is paused, so every command times out. getOrSet still resolves with the loader value,
         and no new token is written: after the pause the version key is still T and it is the
         only version key. */
      const client = new Redis(redis.url, { commandTimeout: 100 });
      client.on('error', () => undefined);
      const store = tieredStore({ l1: memoryStore(), l2: redisStore({ client }), l1Ttl: 200 });
      const app = await startApp(store, { cacheTtl: 50 }, { level: 'off' });
      try {
        const options = { namespace: 'users' };
        expect(await app.cache.getOrSet('1', async () => 'warm', options)).toBe('warm');
        const token = await admin.get('app:__version__:users');
        expect(token).toMatch(/^[0-9a-z]{8}$/);
        await pause(250);
        await admin.call('CLIENT', 'PAUSE', '1500', 'ALL');
        const resumesAt = Date.now() + 1_500;
        await expect(app.cache.getOrSet('1', async () => 'during', options)).resolves.toBe(
          'during',
        );
        await pause(Math.max(0, resumesAt - Date.now()) + 100);
        expect(await admin.get('app:__version__:users')).toBe(token);
        expect(await scanKeys(admin, '*__version__*')).toEqual(['app:__version__:users']);
      } finally {
        await app.ref.close();
        await client.quit();
      }
    });
  });
});
