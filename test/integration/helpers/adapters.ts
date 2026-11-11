import { Cluster, Redis } from 'ioredis';
import { createClient, createCluster } from 'redis';
import { afterAll } from 'vitest';
import { nodeRedisAdapter } from '../../../src/stores/node-redis.adapter.js';
import type { RedisStoreOptions } from '../../../src/stores/redis.store.js';
import { startRedisCluster, type RedisClusterHandle } from './redis-cluster.js';
import { startRedis } from './redis.js';

export type AdapterName = 'ioredis' | 'ioredis-cluster' | 'node-redis' | 'node-redis-cluster';

const ALL_ADAPTERS: readonly AdapterName[] = [
  'ioredis',
  'ioredis-cluster',
  'node-redis',
  'node-redis-cluster',
];

/**
 * The adapters the suites run against: `CACHE_IT_ADAPTERS` (comma-separated), or all four.
 * An unknown name throws, so a typo never silently skips a suite.
 */
export function selectedAdapters(): AdapterName[] {
  const value = process.env['CACHE_IT_ADAPTERS'];
  if (value === undefined || value.trim() === '') return [...ALL_ADAPTERS];
  return value
    .split(',')
    .map((name) => name.trim())
    .map((name) => {
      const known = ALL_ADAPTERS.find((adapter) => adapter === name);
      if (known === undefined) {
        throw new Error(
          `Unknown CACHE_IT_ADAPTERS entry "${name}"; expected ${ALL_ADAPTERS.join(', ')}`,
        );
      }
      return known;
    });
}

/** Direct access to Redis for assertions; on a cluster it reaches the node that owns the key. */
export interface RawRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Remaining ttl in ms (-1 without a ttl, -2 for a missing key). */
  pttl(key: string): Promise<number>;
  /** Every key matching `pattern`; on a cluster, from every master. */
  keys(pattern: string): Promise<string[]>;
}

export interface StartedAdapter {
  client: RedisStoreOptions['client'];
  /** Empties every database; on a cluster, every master. */
  flush(): Promise<void>;
  raw: RawRedis;
  stop(): Promise<void>;
}

/**
 * One cluster container per test file at most: the two cluster adapters share it. It starts on
 * first use and stops in an `afterAll` registered for the file. Vitest loads this module once per
 * test file, so the state below is per file.
 */
let sharedCluster: Promise<RedisClusterHandle> | undefined;

function cluster(): Promise<RedisClusterHandle> {
  sharedCluster ??= startRedisCluster();
  return sharedCluster;
}

afterAll(async () => {
  const pending = sharedCluster;
  sharedCluster = undefined;
  if (pending !== undefined) await (await pending).stop();
});

export function startAdapter(name: AdapterName): Promise<StartedAdapter> {
  switch (name) {
    case 'ioredis':
      return startIoredis();
    case 'ioredis-cluster':
      return startIoredisCluster();
    case 'node-redis':
      return startNodeRedis();
    case 'node-redis-cluster':
      return startNodeRedisCluster();
  }
}

async function startIoredis(): Promise<StartedAdapter> {
  const redis = await startRedis();
  const client = new Redis(redis.url);
  return {
    client,
    flush: async () => {
      await client.flushall();
    },
    raw: {
      get: (key) => client.get(key),
      set: async (key, value, ttlMs) => {
        await client.set(key, value, 'PX', ttlMs);
      },
      del: async (key) => {
        await client.del(key);
      },
      pttl: (key) => client.pttl(key),
      keys: (pattern) => scanIoredis(client, pattern),
    },
    stop: async () => {
      try {
        await client.quit();
      } finally {
        await redis.stop();
      }
    },
  };
}

async function startIoredisCluster(): Promise<StartedAdapter> {
  const handle = await cluster();
  const client = new Cluster(handle.startupNodes, { natMap: handle.natMap });
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => {
      resolve();
    });
    client.once('error', reject);
  });
  return {
    client,
    flush: async () => {
      await Promise.all(client.nodes('master').map((node) => node.flushall()));
    },
    raw: {
      get: (key) => client.get(key),
      set: async (key, value, ttlMs) => {
        await client.set(key, value, 'PX', ttlMs);
      },
      del: async (key) => {
        await client.del(key);
      },
      pttl: (key) => client.pttl(key),
      keys: async (pattern) =>
        (
          await Promise.all(client.nodes('master').map((node) => scanIoredis(node, pattern)))
        ).flat(),
    },
    stop: async () => {
      await client.quit();
    },
  };
}

async function scanIoredis(client: Redis, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  return found;
}

type NodeRedisClient = ReturnType<typeof createClient>;

async function scanNodeRedis(client: NodeRedisClient, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const page = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = page.cursor;
    found.push(...page.keys);
  } while (cursor !== '0');
  return found;
}

async function startNodeRedis(): Promise<StartedAdapter> {
  const redis = await startRedis();
  const client = createClient({ url: redis.url });
  try {
    await client.connect();
  } catch (error) {
    await redis.stop();
    throw error;
  }
  return {
    client: nodeRedisAdapter(client),
    flush: async () => {
      await client.flushAll();
    },
    raw: {
      get: (key) => client.get(key),
      set: async (key, value, ttlMs) => {
        await client.set(key, value, { expiration: { type: 'PX', value: ttlMs } });
      },
      del: async (key) => {
        await client.del(key);
      },
      pttl: (key) => client.pTTL(key),
      keys: (pattern) => scanNodeRedis(client, pattern),
    },
    stop: async () => {
      try {
        await client.close();
      } finally {
        await redis.stop();
      }
    },
  };
}

async function startNodeRedisCluster(): Promise<StartedAdapter> {
  const handle = await cluster();
  const client = createCluster({
    rootNodes: handle.startupNodes.map((socket) => ({ socket })),
    // node-redis's nodeAddressMap has the shape of ioredis's natMap.
    nodeAddressMap: handle.natMap,
  });
  await client.connect();
  const perMaster = <T>(run: (node: NodeRedisClient) => Promise<T>): Promise<T[]> =>
    Promise.all(client.masters.map(async (master) => run(await client.nodeClient(master))));
  return {
    client: nodeRedisAdapter(client),
    flush: async () => {
      await perMaster((node) => node.flushAll());
    },
    raw: {
      get: (key) => client.get(key),
      set: async (key, value, ttlMs) => {
        await client.set(key, value, { expiration: { type: 'PX', value: ttlMs } });
      },
      del: async (key) => {
        await client.del(key);
      },
      pttl: (key) => client.pTTL(key),
      keys: async (pattern) => (await perMaster((node) => scanNodeRedis(node, pattern))).flat(),
    },
    stop: async () => {
      await client.close();
    },
  };
}
