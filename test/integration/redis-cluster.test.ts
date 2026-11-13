import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { Cluster, type Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../../src/core/cache.service.js';
import { CacheModule } from '../../src/module/cache.module.js';
import { memoryStore } from '../../src/stores/memory.store.js';
import { redisStore } from '../../src/stores/redis.store.js';
import { tieredStore } from '../../src/stores/tiered.store.js';
import { startRedisCluster, type RedisClusterHandle } from './helpers/redis-cluster.js';

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

/** Every key on one node that matches `pattern`, by a full SCAN of that node. */
async function scanNode(node: Redis, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await node.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  return found;
}

describe('ioredis Cluster (integration)', () => {
  let redis: RedisClusterHandle;
  let client: Cluster;

  function connect(): Promise<Cluster> {
    const cluster = new Cluster(redis.startupNodes, { natMap: redis.natMap });
    return new Promise((resolve, reject) => {
      cluster.once('ready', () => {
        resolve(cluster);
      });
      cluster.once('error', reject);
    });
  }

  function masters(): Redis[] {
    return client.nodes('master');
  }

  /** The port each key's master announces, found with CLUSTER KEYSLOT and CLUSTER SLOTS. */
  async function ownersOf(keys: readonly string[]): Promise<Set<number>> {
    const ranges = await client.cluster('SLOTS');
    const owners = new Set<number>();
    for (const key of keys) {
      const slot = await client.cluster('KEYSLOT', key);
      const range = ranges.find(([start, end]) => slot >= start && slot <= end);
      const port = range?.[2]?.[1];
      if (port === undefined) throw new Error(`no master owns slot ${String(slot)}`);
      owners.add(port);
    }
    return owners;
  }

  beforeAll(async () => {
    redis = await startRedisCluster();
    client = await connect();
  });

  beforeEach(async () => {
    expect(masters()).toHaveLength(3);
    await Promise.all(masters().map((node) => node.flushall()));
  });

  afterAll(async () => {
    await closeAll([() => client.quit(), () => redis.stop()]);
  });

  /* Keys 'a', 'b' and 'c' hash to slots owned by three different masters. Single-key commands
     reach the right node, and one delete call removes keys in several slots. */
  it('set/get/delete across slots', async () => {
    const keys = ['a', 'b', 'c'];
    expect((await ownersOf(keys)).size).toBe(3);
    const store = redisStore({ client });
    for (const key of keys) await store.set(key, `v-${key}`, 60_000);
    for (const key of keys) expect(await store.get(key)).toBe(`v-${key}`);
    await store.delete(keys);
    for (const key of keys) expect(await store.get(key)).toBeUndefined();
  });

  /* setMany over keys in many slots writes all of them with a TTL; a command Redis refuses makes
     the pipeline of its slot fail, and setMany rejects. SET never answers WRONGTYPE (it overwrites
     a list), so the failing command is one Redis refuses: PX 0 gives "invalid expire time". */
  it('setMany writes keys across slots and rejects when a command fails', async () => {
    const store = redisStore({ client });
    const entries = Array.from({ length: 60 }, (_, i) => ({
      key: `many:${String(i)}`,
      value: `v${String(i)}`,
      ttlMs: 60_000,
    }));
    expect((await ownersOf(entries.map((e) => e.key))).size).toBe(3);
    await store.setMany(entries);
    for (const e of entries) {
      expect(await client.get(e.key)).toBe(e.value);
      expect(await client.pttl(e.key)).toBeGreaterThan(0);
    }
    await expect(
      store.setMany([...entries, { key: 'many:bad', value: 'y', ttlMs: 0 }]),
    ).rejects.toThrow('invalid expire time');
  });

  /* getMany over keys in different slots, with a missing key and a duplicate, answers one value
     per input position in input order. */
  it('getMany returns values in input order for keys in different slots', async () => {
    const store = redisStore({ client });
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
  it('clear("") removes keys on every master, including __version__ and __lock__ keys', async () => {
    const store = redisStore({ client });
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
        const keys = (await Promise.all(masters().map((node) => scanNode(node, '*')))).flat();
        expect(keys.some((key) => key.includes('__lock__'))).toBe(true);
      });
      const seeded = (await Promise.all(masters().map((node) => scanNode(node, '*')))).flat();
      expect(seeded.some((key) => key.startsWith('app:__version__:'))).toBe(true);
      expect(seeded.some((key) => key.startsWith('app:__lock__:'))).toBe(true);
      expect((await ownersOf(seeded)).size).toBe(3);
      for (const node of masters()) expect(await scanNode(node, '*')).not.toEqual([]);

      await store.clear('');

      for (const node of masters()) expect(await scanNode(node, '*')).toEqual([]);
    } finally {
      open();
      await loading;
      await ref.close();
    }
  });

  /* Twelve 'p1:' keys spread over all three masters, and twelve 'p2:' keys. clear('p1:') removes
     every 'p1:' key on every master and keeps every 'p2:' key. */
  it('clear(prefix) removes only that prefix on every master', async () => {
    const store = redisStore({ client });
    const p1 = Array.from({ length: 12 }, (_, i) => `p1:${String(i)}`);
    const p2 = Array.from({ length: 12 }, (_, i) => `p2:${String(i)}`);
    for (const key of [...p1, ...p2]) await store.set(key, 'v', 60_000);
    expect((await ownersOf(p1)).size).toBe(3);

    await store.clear('p1:');

    for (const node of masters()) expect(await scanNode(node, 'p1:*')).toEqual([]);
    expect(await store.getMany(p2)).toEqual(p2.map(() => 'v'));
  });

  it('clear(prefix) removes 5 000 keys across slots and keeps other keys', async () => {
    const store = redisStore({ client });
    for (let start = 0; start < 5_000; start += 500) {
      await Promise.all(
        Array.from({ length: 500 }, (_, i) => client.set(`bulk:k${String(start + i)}`, 'v')),
      );
    }
    await client.set('other:x', 'v');
    await store.clear('bulk:');
    for (const node of masters()) expect(await scanNode(node, 'bulk:*')).toEqual([]);
    expect(await client.get('other:x')).toBe('v');
  });

  /* SET NX and the release script run on the master that owns the lock key. */
  it('a lock acquired through the cluster excludes a second acquire', async () => {
    const store = redisStore({ client });
    const held = await store.lock!.acquire('app:__lock__:it:k', 5_000);
    expect(held).toBeDefined();
    expect(await store.lock!.acquire('app:__lock__:it:k', 5_000)).toBeUndefined();
    await held!.release();
    const again = await store.lock!.acquire('app:__lock__:it:k', 5_000);
    expect(again).toBeDefined();
    await again!.release();
  });

  describe('two tiered stores', () => {
    interface Instance {
      ref: TestingModule;
      client: Cluster;
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
                l2: redisStore({ client: own }),
                l1Ttl: 60_000,
              }),
            },
          }),
        ],
      }).compile();
      await ref.init();
      return { ref, client: own, cache: ref.get(CacheService) };
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
        () => a.client.quit(),
        () => b.client.quit(),
      ]);
    });

    /* B reads 'sync:k' into its L1, and a raw DEL of the Redis copy (which publishes nothing)
       shows B serves it from L1. A then writes a new value: the SPUBLISH reaches B's sharded
       subscriber, which evicts its L1 entry, so B reads the new value within 2 s. */
    it('two tiered stores sync L1 through sharded pub/sub', async () => {
      await a.cache.set('sync:k', { n: 1 });
      const raw = await client.get('sync:k');
      expect(raw).not.toBeNull();
      // A read that overlaps A's own invalidation message does not fill L1, so retry the fill.
      await vi.waitFor(
        async () => {
          await client.set('sync:k', raw!, 'PX', 60_000);
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
});
