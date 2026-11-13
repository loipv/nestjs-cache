import { Cluster, Redis } from 'ioredis';
import { createClient, createCluster, createSentinel } from 'redis';
import { afterAll } from 'vitest';
import { nodeRedisAdapter, type NodeRedisLike } from '../../../src/stores/node-redis.adapter.js';
import type { RedisStoreOptions } from '../../../src/stores/redis.store.js';
import type { ProbeClient } from './pubsub-probe.js';
import { checkPubSub } from './pubsub-reachability.js';
import { withinStartup } from './startup-timeout.js';
import { startRedisCluster, type RedisClusterHandle } from './redis-cluster.js';
import { startRedisSentinel, type RedisSentinelHandle } from './redis-sentinel.js';
import { startRedis } from './redis.js';

export type AdapterName =
  | 'ioredis'
  | 'ioredis-cluster'
  | 'ioredis-sentinel'
  | 'node-redis'
  | 'node-redis-cluster'
  | 'node-redis-sentinel';

const ALL_ADAPTERS: readonly AdapterName[] = [
  'ioredis',
  'ioredis-cluster',
  'ioredis-sentinel',
  'node-redis',
  'node-redis-cluster',
  'node-redis-sentinel',
];

const reachability = new Map<AdapterName, Promise<boolean>>();

/**
 * Whether the host can use `name`'s pub/sub, probed once per test file (the cache is per module,
 * and Vitest loads this module once per file). It uses the file's shared container or Sentinel
 * set through a temporary client, so it starts no extra container. The probe drives that raw
 * client, not the library's adapter, so an adapter pub/sub bug fails the cases instead of skipping
 * them. A file calls it with top-level `await` before declaring cases, then uses
 * `it.skipIf(!reachable)` and `skipTitle`. A startup that fails, or does not finish within
 * `STARTUP_TIMEOUT_MS`, rejects and fails the file instead of skipping its pub/sub cases; so does
 * an unreachable pub/sub under `CACHE_IT_REQUIRE_PUBSUB=1` (see `checkPubSub`).
 */
export function canReachPubSub(name: AdapterName): Promise<boolean> {
  let result = reachability.get(name);
  if (result === undefined) {
    result = checkPubSub(name, () =>
      withinStartup(startAdapter(name), `Starting ${name} for the pub/sub probe`, (late) =>
        late.stop(),
      ),
    ).catch((error: unknown) => {
      // The file fails at collection and then runs no afterAll: stop what it shares.
      stopShared();
      throw error;
    });
    reachability.set(name, result);
  }
  return result;
}

/** The title of a case that skips because pub/sub is unreachable from this host. */
export function skipTitle(title: string): string {
  return `${title} (skipped: pub/sub unreachable from this host)`;
}

/**
 * The adapters the suites run against: `CACHE_IT_ADAPTERS` (comma-separated), or all six.
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
  /** `CONFIG RESETSTAT` on the master (on a cluster, on every master). */
  resetStats(): Promise<void>;
  /** The `calls` of `cmdstat_<command>` (lowercase), summed over the masters. */
  commandCalls(command: string): Promise<number>;
}

/** The calls of `cmdstat_<command>` in an `INFO commandstats` reply; 0 when never called. */
function parseCalls(info: string, command: string): number {
  const match = new RegExp(`^cmdstat_${command}:calls=(\\d+)`, 'm').exec(info);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

export interface StartedAdapter {
  client: RedisStoreOptions['client'];
  /** The raw client, for `probePubSub`: it must not go through the adapter under test. */
  probe: ProbeClient;
  /** Empties every database; on a cluster, every master. */
  flush(): Promise<void>;
  raw: RawRedis;
  stop(): Promise<void>;
}

/**
 * One cluster container and one Sentinel set (master, replica, sentinel) per test file at most:
 * the two cluster adapters share the first, the two Sentinel adapters the second. Each starts on
 * first use and stops in an `afterAll` registered for the file. Vitest loads this module once per
 * test file, so the state below is per file.
 */
let sharedCluster: Promise<RedisClusterHandle> | undefined;
let sharedSentinel: Promise<RedisSentinelHandle> | undefined;
let sharedStandalone: ReturnType<typeof startRedis> | undefined;

function standalone(): ReturnType<typeof startRedis> {
  sharedStandalone ??= startRedis();
  return sharedStandalone;
}

function cluster(): Promise<RedisClusterHandle> {
  sharedCluster ??= startRedisCluster();
  return sharedCluster;
}

function sentinel(): Promise<RedisSentinelHandle> {
  sharedSentinel ??= startRedisSentinel();
  return sharedSentinel;
}

/** Stops the file's shared containers now, or each once it has started; for a failed collection. */
function stopShared(): void {
  const pending = [sharedStandalone, sharedCluster, sharedSentinel];
  sharedStandalone = undefined;
  sharedCluster = undefined;
  sharedSentinel = undefined;
  for (const handle of pending) {
    handle?.then((started) => started.stop()).catch(() => undefined);
  }
}

afterAll(async () => {
  const pending = sharedCluster;
  sharedCluster = undefined;
  if (pending !== undefined) await (await pending).stop();
});

afterAll(async () => {
  const pending = sharedStandalone;
  sharedStandalone = undefined;
  if (pending !== undefined) await (await pending).stop();
});

afterAll(async () => {
  const pending = sharedSentinel;
  sharedSentinel = undefined;
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
    case 'ioredis-sentinel':
      return startIoredisSentinel();
    case 'node-redis-sentinel':
      return startNodeRedisSentinel();
  }
}

async function startIoredis(): Promise<StartedAdapter> {
  const redis = await standalone();
  const client = new Redis(redis.url);
  return {
    client,
    probe: { kind: 'ioredis', client },
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
      resetStats: async () => {
        await client.config('RESETSTAT');
      },
      commandCalls: async (command) => parseCalls(await client.info('commandstats'), command),
    },
    // The container is shared by the file's adapters and stops in the file's afterAll.
    stop: async () => {
      await client.quit();
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
    probe: { kind: 'ioredis', client },
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
      resetStats: async () => {
        await Promise.all(client.nodes('master').map((node) => node.config('RESETSTAT')));
      },
      commandCalls: async (command) =>
        sum(
          await Promise.all(
            client
              .nodes('master')
              .map(async (node) => parseCalls(await node.info('commandstats'), command)),
          ),
        ),
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

// Not `ReturnType<typeof createClient>`: that is not the type of `createClient()` once the default RESP
// version differs (redis v5 uses 2, v6 uses 3).
const newNodeRedisClient = (url: string) => createClient({ url });
type NodeRedisClient = ReturnType<typeof newNodeRedisClient>;

async function scanNodeRedis(
  client: Pick<NodeRedisLike, 'scan'>,
  pattern: string,
): Promise<string[]> {
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
  const redis = await standalone();
  const client = newNodeRedisClient(redis.url);
  // Without an 'error' listener, an error node-redis emits (a dropped socket) would crash the run.
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (error) {
    client.destroy();
    throw error;
  }
  return {
    client: nodeRedisAdapter(client),
    probe: { kind: 'node-redis', client },
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
      resetStats: async () => {
        await client.configResetStat();
      },
      commandCalls: async (command) => parseCalls(await client.info('commandstats'), command),
    },
    stop: async () => {
      await client.close();
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
  // As above.
  client.on('error', () => undefined);
  await client.connect();
  const perMaster = <T>(run: (node: NodeRedisClient) => Promise<T>): Promise<T[]> =>
    Promise.all(client.masters.map(async (master) => run(await client.nodeClient(master))));
  return {
    client: nodeRedisAdapter(client),
    probe: { kind: 'node-redis', client },
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
      resetStats: async () => {
        await perMaster((node) => node.configResetStat());
      },
      commandCalls: async (command) =>
        sum(await perMaster(async (node) => parseCalls(await node.info('commandstats'), command))),
    },
    stop: async () => {
      await client.close();
    },
  };
}

/** ioredis through the sentinel: it asks the sentinel for the master and follows failovers. */
async function startIoredisSentinel(): Promise<StartedAdapter> {
  const handle = await sentinel();
  const client = new Redis({
    sentinels: handle.sentinels,
    name: handle.name,
    natMap: handle.natMap,
  });
  // A failover or a dropped socket emits 'error' while ioredis reconnects.
  client.on('error', () => undefined);
  return {
    client,
    probe: { kind: 'ioredis', client },
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
      resetStats: async () => {
        await client.config('RESETSTAT');
      },
      commandCalls: async (command) => parseCalls(await client.info('commandstats'), command),
    },
    stop: async () => {
      await client.quit();
    },
  };
}

/** node-redis's Sentinel client; every command goes to the master it reports. */
async function startNodeRedisSentinel(): Promise<StartedAdapter> {
  const handle = await sentinel();
  const client = createSentinel({
    name: handle.name,
    sentinelRootNodes: handle.sentinels,
    // node-redis's nodeAddressMap has the shape of ioredis's natMap (an object keyed by
    // "host:port"); redis v5 does not apply it to the Sentinel's pub/sub, see probePubSub.
    nodeAddressMap: handle.natMap,
  });
  // As in startNodeRedis.
  client.on('error', () => undefined);
  await client.connect();
  return {
    client: nodeRedisAdapter(client),
    probe: { kind: 'node-redis-sentinel', client },
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
      resetStats: async () => {
        await client.configResetStat();
      },
      commandCalls: async (command) => parseCalls(await client.info('commandstats'), command),
    },
    stop: async () => {
      await client.close();
    },
  };
}
