import { describe, expect, it, vi } from 'vitest';
import { circuitBreaker, CircuitOpenError } from '../../../src/resilience/circuit-breaker.store.js';
import { ioredisAdapter } from '../../../src/stores/ioredis.adapter.js';
import { memoryStore } from '../../../src/stores/memory.store.js';
import { redisStore } from '../../../src/stores/redis.store.js';
import { tieredStore } from '../../../src/stores/tiered.store.js';
import { FakeConnection } from '../helpers/fake-ioredis.js';
import { FakeRedis } from '../helpers/fake-redis.js';
import { FakeStore } from '../helpers/fake-store.js';

function pingable(ping: () => Promise<void> = () => Promise.resolve()): FakeRedis {
  const fake = new FakeRedis();
  fake.ping = ping;
  return fake;
}

describe('store ping', () => {
  it('ping presence follows the inner capability', async () => {
    expect('ping' in redisStore({ client: pingable() })).toBe(true);
    expect('ping' in redisStore({ client: new FakeRedis() })).toBe(false);
    const withPing = Object.assign(new FakeStore(), { ping: () => Promise.resolve() });
    expect('ping' in tieredStore({ l1: memoryStore(), l2: withPing })).toBe(true);
    expect('ping' in tieredStore({ l1: memoryStore(), l2: new FakeStore() })).toBe(false);
    expect('ping' in circuitBreaker(withPing)).toBe(true);
    expect('ping' in circuitBreaker(new FakeStore())).toBe(false);
    expect('ping' in memoryStore()).toBe(true);
    await expect(memoryStore().ping()).resolves.toBeUndefined();
  });

  it('redisStore and tieredStore delegate ping', async () => {
    const ping = vi.fn(() => Promise.resolve());
    await redisStore({ client: pingable(ping) }).ping?.();
    expect(ping).toHaveBeenCalledTimes(1);
    const l2 = Object.assign(new FakeStore(), { ping });
    await tieredStore({ l1: memoryStore(), l2 }).ping?.();
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('ioredisAdapter.ping calls PING', async () => {
    const connection = new FakeConnection();
    const adapter = ioredisAdapter(connection.asIoredis());
    await adapter.ping?.();
    expect(connection.ping).toHaveBeenCalledTimes(1);
  });

  it('breaker guards ping', async () => {
    const ping = vi.fn(() => Promise.reject(new Error('down')));
    const inner = Object.assign(new FakeStore(), { ping });
    const breaker = circuitBreaker(inner, { failureThreshold: 1 });
    await expect(breaker.ping?.()).rejects.toThrow('down');
    await expect(breaker.ping?.()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  describe('ping receiver', () => {
    class PingingStore extends FakeStore {
      receivers: unknown[] = [];

      ping(): Promise<void> {
        this.receivers.push(this);
        return Promise.resolve();
      }
    }

    it('tieredStore calls the L2 ping with the L2 as this', async () => {
      const l2 = new PingingStore();
      await tieredStore({ l1: memoryStore(), l2 }).ping?.();
      expect(l2.receivers).toEqual([l2]);
    });

    it('circuitBreaker calls the inner ping with the inner as this', async () => {
      const inner = new PingingStore();
      await circuitBreaker(inner).ping?.();
      expect(inner.receivers).toEqual([inner]);
    });
  });
});
