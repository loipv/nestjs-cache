import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { createClient, createCluster } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../../src/core/cache.service.js';
import { CacheModule } from '../../src/module/cache.module.js';
import { memoryStore } from '../../src/stores/memory.store.js';
import { nodeRedisAdapter } from '../../src/stores/node-redis.adapter.js';
import { redisStore } from '../../src/stores/redis.store.js';
import { tieredStore } from '../../src/stores/tiered.store.js';
import { startRedisCluster, type RedisClusterHandle } from './helpers/redis-cluster.js';
import { startRedis } from './helpers/redis.js';

type NodeRedisClient = ReturnType<typeof createClient>;
type NodeRedisCluster = ReturnType<typeof createCluster>;

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

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Subscription starts in the background: wait until a delete on `from` reaches `to`. */
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

describe('nodeRedisAdapter (integration)', () => {
  let redis: { url: string; stop(): Promise<void> };
  let client: NodeRedisClient;

  async function connect(): Promise<NodeRedisClient> {
    const own = createClient({ url: redis.url });
    await own.connect();
    return own;
  }

  beforeAll(async () => {
    redis = await startRedis();
    client = await connect();
  });

  beforeEach(async () => {
    await client.flushAll();
  });

  afterAll(async () => {
    await closeAll([() => client.close(), () => redis.stop()]);
  });

  /* A redisStore over a connected node-redis client: single and batch reads (with a missing key
     and a duplicate), delete of several keys, and clear of one prefix that keeps another. */
  it('set/get/getMany/delete/clear', async () => {
    const store = redisStore({ client: nodeRedisAdapter(client) });
    await store.set('a', '1', 60_000);
    await store.set('b', '2', 60_000);
    expect(await store.get('a')).toBe('1');
    expect(await store.get('missing')).toBeUndefined();
    expect(await store.getMany(['b', 'missing', 'a', 'b'])).toEqual(['2', undefined, '1', '2']);
    const pttl = await client.pTTL('a');
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(60_000);

    await store.delete(['a', 'b']);
    expect(await store.getMany(['a', 'b'])).toEqual([undefined, undefined]);

    const p1 = Array.from({ length: 150 }, (_, i) => `p1:${String(i)}`);
    const p2 = Array.from({ length: 5 }, (_, i) => `p2:${String(i)}`);
    for (const key of [...p1, ...p2]) await store.set(key, 'v', 60_000);
    await store.clear('p1:');
    expect(await client.keys('p1:*')).toEqual([]);
    expect(await store.getMany(p2)).toEqual(p2.map(() => 'v'));
    await store.close();
    expect(client.isOpen).toBe(true);
  });

  /* GETEX with PX resets the TTL: a 1 s key read with getAndTouch(60 s) has more than 1 s left. */
  it('getAndTouch extends the ttl', async () => {
    const store = redisStore({ client: nodeRedisAdapter(client) });
    await store.set('t', 'v', 1_000);
    expect(await store.getAndTouch('t', 60_000)).toBe('v');
    expect(await client.pTTL('t')).toBeGreaterThan(1_000);
    expect(await store.getAndTouch('missing', 60_000)).toBeUndefined();
  });

  /* SET NX PX and the release script: a held lock excludes a second acquire until released. */
  it('lock acquire excludes a second acquire and release frees it', async () => {
    const store = redisStore({ client: nodeRedisAdapter(client) });
    const held = await store.lock!.acquire('app:__lock__:k', 5_000);
    expect(held).toBeDefined();
    expect(await store.lock!.acquire('app:__lock__:k', 5_000)).toBeUndefined();
    await held!.release();
    expect(await client.get('app:__lock__:k')).toBeNull();
    const again = await store.lock!.acquire('app:__lock__:k', 5_000);
    expect(again).toBeDefined();
    await again!.release();
  });

  describe('two tiered stores', () => {
    interface Instance {
      ref: TestingModule;
      client: NodeRedisClient;
      cache: CacheService;
    }
    let a: Instance;
    let b: Instance;

    async function startInstance(): Promise<Instance> {
      const own = await connect();
      const ref = await Test.createTestingModule({
        imports: [
          CacheModule.forRoot({
            stores: {
              default: tieredStore({
                l1: memoryStore(),
                l2: redisStore({ client: nodeRedisAdapter(own) }),
                l1Ttl: 60_000,
              }),
            },
          }),
        ],
      }).compile();
      await ref.init();
      return { ref, client: own, cache: ref.get(CacheService) };
    }

    beforeEach(async () => {
      a = await startInstance();
      b = await startInstance();
      await waitForSync(a.cache, b.cache);
      await waitForSync(b.cache, a.cache);
    });

    afterEach(async () => {
      await closeAll([
        () => a.ref.close(),
        () => b.ref.close(),
        () => a.client.close(),
        () => b.client.close(),
      ]);
    });

    /* B reads 'sync:k' into its L1, and a raw DEL of the Redis copy (which publishes nothing)
       shows B serves it from L1. A then writes a new value: the PUBLISH reaches B's subscriber,
       which evicts its L1 entry, so B reads the new value within 2 s. */
    it('two tiered stores sync L1 through pub/sub', async () => {
      await a.cache.set('sync:k', { n: 1 });
      const raw = await client.get('sync:k');
      expect(raw).not.toBeNull();
      // A read that overlaps A's own invalidation message does not fill L1, so retry the fill.
      await vi.waitFor(
        async () => {
          await client.set('sync:k', raw!, { expiration: { type: 'PX', value: 60_000 } });
          expect(await b.cache.get('sync:k')).toEqual({ n: 1 });
          await client.del('sync:k');
          expect(await b.cache.get('sync:k')).toEqual({ n: 1 });
        },
        { timeout: 2_000 },
      );

      await a.cache.set('sync:k', { n: 2 });
      await vi.waitFor(
        async () => {
          expect(await b.cache.get('sync:k')).toEqual({ n: 2 });
        },
        { timeout: 2_000 },
      );
    });
  });
  describe('cluster', () => {
    let redisCluster: RedisClusterHandle;
    let cluster: NodeRedisCluster;

    async function connectCluster(): Promise<NodeRedisCluster> {
      const own = createCluster({
        rootNodes: redisCluster.startupNodes.map((socket) => ({ socket })),
        // node-redis's nodeAddressMap has the shape of ioredis's natMap.
        nodeAddressMap: redisCluster.natMap,
      });
      await own.connect();
      return own;
    }

    /** Every key matching `pattern` on each master, by a full SCAN of that master. */
    async function keysPerMaster(pattern: string): Promise<string[][]> {
      return Promise.all(
        cluster.masters.map(async (master) => {
          const node = await cluster.nodeClient(master);
          const found: string[] = [];
          let cursor = '0';
          do {
            const reply = await node.scan(cursor, { MATCH: pattern, COUNT: 100 });
            cursor = reply.cursor;
            found.push(...reply.keys);
          } while (cursor !== '0');
          return found;
        }),
      );
    }

    beforeAll(async () => {
      redisCluster = await startRedisCluster();
      cluster = await connectCluster();
    });

    beforeEach(async () => {
      expect(cluster.masters).toHaveLength(3);
      await Promise.all(
        cluster.masters.map(async (master) => (await cluster.nodeClient(master)).flushAll()),
      );
    });

    afterAll(async () => {
      await closeAll([() => cluster.close(), () => redisCluster.stop()]);
    });

    /* Keys 'a', 'b' and 'c' hash to slots owned by three different masters: each master holds
       exactly one of them. Single-key commands reach the right node, and one delete call removes
       keys in three slots. */
    it('set/get across slots', async () => {
      const keys = ['a', 'b', 'c'];
      const store = redisStore({ client: nodeRedisAdapter(cluster) });
      for (const key of keys) await store.set(key, `v-${key}`, 60_000);
      const perMaster = await keysPerMaster('*');
      expect(perMaster.map((found) => found.length)).toEqual([1, 1, 1]);
      expect(perMaster.flat().sort()).toEqual(keys);
      for (const key of keys) expect(await store.get(key)).toBe(`v-${key}`);
      await store.delete(keys);
      for (const key of keys) expect(await store.get(key)).toBeUndefined();
    });

    /* getMany over keys in different slots, with a missing key and a duplicate, answers one value
       per input position in input order. */
    it('getMany order across slots', async () => {
      const store = redisStore({ client: nodeRedisAdapter(cluster) });
      await store.set('a', '1', 60_000);
      await store.set('b', '2', 60_000);
      await store.set('c', '3', 60_000);
      expect(await store.getMany(['c', 'missing', 'a', 'b', 'a'])).toEqual([
        '3',
        undefined,
        '1',
        '2',
        '1',
      ]);
    });

    /* Review Focus 2. A module with prefix 'app', a versioned namespace and the lock writes data
       keys on all three masters, a __version__ key, and a __lock__ key held by an in-flight
       getOrSet. clear('') through the store leaves every master empty. */
    it("clear('') removes keys on every master", async () => {
      const store = redisStore({ client: nodeRedisAdapter(cluster) });
      const ref: TestingModule = await Test.createTestingModule({
        imports: [
          CacheModule.forRoot({
            prefix: 'app',
            namespaces: { users: { versioned: true } },
            defaults: { lock: { enabled: true } },
            stores: { default: store },
          }),
        ],
      }).compile();
      await ref.init();
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let loading: Promise<unknown> | undefined;
      try {
        const cache = ref.get(CacheService);
        for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) await cache.set(key, key);
        await cache.set('1', { n: 1 }, { namespace: 'users' });
        loading = cache.getOrSet('held', async () => {
          await gate;
          return 'loaded';
        });

        await vi.waitFor(async () => {
          const keys = (await keysPerMaster('*')).flat();
          expect(keys.some((key) => key.startsWith('app:__lock__:'))).toBe(true);
        });
        const seeded = await keysPerMaster('*');
        expect(seeded.flat().some((key) => key.startsWith('app:__version__:'))).toBe(true);
        for (const found of seeded) expect(found).not.toEqual([]);

        await store.clear('');

        expect(await keysPerMaster('*')).toEqual([[], [], []]);
      } finally {
        open();
        await loading;
        await ref.close();
      }
    });

    /* SET NX and the release script run on the master that owns the lock key. */
    it('lock', async () => {
      const store = redisStore({ client: nodeRedisAdapter(cluster) });
      const held = await store.lock!.acquire('app:__lock__:it:k', 5_000);
      expect(held).toBeDefined();
      expect(await store.lock!.acquire('app:__lock__:it:k', 5_000)).toBeUndefined();
      await held!.release();
      expect(await cluster.get('app:__lock__:it:k')).toBeNull();
      const again = await store.lock!.acquire('app:__lock__:it:k', 5_000);
      expect(again).toBeDefined();
      await again!.release();
    });

    describe('two tiered stores', () => {
      interface Instance {
        ref: TestingModule;
        client: NodeRedisCluster;
        cache: CacheService;
      }
      let a: Instance;
      let b: Instance;

      async function startInstance(): Promise<Instance> {
        const own = await connectCluster();
        const ref = await Test.createTestingModule({
          imports: [
            CacheModule.forRoot({
              stores: {
                default: tieredStore({
                  l1: memoryStore(),
                  l2: redisStore({ client: nodeRedisAdapter(own) }),
                  l1Ttl: 60_000,
                }),
              },
            }),
          ],
        }).compile();
        await ref.init();
        return { ref, client: own, cache: ref.get(CacheService) };
      }

      beforeEach(async () => {
        a = await startInstance();
        b = await startInstance();
        await waitForSync(a.cache, b.cache);
        await waitForSync(b.cache, a.cache);
      });

      afterEach(async () => {
        await closeAll([
          () => a.ref.close(),
          () => b.ref.close(),
          () => a.client.close(),
          () => b.client.close(),
        ]);
      });

      /* B reads 'sync:k' into its L1, and a raw DEL of the Redis copy (which publishes nothing)
         shows B serves it from L1. A then writes a new value: the SPUBLISH reaches B's sharded
         subscriber, which evicts its L1 entry, so B reads the new value within 2 s. */
      it('two tiered stores sync L1 through sharded pub/sub', async () => {
        await a.cache.set('sync:k', { n: 1 });
        const raw = await cluster.get('sync:k');
        expect(raw).not.toBeNull();
        // A read that overlaps A's own invalidation message does not fill L1, so retry the fill.
        await vi.waitFor(
          async () => {
            await cluster.set('sync:k', raw!, { expiration: { type: 'PX', value: 60_000 } });
            expect(await b.cache.get('sync:k')).toEqual({ n: 1 });
            await cluster.del('sync:k');
            expect(await b.cache.get('sync:k')).toEqual({ n: 1 });
          },
          { timeout: 2_000 },
        );

        await a.cache.set('sync:k', { n: 2 });
        await vi.waitFor(
          async () => {
            expect(await b.cache.get('sync:k')).toEqual({ n: 2 });
          },
          { timeout: 2_000 },
        );
      });
    });
  });
});
