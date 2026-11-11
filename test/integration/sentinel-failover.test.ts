import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { createSentinel } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CacheService } from '../../src/core/cache.service.js';
import { CacheModule } from '../../src/module/cache.module.js';
import { memoryStore } from '../../src/stores/memory.store.js';
import { nodeRedisAdapter } from '../../src/stores/node-redis.adapter.js';
import { redisStore, type RedisStoreOptions } from '../../src/stores/redis.store.js';
import { tieredStore } from '../../src/stores/tiered.store.js';
import { hasHostPubSub, selectedAdapters } from './helpers/adapters.js';
import { startRedisSentinel, type RedisSentinelHandle } from './helpers/redis-sentinel.js';

const RECOVERY_MS = 30_000;

type SentinelAdapter = 'ioredis-sentinel' | 'node-redis-sentinel';
const ADAPTERS = selectedAdapters().filter(
  (name): name is SentinelAdapter => name === 'ioredis-sentinel' || name === 'node-redis-sentinel',
);

interface Client {
  client: RedisStoreOptions['client'];
  close(): Promise<void>;
}

async function connect(name: SentinelAdapter, handle: RedisSentinelHandle): Promise<Client> {
  if (name === 'ioredis-sentinel') {
    const redis = new Redis({
      sentinels: handle.sentinels,
      name: handle.name,
      natMap: handle.natMap,
    });
    redis.on('error', () => undefined); // emitted while ioredis reconnects after a failover
    return {
      client: redis,
      close: async () => {
        await redis.quit();
      },
    };
  }
  const redis = createSentinel({
    name: handle.name,
    sentinelRootNodes: handle.sentinels,
    nodeAddressMap: handle.natMap,
  });
  redis.on('error', () => undefined);
  await redis.connect();
  return {
    client: nodeRedisAdapter(redis),
    close: async () => {
      await redis.close();
    },
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `attempt` every 250 ms until it stops throwing, for up to `timeoutMs`. */
async function eventually(attempt: () => Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // A command can hang while the client has no master; bound it so the poll retries.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        attempt(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('attempt timed out after 5 s'));
          }, 5_000);
        }),
      ]).finally(() => {
        clearTimeout(timer);
      });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await pause(250);
    }
  }
}

/** Runs `close`, failing once `ms` have passed so a hanging close cannot stall the teardown. */
async function closeWithin(close: () => Promise<void>, ms = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`close timed out after ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe.each(ADAPTERS)('Sentinel failover (integration) on %s', (adapterName) => {
  let handle: RedisSentinelHandle | undefined;
  const clients: Client[] = [];
  const apps: TestingModule[] = [];
  const caches: CacheService[] = [];

  function started(): RedisSentinelHandle {
    if (handle === undefined) throw new Error('the Sentinel set did not start');
    return handle;
  }

  async function startInstance(): Promise<CacheService> {
    const client = await connect(adapterName, started());
    clients.push(client);
    const ref = await Test.createTestingModule({
      imports: [
        CacheModule.forRoot({
          stores: {
            default: hasHostPubSub(adapterName)
              ? tieredStore({
                  l1: memoryStore(),
                  l2: redisStore({ client: client.client }),
                  l1Ttl: 60_000,
                })
              : // The L1 invalidation channel cannot be reached from the host (ruling T1-B).
                redisStore({ client: client.client }),
          },
        }),
      ],
    }).compile();
    await ref.init();
    apps.push(ref);
    return ref.get(CacheService);
  }

  beforeAll(async () => {
    // Its own Sentinel set: a failover changes the topology other files must not see.
    handle = await startRedisSentinel();
    caches.push(await startInstance(), await startInstance());
  });

  afterAll(async () => {
    // Every close is bounded and settled, so the containers are stopped even when one fails or
    // hangs; the first failure is rethrown at the end. Apps close before the clients they use.
    const results = await Promise.allSettled(apps.map((app) => closeWithin(() => app.close())));
    results.push(
      ...(await Promise.allSettled(clients.map((client) => closeWithin(() => client.close())))),
    );
    results.push(...(await Promise.allSettled([handle?.stop()])));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  });

  const tieredTitle = hasHostPubSub(adapterName)
    ? 'a write on one instance evicts the other L1 again'
    : "skipped: node-redis Sentinel's pub/sub ignores nodeAddressMap (ruling T1-B): a write on one instance evicts the other L1 again";

  it('set and get through the store recover within 30 s of a failover', async () => {
    const [a, b] = caches as [CacheService, CacheService];
    await a.set('before', { n: 1 });
    expect(await b.get('before')).toEqual({ n: 1 });

    await started().failover();

    await eventually(async () => {
      await a.set('after', { n: 2 });
      expect(await a.get('after')).toEqual({ n: 2 });
      expect(await b.get('after')).toEqual({ n: 2 });
    }, RECOVERY_MS);
  });

  it.skipIf(!hasHostPubSub(adapterName))(tieredTitle, async () => {
    const [a, b] = caches as [CacheService, CacheService];
    /* After a failover a subscriber can miss messages for ~10 s (ruling T1-C), so each round
       writes a new value on A and polls B until it sees it: B's L1 copy has been evicted. */
    let n = 0;
    await eventually(async () => {
      n += 1;
      await a.set('evict', n);
      expect(await b.get('evict')).toBe(n);
      n += 1;
      await a.set('evict', n);
      await pause(100);
      expect(await b.get('evict')).toBe(n);
    }, RECOVERY_MS);
  });
});
