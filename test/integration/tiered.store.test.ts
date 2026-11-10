import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../../src/core/cache.service.js';
import { CacheModule } from '../../src/module/cache.module.js';
import { memoryStore } from '../../src/stores/memory.store.js';
import { redisStore } from '../../src/stores/redis.store.js';
import { tieredStore } from '../../src/stores/tiered.store.js';
import { startRedis } from './helpers/redis.js';

interface Instance {
  ref: TestingModule;
  client: Redis;
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

describe('TieredStore (integration)', () => {
  let redis: { url: string; stop(): Promise<void> };
  let a: Instance;
  let b: Instance;

  async function startInstance(): Promise<Instance> {
    const client = new Redis(redis.url);
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
    return { ref, client, cache: ref.get(CacheService), closed: false };
  }

  async function closeApp(instance: Instance): Promise<void> {
    if (instance.closed) return;
    instance.closed = true;
    await instance.ref.close();
  }

  beforeAll(async () => {
    redis = await startRedis();
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
    await a.client.quit();
    await b.client.quit();
  });

  it('a write on one instance is readable on the other', async () => {
    await a.cache.set('t1:k', { n: 1 });
    expect(await b.cache.get('t1:k')).toEqual({ n: 1 });
  });

  it('a delete on one instance invalidates L1 on the other within 2 s', async () => {
    await a.cache.set('t2:k', { n: 1 });
    expect(await b.cache.get('t2:k')).toEqual({ n: 1 }); // B đã có L1
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
    expect(await b.cache.get('t3:k')).toEqual({ n: 1 });
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
    expect(await b.cache.get('t4:k', { namespace: 'u' })).toEqual({ n: 1 });
    expect(await b.cache.get('t4:k', { namespace: 'p' })).toEqual({ n: 2 });
    await a.cache.clear('u');
    await vi.waitFor(
      async () => {
        expect(await b.cache.get('t4:k', { namespace: 'u' })).toBeUndefined();
      },
      { timeout: 2_000 },
    );
    expect(await b.cache.get('t4:k', { namespace: 'p' })).toEqual({ n: 2 });
  });

  it('closing the app closes the subscriber connections but not the user clients', async () => {
    expect(await a.client.pubsub('NUMSUB', CHANNEL)).toEqual([CHANNEL, 2]);
    await closeApp(a);
    await closeApp(b);
    await a.ref.close(); // a second close is a no-op for the store
    expect(a.client.status).toBe('ready');
    expect(b.client.status).toBe('ready');
    await vi.waitFor(async () => {
      expect(await a.client.pubsub('NUMSUB', CHANNEL)).toEqual([CHANNEL, 0]);
    });
  });
});
