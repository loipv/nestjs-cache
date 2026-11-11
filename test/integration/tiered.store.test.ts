import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../../src/core/cache.service.js';
import { CacheModule } from '../../src/module/cache.module.js';
import { memoryStore } from '../../src/stores/memory.store.js';
import { redisStore } from '../../src/stores/redis.store.js';
import { tieredStore } from '../../src/stores/tiered.store.js';
import {
  hasHostPubSub,
  pubSubSkipReason,
  selectedAdapters,
  startAdapter,
  type StartedAdapter,
} from './helpers/adapters.js';
import { startRedis } from './helpers/redis.js';
import { Redis } from 'ioredis';

interface Instance {
  ref: TestingModule;
  cache: CacheService;
  closed: boolean;
}

const CHANNEL = 'nestjs-cache:invalidate';

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Subscription starts in the background, so wait until `to` drops an L1 entry when `from`
 * deletes it: probe every 50 ms for up to 5 s.
 */
async function waitForSync(from: CacheService, to: CacheService): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (let i = 0; Date.now() < deadline; i += 1) {
    const key = `sync-probe:${i}`;
    await from.set(key, i);
    expect(await to.get(key)).toBe(i);
    await from.delete(key);
    await pause(50);
    if ((await to.get(key)) === undefined) return;
  }
  throw new Error('instances did not sync within 5 s');
}

/**
 * Makes sure `instance` serves `fullKey` from its L1: reads it to fill L1, deletes the L2 copy with a
 * raw DEL (which publishes nothing), and expects the value to still come back. A read that overlaps
 * an invalidation does not backfill L1, so the fill is retried with the L2 copy restored.
 */
async function expectServedFromL1(
  redis: StartedAdapter,
  fullKey: string,
  read: () => Promise<unknown>,
  expected: unknown,
): Promise<void> {
  const raw = await redis.raw.get(fullKey);
  expect(raw).not.toBeNull();
  await vi.waitFor(
    async () => {
      await redis.raw.set(fullKey, raw!, 60_000);
      expect(await read()).toEqual(expected);
      await redis.raw.del(fullKey);
      expect(await read()).toEqual(expected);
    },
    { timeout: 2_000 },
  );
}

/* Every case below syncs two instances over pub/sub (waitForSync in beforeEach), so an adapter
   whose pub/sub the host cannot reach skips the suite and starts no container (ruling T1-B). */
const WITH_PUBSUB = selectedAdapters().filter(hasHostPubSub);
const WITHOUT_PUBSUB = selectedAdapters().filter((name) => !hasHostPubSub(name));

describe.each(WITHOUT_PUBSUB)('TieredStore (integration) on %s', (adapterName) => {
  it.skip(`skipped: ${pubSubSkipReason(adapterName) ?? ''}`, () => undefined);
});

describe.each(WITH_PUBSUB)('TieredStore (integration) on %s', (adapterName) => {
  let redis: StartedAdapter;
  let a: Instance;
  let b: Instance;

  async function startInstance(): Promise<Instance> {
    const ref = await Test.createTestingModule({
      imports: [
        CacheModule.forRoot({
          stores: {
            default: tieredStore({
              l1: memoryStore(),
              l2: redisStore({ client: redis.client }),
              l1Ttl: 60_000,
            }),
          },
        }),
      ],
    }).compile();
    await ref.init();
    return { ref, cache: ref.get(CacheService), closed: false };
  }

  async function closeApp(instance: Instance): Promise<void> {
    if (instance.closed) return;
    instance.closed = true;
    await instance.ref.close();
  }

  beforeAll(async () => {
    redis = await startAdapter(adapterName);
    await redis.flush(); // the cluster container is shared between the cluster adapters
  });

  afterAll(async () => {
    await redis.stop();
  });

  beforeEach(async () => {
    a = await startInstance();
    b = await startInstance();
    await waitForSync(a.cache, b.cache);
    await waitForSync(b.cache, a.cache);
  });

  afterEach(async () => {
    await closeApp(a);
    await closeApp(b);
  });

  it('a write on one instance is readable on the other', async () => {
    await a.cache.set('t1:k', { n: 1 });
    expect(await b.cache.get('t1:k')).toEqual({ n: 1 });
  });

  it('a delete on one instance invalidates L1 on the other within 2 s', async () => {
    await a.cache.set('t2:k', { n: 1 });
    await expectServedFromL1(redis, 't2:k', () => b.cache.get('t2:k'), { n: 1 });
    await a.cache.delete('t2:k');
    await vi.waitFor(
      async () => {
        expect(await b.cache.get('t2:k')).toBeUndefined();
      },
      { timeout: 2_000 },
    );
  });

  it('an overwrite on one instance is seen on the other within 2 s', async () => {
    await a.cache.set('t3:k', { n: 1 });
    await expectServedFromL1(redis, 't3:k', () => b.cache.get('t3:k'), { n: 1 });
    await a.cache.set('t3:k', { n: 2 });
    await vi.waitFor(
      async () => {
        expect(await b.cache.get('t3:k')).toEqual({ n: 2 });
      },
      { timeout: 2_000 },
    );
  });

  it('clear on one instance empties the namespace on the other', async () => {
    await a.cache.set('t4:k', { n: 1 }, { namespace: 'u' });
    await a.cache.set('t4:k', { n: 2 }, { namespace: 'p' });
    await expectServedFromL1(redis, 'u:t4:k', () => b.cache.get('t4:k', { namespace: 'u' }), {
      n: 1,
    });
    await expectServedFromL1(redis, 'p:t4:k', () => b.cache.get('t4:k', { namespace: 'p' }), {
      n: 2,
    });
    await a.cache.clear('u');
    await vi.waitFor(
      async () => {
        expect(await b.cache.get('t4:k', { namespace: 'u' })).toBeUndefined();
      },
      { timeout: 2_000 },
    );
    expect(await b.cache.get('t4:k', { namespace: 'p' })).toEqual({ n: 2 });
  });

  /* Closing the apps leaves the user's client open: it still serves commands afterwards. */
  it('closing the app does not close the user client', async () => {
    await closeApp(a);
    await closeApp(b);
    await a.ref.close(); // a second close is a no-op for the store
    const store = redisStore({ client: redis.client });
    await store.set('after-close', 'v', 5_000);
    expect(await store.get('after-close')).toBe('v');
    await store.close();
  });
});

describe('TieredStore (integration), ioredis standalone only', () => {
  let redis: { url: string; stop(): Promise<void> };

  beforeAll(async () => {
    redis = await startRedis();
  });

  afterAll(async () => {
    await redis.stop();
  });

  /* Each app's subscriber is one connection on the channel: NUMSUB is 2, then 0 after close. */
  it('closing the app closes the subscriber connections but not the user clients', async () => {
    const clients = [new Redis(redis.url), new Redis(redis.url)] as const;
    const refs: TestingModule[] = [];
    try {
      for (const client of clients) {
        const ref = await Test.createTestingModule({
          imports: [
            CacheModule.forRoot({
              stores: {
                default: tieredStore({
                  l1: memoryStore(),
                  l2: redisStore({ client }),
                  l1Ttl: 60_000,
                }),
              },
            }),
          ],
        }).compile();
        await ref.init();
        refs.push(ref);
      }
      await vi.waitFor(async () => {
        expect(await clients[0].pubsub('NUMSUB', CHANNEL)).toEqual([CHANNEL, 2]);
      });
      for (const ref of refs) await ref.close();
      await refs[0]!.close();
      expect(clients[0].status).toBe('ready');
      expect(clients[1].status).toBe('ready');
      await vi.waitFor(async () => {
        expect(await clients[0].pubsub('NUMSUB', CHANNEL)).toEqual([CHANNEL, 0]);
      });
    } finally {
      for (const client of clients) await client.quit();
    }
  });
});
