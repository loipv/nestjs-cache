import { describe, expect, it } from 'vitest';
import { RedisLock } from '../../../src/stores/redis-lock.js';
import { FakeRedis } from '../helpers/fake-redis.js';

function calls(fake: FakeRedis, name: string): unknown[][] {
  return fake.commands.filter((c) => c.name === name).map((c) => c.args);
}

describe('RedisLock', () => {
  it('acquires under lock:<key> and rejects a second acquire', async () => {
    const fake = new FakeRedis();
    const lock = new RedisLock(fake);
    const handle = await lock.acquire('app:users:1', 1_000);
    expect(handle).toBeDefined();
    expect(fake.has('lock:app:users:1')).toBe(true);
    expect(await lock.acquire('app:users:1', 1_000)).toBeUndefined();
  });

  it('release frees the key and is idempotent', async () => {
    const fake = new FakeRedis();
    const lock = new RedisLock(fake);
    const handle = await lock.acquire('k', 1_000);
    await handle!.release();
    await handle!.release();
    expect(fake.has('lock:k')).toBe(false);
    expect(calls(fake, 'deleteIfEquals')).toHaveLength(1);
    expect(await lock.acquire('k', 1_000)).toBeDefined();
  });

  it('a stale handle never deletes a newer owner', async () => {
    const fake = new FakeRedis();
    const lock = new RedisLock(fake);
    const old = await lock.acquire('k', 1_000);
    fake.forceDelete('lock:k');
    const fresh = await lock.acquire('k', 1_000);
    await old!.release();
    expect(fresh).toBeDefined();
    expect(fake.has('lock:k')).toBe(true);
  });

  it('rounds the TTL to an integer >= 1', async () => {
    const fake = new FakeRedis();
    const lock = new RedisLock(fake);
    await lock.acquire('a', 0.4);
    await lock.acquire('b', 1.6);
    expect(calls(fake, 'setIfAbsent').map((args) => args[2])).toEqual([1, 2]);
  });

  it('uses a distinct token per acquire', async () => {
    const fake = new FakeRedis();
    const lock = new RedisLock(fake);
    await lock.acquire('a', 1_000);
    await lock.acquire('b', 1_000);
    const [first, second] = calls(fake, 'setIfAbsent');
    expect(first?.[1]).not.toBe(second?.[1]);
  });
});
