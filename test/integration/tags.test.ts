import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
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

const NAMESPACES = { users: {}, orders: {} } as const;

interface App {
  ref: TestingModule;
  cache: CacheService;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startApp(store: CacheStore, cacheTtl: number): Promise<App> {
  const ref = await Test.createTestingModule({
    imports: [
      CacheModule.forRoot({
        prefix: 'app',
        namespaces: NAMESPACES,
        versioning: { cacheTtl },
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

/** Counts loader calls and returns the call number as the value. */
function counter(): { load: () => Promise<number>; calls: () => number } {
  let n = 0;
  return {
    load: () => Promise.resolve((n += 1)),
    calls: () => n,
  };
}

/** Polls `getOrSet` until the loader runs again (a miss), for up to 1 s. */
async function missesWithin(
  cache: CacheService,
  key: string,
  tags: string[],
  load: ReturnType<typeof counter>,
  namespace?: string,
): Promise<boolean> {
  const deadline = Date.now() + 1_000;
  const before = load.calls();
  while (Date.now() < deadline) {
    await cache.getOrSet(key, load.load, {
      tags,
      ...(namespace === undefined ? {} : { namespace }),
    });
    if (load.calls() > before) return true;
    await pause(25);
  }
  return false;
}

const PUBSUB = new Map(
  await Promise.all(
    selectedAdapters().map(async (name) => [name, await canReachPubSub(name)] as const),
  ),
);

describe.each(selectedAdapters())('cache tags (integration) on %s', (adapterName) => {
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

  describe('with two redisStore apps', () => {
    let apps: App[];

    beforeEach(async () => {
      apps = [];
      for (let i = 0; i < 2; i += 1) {
        apps.push(await startApp(redisStore({ client: redis.client }), 50));
      }
    });

    afterEach(async () => {
      for (const app of apps) await app.ref.close();
    });

    it('invalidateTags on instance A: A misses at once, B misses within cacheTtl', async () => {
      /* Both apps share Redis with cacheTtl 50 ms. B caches the tag token, A invalidates the
         tag: A's next getOrSet runs the loader at once, B's runs it within cacheTtl (polled). */
      const [a, b] = apps.map((app) => app.cache) as [CacheService, CacheService];
      const loadA = counter();
      const loadB = counter();
      const options = { tags: ['user:7'] };
      /* Separate keys: A's reload of its own key would overwrite what B reads. */
      expect(await a.getOrSet('ka', loadA.load, options)).toBe(1);
      expect(await a.getOrSet('kb', loadA.load, options)).toBe(2);
      expect(await b.getOrSet('kb', loadB.load, options)).toBe(2);
      expect(loadB.calls()).toBe(0);
      await a.invalidateTags(['user:7']);
      expect(await a.getOrSet('ka', loadA.load, options)).toBe(3);
      expect(await missesWithin(b, 'kb', ['user:7'], loadB)).toBe(true);
    });

    it('a tag spanning two namespaces: one invalidation misses both, others stay', async () => {
      /* The tag user:7 stamps an entry in users and one in orders; a third entry carries
         user:8. invalidateTags(['user:7']) makes the first two miss and keeps the third. */
      const cache = (apps[0] as App).cache;
      const users = counter();
      const orders = counter();
      const other = counter();
      await cache.getOrSet('1', users.load, { namespace: 'users', tags: ['user:7'] });
      await cache.getOrSet('1', orders.load, { namespace: 'orders', tags: ['user:7'] });
      await cache.getOrSet('2', other.load, { namespace: 'users', tags: ['user:8'] });
      await cache.invalidateTags(['user:7']);
      await cache.getOrSet('1', users.load, { namespace: 'users', tags: ['user:7'] });
      await cache.getOrSet('1', orders.load, { namespace: 'orders', tags: ['user:7'] });
      await cache.getOrSet('2', other.load, { namespace: 'users', tags: ['user:8'] });
      expect(users.calls()).toBe(2);
      expect(orders.calls()).toBe(2);
      expect(other.calls()).toBe(1);
    });

    it('a lost tag version key: the tagged entry misses and the read creates no token', async () => {
      /* Review Focus 3. clear('') is rejected by the service, so the token is lost the way a
         flush or its TTL would lose it: the key is deleted. The entry is then a miss, never a
         hit, and the plain read leaves no __tag__ key behind. */
      const cache = (apps[0] as App).cache;
      const loader = counter();
      await cache.getOrSet('1', loader.load, { namespace: 'users', tags: ['user:7'] });
      expect(await redis.raw.keys('app:__tag__:*')).toEqual(['app:__tag__:user:7']);
      await redis.raw.del('app:__tag__:user:7');
      await pause(100);
      expect(await cache.get('1', { namespace: 'users' })).toBeUndefined();
      expect(await redis.raw.keys('app:__tag__:*')).toEqual([]);
      expect(await missesWithin(cache, '1', ['user:7'], loader, 'users')).toBe(true);
    });
  });

  // Two tiered stores sync over pub/sub: skipped where the probe finds it unreachable (ruling T1-B).
  const reachable = PUBSUB.get(adapterName) === true;
  const tieredTitle = 'with two tieredStore apps';
  describe.skipIf(!reachable)(reachable ? tieredTitle : skipTitle(tieredTitle), () => {
    let apps: App[];

    beforeEach(async () => {
      apps = [];
      for (let i = 0; i < 2; i += 1) {
        const store = tieredStore({
          l1: memoryStore(),
          l2: redisStore({ client: redis.client }),
          l1Ttl: 60_000,
        });
        apps.push(await startApp(store, 50));
      }
      const [a, b] = apps.map((app) => app.cache) as [CacheService, CacheService];
      await waitForSync(a, b);
      await waitForSync(b, a);
    });

    afterEach(async () => {
      for (const app of apps) await app.ref.close();
    });

    it("a tiered store pair: invalidation also reaches the peer's L1", async () => {
      /* Both L1s hold the entry (l1Ttl 60 s). A invalidates the tag: B's L1 copy is still
         there, but the stamp no longer matches the token, so B misses within cacheTtl. */
      const [a, b] = apps.map((app) => app.cache) as [CacheService, CacheService];
      const loadA = counter();
      const loadB = counter();
      const options = { tags: ['user:7'] };
      await a.getOrSet('k', loadA.load, options);
      expect(await b.getOrSet('k', loadB.load, options)).toBe(1);
      expect(loadB.calls()).toBe(0);
      await a.invalidateTags(['user:7']);
      /* A does not reload 'k' (its reload would overwrite the entry B reads). */
      expect(await missesWithin(b, 'k', ['user:7'], loadB)).toBe(true);
    });
  });
});
