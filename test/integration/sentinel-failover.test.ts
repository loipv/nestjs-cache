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
import { selectedAdapters, skipTitle } from './helpers/adapters.js';
import { probePubSub, type ProbeClient } from './helpers/pubsub-probe.js';
import { requireReachable } from './helpers/pubsub-reachability.js';
import { startRedisSentinel, type RedisSentinelHandle } from './helpers/redis-sentinel.js';
import { withinStartup } from './helpers/startup-timeout.js';

const RECOVERY_MS = 30_000;

type SentinelAdapter = 'ioredis-sentinel' | 'node-redis-sentinel';
const ADAPTERS = selectedAdapters().filter(
  (name): name is SentinelAdapter => name === 'ioredis-sentinel' || name === 'node-redis-sentinel',
);

interface Client {
  client: RedisStoreOptions['client'];
  /** The raw client, for `probePubSub`: it must not go through the adapter under test. */
  probe: ProbeClient;
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
      probe: { kind: 'ioredis', client: redis },
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
    probe: { kind: 'node-redis-sentinel', client: redis },
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

interface Setup {
  name: SentinelAdapter;
  /** Its own Sentinel set: a failover changes the topology other files must not see. */
  handle: RedisSentinelHandle;
  /** Whether the probe reached the Sentinel's pub/sub from this host. */
  reachable: boolean;
}

/* The probe needs a live Sentinel set before the cases are declared, so each adapter's set starts
   here and the describe below stops it. Probing publishes only; the topology is unchanged. The
   whole startup has STARTUP_TIMEOUT_MS: Vitest does not time out collection. */
const SETUPS: Setup[] = [];
let abandoned = false;
async function startSetups(): Promise<void> {
  for (const name of ADAPTERS) {
    const handle = await startRedisSentinel();
    if (abandoned) {
      // the startup timed out while this set started: the file has failed already
      await handle.stop();
      return;
    }
    const setup: Setup = { name, handle, reachable: false };
    SETUPS.push(setup);
    try {
      const probe = await connect(name, handle);
      try {
        setup.reachable = await probePubSub(probe.probe);
      } finally {
        await closeWithin(() => probe.close()).catch(() => undefined);
      }
    } catch {
      // a client that cannot even connect leaves pub/sub unreachable; the cases report the rest
    }
    // Under CACHE_IT_REQUIRE_PUBSUB=1 an unreachable pub/sub fails the file.
    requireReachable(name, setup.reachable);
  }
}
try {
  await withinStartup(startSetups(), 'Starting the Sentinel sets for the failover cases');
} catch (error) {
  // No afterAll exists yet, so stop the sets already started before failing the file.
  abandoned = true;
  await Promise.allSettled(SETUPS.map((setup) => setup.handle.stop()));
  throw error;
}

// A run whose CACHE_IT_ADAPTERS selects no Sentinel adapter declares no case above, and Vitest
// fails a file without one ("No test suite found").
if (ADAPTERS.length === 0) {
  it.skip('Sentinel failover (integration): no Sentinel adapter selected', () => undefined);
}

describe.each(SETUPS)(
  'Sentinel failover (integration) on $name',
  ({ name: adapterName, handle: sentinelSet, reachable }) => {
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
              default: reachable
                ? tieredStore({
                    l1: memoryStore(),
                    l2: redisStore({ client: client.client }),
                    l1Ttl: 60_000,
                  })
                : // The probe found the L1 invalidation channel unreachable from this host (ruling T1-B).
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
      handle = sentinelSet;
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

    const tieredTitle = 'a write on one instance evicts the other L1 again';

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

    it.skipIf(!reachable)(reachable ? tieredTitle : skipTitle(tieredTitle), async () => {
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
  },
);
