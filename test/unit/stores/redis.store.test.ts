import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANNEL } from '../../../src/stores/redis-invalidation-bus.js';
import { RedisLock } from '../../../src/stores/redis-lock.js';
import { escapeGlob, redisStore } from '../../../src/stores/redis.store.js';
import { FakeRedis } from '../helpers/fake-redis.js';

describe('RedisStore', () => {
  it('escapeGlob escapes every glob metacharacter', () => {
    expect(escapeGlob('a*b?c[d]e\\f')).toBe('a\\*b\\?c\\[d\\]e\\\\f');
  });

  it('get/set/delete map to adapter commands', async () => {
    const fake = new FakeRedis();
    const store = redisStore({ client: fake });
    await store.set('k', 'v', 5);
    expect(fake.commands).toContainEqual({ name: 'set', args: ['k', 'v', 5] });
    expect(await store.get('k')).toBe('v');
    await store.delete(['a', 'b']);
    expect(fake.commands).toContainEqual({ name: 'unlink', args: [['a', 'b']] });
  });

  it('clear scans in batches until the cursor returns to 0', async () => {
    const fake = new FakeRedis();
    const store = redisStore({ client: fake });
    for (let i = 0; i < 250; i += 1) fake.data.set(`u:${i}`, 'v');
    for (let i = 0; i < 3; i += 1) fake.data.set(`p:${i}`, 'v');
    await store.clear('u:');
    expect([...fake.data.keys()].sort()).toEqual(['p:0', 'p:1', 'p:2']);
    const scans = fake.commands.filter((c) => c.name === 'scan');
    expect(scans.length).toBeGreaterThanOrEqual(3);
    for (const scan of scans) {
      expect(scan.args[1]).toBe('u:*');
      expect(scan.args[2]).toBe(100);
    }
  });

  it('clear escapes the prefix', async () => {
    const fake = new FakeRedis();
    await redisStore({ client: fake }).clear('a[1]:');
    expect(fake.commands.find((c) => c.name === 'scan')?.args[1]).toBe('a\\[1\\]:*');
  });

  it('getAndTouch uses getex', async () => {
    const fake = new FakeRedis();
    await redisStore({ client: fake }).getAndTouch('k', 9);
    expect(fake.commands).toContainEqual({ name: 'getex', args: ['k', 9] });
  });

  it('exposes one invalidation bus and closes it, not the client', async () => {
    const fake = new FakeRedis();
    const store = redisStore({ client: fake });
    await store.invalidation.subscribe(() => undefined);
    await store.close();
    await store.close();
    expect(fake.subscribers).toHaveLength(1);
    expect(fake.subscribers[0]?.closed).toBe(true);
  });

  it('publishes on the bus module default channel when none is given (F6)', async () => {
    expect(DEFAULT_CHANNEL).toBe('nestjs-cache:invalidate');
    const fake = new FakeRedis();
    await redisStore({ client: fake }).invalidation.publish({ origin: 'a', keys: ['k'] });
    expect(fake.commands).toContainEqual({
      name: 'publish',
      args: [DEFAULT_CHANNEL, '{"origin":"a","keys":["k"]}'],
    });
  });

  it('has a lock only when the adapter supports it', () => {
    function adapterWithout(name: 'setIfAbsent' | 'deleteIfEquals'): FakeRedis {
      const fake = new FakeRedis();
      Object.defineProperty(fake, name, { value: undefined });
      return fake;
    }
    const supported = redisStore({ client: new FakeRedis() });
    expect(supported.lock).toBeInstanceOf(RedisLock);
    expect('lock' in supported).toBe(true);
    for (const name of ['setIfAbsent', 'deleteIfEquals'] as const) {
      const store = redisStore({ client: adapterWithout(name) });
      expect(store.lock).toBeUndefined();
      expect('lock' in store).toBe(false);
      expect(Object.keys(store)).not.toContain('lock');
    }
  });
});
