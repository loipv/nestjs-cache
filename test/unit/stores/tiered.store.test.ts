import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  circuitBreakerStore,
  CircuitOpenError,
} from '../../../src/resilience/circuit-breaker.store.js';
import type { CacheEventSink } from '../../../src/core/events.js';
import { CacheConfigError } from '../../../src/errors.js';
import { memoryStore, type MemoryStore } from '../../../src/stores/memory.store.js';
import { redisStore } from '../../../src/stores/redis.store.js';
import { tieredStore, type TieredStore } from '../../../src/stores/tiered.store.js';
import { FakeBus } from '../helpers/fake-bus.js';
import { FakeConnection } from '../helpers/fake-ioredis.js';
import { FakeStore } from '../helpers/fake-store.js';

const anyString: unknown = expect.any(String);
const anyError: unknown = expect.any(Error);

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('TieredStore', () => {
  let l1: MemoryStore;
  let l2: FakeStore;
  let bus: FakeBus;
  let sink: { emit: Mock };
  let store: TieredStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    l1 = memoryStore();
    l2 = new FakeStore();
    bus = new FakeBus();
    sink = { emit: vi.fn() };
    store = tieredStore({ l1, l2, invalidation: bus });
    store.bind(sink);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('serves from L1 without touching L2', async () => {
    await store.set('k', 'v', 60_000);
    expect(await store.get('k')).toBe('v');
    expect(l2.calls.filter((c) => c.op === 'get')).toEqual([]);
  });

  it('backfills L1 from L2 with l1Ttl', async () => {
    l2.data.set('k', { value: 'v', ttlMs: 60_000 });
    expect(await store.get('k')).toBe('v');
    l2.data.clear();
    expect(await store.get('k')).toBe('v'); // lần hai đến từ L1
    vi.advanceTimersByTime(10_000);
    expect(await store.get('k')).toBeUndefined();
  });

  it('writes L2 with the full TTL and L1 with the capped TTL, then publishes', async () => {
    await store.set('k', 'v', 60_000);
    expect(l2.data.get('k')?.ttlMs).toBe(60_000);
    expect(bus.published).toEqual([{ origin: anyString, keys: ['k'] }]);
    l2.data.clear();
    vi.advanceTimersByTime(9_999);
    expect(await store.get('k')).toBe('v');
    vi.advanceTimersByTime(1);
    expect(await store.get('k')).toBeUndefined();
  });

  it('keeps a TTL shorter than l1Ttl in L1', async () => {
    await store.set('k', 'v', 5_000);
    expect(l2.data.get('k')?.ttlMs).toBe(5_000);
    l2.data.clear();
    vi.advanceTimersByTime(4_999);
    expect(await store.get('k')).toBe('v');
    vi.advanceTimersByTime(1);
    expect(await store.get('k')).toBeUndefined();
  });

  it('delete and clear hit both tiers and publish', async () => {
    await store.set('k', 'v', 60_000);
    await store.set('u:1', 'v', 60_000);
    await store.set('p:1', 'v', 60_000);
    await store.delete(['k']);
    await store.clear('u:');
    expect(l2.calls.map((c) => c.op)).toEqual(['set', 'set', 'set', 'delete', 'clear']);
    expect([...l2.data.keys()]).toEqual(['p:1']);
    expect(await l1.get('k')).toBeUndefined();
    expect(await l1.get('u:1')).toBeUndefined();
    expect(await l1.get('p:1')).toBe('v');
    expect(bus.published).toContainEqual({ origin: anyString, keys: ['k'] });
    expect(bus.published).toContainEqual({ origin: anyString, prefix: 'u:' });
  });

  it('does not publish an empty key list', async () => {
    await store.delete([]);
    expect(bus.published).toEqual([]);
  });

  it('drops L1 entries named by a foreign message', async () => {
    await store.set('k', 'v', 60_000);
    bus.deliver({ origin: 'other', keys: ['k'] });
    l2.data.clear();
    expect(await store.get('k')).toBeUndefined();
  });

  it('ignores its own messages', async () => {
    await store.set('k', 'v', 60_000);
    bus.deliver(bus.published[0]!);
    l2.data.clear();
    expect(await store.get('k')).toBe('v');
  });

  it('clears an L1 prefix on a foreign prefix message', async () => {
    await store.set('u:1', 'v', 60_000);
    await store.set('p:1', 'v', 60_000);
    bus.deliver({ origin: 'other', prefix: 'u:' });
    l2.data.clear();
    expect(await store.get('u:1')).toBeUndefined();
    expect(await store.get('p:1')).toBe('v');
  });

  it('empties L1 on reconnect', async () => {
    await store.set('a', 'v', 60_000);
    await store.set('b', 'v', 60_000);
    bus.triggerReconnect();
    l2.data.clear();
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('b')).toBeUndefined();
  });

  it('uses a different origin per instance', async () => {
    const otherBus = new FakeBus();
    const other = tieredStore({ l1: memoryStore(), l2: new FakeStore(), invalidation: otherBus });
    await store.set('k', 'v', 1_000);
    await other.set('k', 'v', 1_000);
    expect(bus.published[0]!.origin).not.toBe(otherBus.published[0]!.origin);
  });

  it('treats an L2 read failure as a miss and reports it', async () => {
    l2.failNext('get');
    await expect(store.get('k')).resolves.toBeUndefined();
    expect(sink.emit).toHaveBeenCalledWith('error', { operation: 'get', error: anyError });
  });

  it('still writes L1 when L2 fails, and reports', async () => {
    l2.failNext('set');
    await expect(store.set('k', 'v', 60_000)).resolves.toBeUndefined();
    expect(await l1.get('k')).toBe('v');
    expect(sink.emit).toHaveBeenCalledWith('error', { operation: 'set', error: anyError });
    expect(bus.published).toEqual([{ origin: anyString, keys: ['k'] }]);
  });

  it('still clears L1 and publishes when an L2 delete or clear fails, and reports', async () => {
    await store.set('k', 'v', 60_000);
    await store.set('u:1', 'v', 60_000);
    l2.failNext('delete');
    l2.failNext('clear');
    await expect(store.delete(['k'])).resolves.toBeUndefined();
    await expect(store.clear('u:')).resolves.toBeUndefined();
    expect(await l1.get('k')).toBeUndefined();
    expect(await l1.get('u:1')).toBeUndefined();
    expect(sink.emit).toHaveBeenCalledWith('error', {
      operation: 'delete',
      error: anyError,
    });
    expect(sink.emit).toHaveBeenCalledWith('error', { operation: 'clear', error: anyError });
    expect(bus.published).toContainEqual({ origin: anyString, keys: ['k'] });
    expect(bus.published).toContainEqual({ origin: anyString, prefix: 'u:' });
  });

  it('reports publish and subscribe failures without rejecting', async () => {
    bus.failNext('publish');
    await expect(store.set('k', 'v', 1_000)).resolves.toBeUndefined();
    expect(sink.emit).toHaveBeenCalledWith('error', {
      operation: 'publish',
      error: anyError,
    });

    const failing = new FakeBus();
    failing.failNext('subscribe');
    const otherSink = { emit: vi.fn() };
    tieredStore({ l1: memoryStore(), l2: new FakeStore(), invalidation: failing }).bind(otherSink);
    await flush();
    expect(otherSink.emit).toHaveBeenCalledWith('error', {
      operation: 'subscribe',
      error: anyError,
    });
  });

  it('reports bus errors as subscribe errors (F2)', () => {
    const error = new Error('ECONNREFUSED');
    expect(() => {
      bus.triggerError(error);
    }).not.toThrow();
    expect(sink.emit).toHaveBeenCalledWith('error', { operation: 'subscribe', error });
  });

  it('works with a bus that has no onError, and reports a throwing onError (F2)', async () => {
    const plain = Object.assign(new FakeBus(), { onError: undefined });
    const s = tieredStore({ l1: memoryStore(), l2: new FakeStore(), invalidation: plain });
    expect(() => {
      s.bind({ emit: vi.fn() });
    }).not.toThrow();

    const throwing = new FakeBus();
    throwing.onError = (): never => {
      throw new Error('onError failed');
    };
    const remote = new FakeStore();
    const t = tieredStore({ l1: memoryStore(), l2: remote, invalidation: throwing });
    const local = { emit: vi.fn() };
    t.bind(local);
    expect(local.emit).toHaveBeenCalledWith('error', { operation: 'subscribe', error: anyError });
    await t.set('k', 'v', 60_000);
    throwing.deliver({ origin: 'other', keys: ['k'] });
    remote.data.clear();
    expect(await t.get('k')).toBeUndefined(); // still subscribed
  });

  it('ends up subscribed once Redis is reachable after a failed first subscribe (F1)', async () => {
    const client = new FakeConnection();
    const connection = client.prepareDuplicate();
    connection.failNextSubscribe();
    const local = memoryStore();
    const s = tieredStore({ l1: local, l2: redisStore({ client: client.asIoredis() }) });
    const events = { emit: vi.fn() };
    s.bind(events);
    await flush();
    expect(events.emit).toHaveBeenCalledWith('error', { operation: 'subscribe', error: anyError });

    await local.set('cached-while-unsubscribed', 'v', 60_000);
    connection.emit('ready'); // Redis is reachable: the first ready after the failure
    await flush();
    // messages were missed while unsubscribed, so L1 is emptied as on a reconnect
    expect(await local.get('cached-while-unsubscribed')).toBeUndefined();

    await s.set('k', 'v', 60_000);
    expect(await local.get('k')).toBe('v');
    await client.publish('nestjs-cache:invalidate', '{"origin":"other","keys":["k"]}');
    await flush();
    expect(await local.get('k')).toBeUndefined();
  });

  it('clears the whole L1 on an oversized invalidation message', async () => {
    /* the bus turns a message over 1 MiB into a full clear with an origin no instance has */
    const client = new FakeConnection();
    const connection = client.prepareDuplicate();
    const local = memoryStore();
    const s = tieredStore({ l1: local, l2: redisStore({ client: client.asIoredis() }) });
    s.bind({ emit: vi.fn() });
    await flush();
    await local.set('users:1', 'a', 60_000);
    await local.set('other', 'b', 60_000);
    connection.publishRemote('nestjs-cache:invalidate', 'x'.repeat(1_048_577));
    await flush();
    expect(await local.get('users:1')).toBeUndefined();
    expect(await local.get('other')).toBeUndefined();
  });

  it('swallows failures before bind', async () => {
    const unbound = tieredStore({ l1: memoryStore(), l2, invalidation: bus });
    l2.failNext('get');
    bus.failNext('publish');
    await expect(unbound.get('k')).resolves.toBeUndefined();
    await expect(unbound.set('k', 'v', 1_000)).resolves.toBeUndefined();
  });

  it('prefers options.invalidation over l2.invalidation', async () => {
    const own = new FakeBus();
    const passed = new FakeBus();
    const s = tieredStore({
      l1: memoryStore(),
      l2: Object.assign(new FakeStore(), { invalidation: own }),
      invalidation: passed,
    });
    s.bind({ emit: vi.fn() });
    await s.set('k', 'v', 1_000);
    expect(passed.published).toHaveLength(1);
    expect(own.published).toEqual([]);
  });

  it('falls back to l2.invalidation', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const own = new FakeBus();
    const s = tieredStore({
      l1: memoryStore(),
      l2: Object.assign(new FakeStore(), { invalidation: own }),
    });
    s.bind({ emit: vi.fn() });
    await s.set('k', 'v', 1_000);
    expect(own.published).toEqual([{ origin: anyString, keys: ['k'] }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once and still works without any bus', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const plain = tieredStore({ l1: memoryStore(), l2: new FakeStore() });
    plain.bind({ emit: vi.fn() });
    await plain.set('k', 'v', 1_000);
    expect(await plain.get('k')).toBe('v');
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips the missing-bus warning when the sink's level is off", () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    tieredStore({ l1: memoryStore(), l2: new FakeStore() }).bind({
      emit: vi.fn(),
      logLevel: 'off',
    });
    expect(warn).not.toHaveBeenCalled();
    tieredStore({ l1: memoryStore(), l2: new FakeStore() }).bind({
      emit: vi.fn(),
      logLevel: 'debug',
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('a hand-built sink with no logLevel still gets the missing-bus warning', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const handBuilt: CacheEventSink = { emit: () => undefined };
    tieredStore({ l1: memoryStore(), l2: new FakeStore() }).bind(handBuilt);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'TieredStore has no invalidation bus: other instances keep stale L1 entries for up to l1Ttl after a write or delete',
    );
  });

  it('warns only once per instance even when bound twice', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const plain = tieredStore({ l1: memoryStore(), l2: new FakeStore() });
    plain.bind({ emit: vi.fn() });
    plain.bind({ emit: vi.fn() });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('binds both tiers with the same sink', () => {
    const fakeL1 = new FakeStore();
    const fakeL2 = new FakeStore();
    const s = tieredStore({ l1: fakeL1, l2: fakeL2, invalidation: new FakeBus() });
    const other = { emit: vi.fn() };
    s.bind(other);
    expect(fakeL1.bind).toHaveBeenCalledWith(other);
    expect(fakeL2.bind).toHaveBeenCalledWith(other);
    expect(l2.bind).toHaveBeenCalledWith(sink);
  });

  it('closes both tiers and an explicitly passed bus exactly once', async () => {
    const fakeL1 = new FakeStore();
    const s = tieredStore({ l1: fakeL1, l2, invalidation: bus });
    await s.close();
    await s.close();
    expect(fakeL1.close).toHaveBeenCalledOnce();
    expect(l2.close).toHaveBeenCalledOnce();
    expect(bus.closed).toBe(true);
  });

  it('leaves closing l2.invalidation to l2', async () => {
    const own = new FakeBus();
    const s = tieredStore({
      l1: memoryStore(),
      l2: Object.assign(new FakeStore(), { invalidation: own }),
    });
    await s.close();
    expect(own.closed).toBe(false);
  });

  it('never rejects from close', async () => {
    const fakeL1 = new FakeStore();
    fakeL1.close.mockRejectedValueOnce(new Error('l1 close failed'));
    l2.close.mockImplementationOnce(() => {
      throw new Error('l2 close failed');
    });
    const s = tieredStore({ l1: fakeL1, l2, invalidation: bus });
    await expect(s.close()).resolves.toBeUndefined();
    expect(bus.closed).toBe(true);
  });

  it('bus handlers never throw and report L1 failures', async () => {
    const fakeL1 = new FakeStore();
    const s = tieredStore({ l1: fakeL1, l2: new FakeStore(), invalidation: bus });
    const local = { emit: vi.fn() };
    s.bind(local);
    fakeL1.failNext('delete');
    fakeL1.failNext('clear');
    fakeL1.failNext('clear');
    expect(() => {
      bus.deliver({ origin: 'other', keys: ['k'] });
      bus.deliver({ origin: 'other', prefix: 'u:' });
      bus.triggerReconnect();
    }).not.toThrow();
    await flush();
    expect(local.emit).toHaveBeenCalledWith('error', {
      operation: 'delete',
      error: anyError,
    });
    expect(
      local.emit.mock.calls.filter(([, p]) => (p as { operation: string }).operation === 'clear'),
    ).toHaveLength(2);
  });

  it('treats an L1 read failure as a miss, reads L2 and reports it', async () => {
    const fakeL1 = new FakeStore();
    const s = tieredStore({ l1: fakeL1, l2, invalidation: new FakeBus() });
    s.bind(sink);
    l2.data.set('k', { value: 'v', ttlMs: 60_000 });
    fakeL1.failNext('get');
    await expect(s.get('k')).resolves.toBe('v');
    expect(sink.emit).toHaveBeenCalledWith('error', { operation: 'get', error: anyError });
  });

  it('reports a throwing onReconnect as a subscribe failure and still subscribes', async () => {
    const throwing = new FakeBus();
    throwing.onReconnect = (): never => {
      throw new Error('onReconnect failed');
    };
    const remote = new FakeStore();
    const s = tieredStore({ l1: memoryStore(), l2: remote, invalidation: throwing });
    const local = { emit: vi.fn() };
    expect(() => {
      s.bind(local);
    }).not.toThrow();
    expect(local.emit).toHaveBeenCalledWith('error', { operation: 'subscribe', error: anyError });
    await s.set('k', 'v', 60_000);
    throwing.deliver({ origin: 'other', keys: ['k'] });
    remote.data.clear();
    expect(await s.get('k')).toBeUndefined(); // the message handler is subscribed
  });

  it('bus handlers survive an L1 that throws synchronously', async () => {
    const fakeL1 = new FakeStore();
    const boom = (): never => {
      throw new Error('sync boom');
    };
    fakeL1.delete = boom;
    fakeL1.clear = boom;
    const s = tieredStore({ l1: fakeL1, l2: new FakeStore(), invalidation: bus });
    const local = { emit: vi.fn() };
    s.bind(local);
    expect(() => {
      bus.deliver({ origin: 'other', keys: ['k'] });
      bus.triggerReconnect();
    }).not.toThrow();
    await flush();
    expect(local.emit).toHaveBeenCalledWith('error', {
      operation: 'delete',
      error: anyError,
    });
    expect(local.emit).toHaveBeenCalledWith('error', { operation: 'clear', error: anyError });
  });

  describe('per-key backfill guard', () => {
    let replies: Map<string, (reply: string | Error) => void>;

    beforeEach(() => {
      replies = new Map();
      // L2 reads stay in flight until the test answers them.
      l2.get = (key: string): Promise<string | undefined> =>
        new Promise((resolve, reject) => {
          replies.set(key, (reply) => {
            if (reply instanceof Error) reject(reply);
            else resolve(reply);
          });
        });
    });

    /** Wrapped in an object: returning the bare promise from an async function would await it. */
    async function startRead(key: string): Promise<{ read: Promise<string | undefined> }> {
      const read = store.get(key);
      await flush(); // L1 missed; the L2 read is now in flight
      return { read };
    }

    async function answer(
      key: string,
      { read }: { read: Promise<string | undefined> },
      reply: string | Error = 'old',
    ): Promise<void> {
      replies.get(key)!(reply);
      await expect(read).resolves.toBe(reply instanceof Error ? undefined : reply);
    }

    function pendingSize(): number {
      return (store as unknown as { pending: Map<string, symbol> }).pending.size;
    }

    it('backfills when nothing touches the key', async () => {
      const read = await startRead('k');
      await answer('k', read);
      expect(await l1.get('k')).toBe('old');
    });

    it('an unrelated local write or foreign message does not suppress the backfill', async () => {
      const read = await startRead('k');
      await store.set('other', 'v', 60_000);
      await store.delete(['other2']);
      bus.deliver({ origin: 'other', keys: ['other3'] });
      await answer('k', read);
      expect(await l1.get('k')).toBe('old');
    });

    it('a foreign keys message for the key suppresses the backfill', async () => {
      const read = await startRead('k');
      bus.deliver({ origin: 'other', keys: ['k'] });
      await answer('k', read);
      expect(await l1.get('k')).toBeUndefined();
    });

    it('a local set of the key suppresses the backfill', async () => {
      const read = await startRead('k');
      await store.set('k', 'new', 60_000);
      await answer('k', read);
      expect(await l1.get('k')).toBe('new');
    });

    it('a local delete of the key suppresses the backfill', async () => {
      const read = await startRead('k');
      await store.delete(['k']);
      await answer('k', read);
      expect(await l1.get('k')).toBeUndefined();
    });

    it('a local clear covering the key suppresses the backfill', async () => {
      const read = await startRead('u:1');
      await store.clear('u:');
      await answer('u:1', read);
      expect(await l1.get('u:1')).toBeUndefined();
    });

    it('a prefix message covering the key suppresses the backfill; another prefix does not', async () => {
      const covered = await startRead('u:1');
      const uncovered = await startRead('p:1');
      bus.deliver({ origin: 'other', prefix: 'u:' });
      await answer('u:1', covered);
      await answer('p:1', uncovered);
      expect(await l1.get('u:1')).toBeUndefined();
      expect(await l1.get('p:1')).toBe('old');
    });

    it('a reconnect suppresses the backfill', async () => {
      const read = await startRead('k');
      bus.triggerReconnect();
      await answer('k', read);
      expect(await l1.get('k')).toBeUndefined();
    });

    it('leaves no pending entries once reads settle', async () => {
      const ok = await startRead('a');
      const invalidated = await startRead('b');
      const failed = await startRead('c');
      expect(pendingSize()).toBe(3);
      bus.deliver({ origin: 'other', keys: ['b'] });
      await answer('a', ok);
      await answer('b', invalidated);
      await answer('c', failed, new Error('l2 down'));
      expect(pendingSize()).toBe(0);
      expect(sink.emit).toHaveBeenCalledWith('error', { operation: 'get', error: anyError });
    });

    it('a newer read of the same key keeps the map clean in either completion order', async () => {
      const first = store.get('k');
      await flush();
      const answerFirst = replies.get('k')!;
      const second = store.get('k');
      await flush();
      const answerSecond = replies.get('k')!;
      answerSecond('v2');
      expect(await second).toBe('v2');
      answerFirst('v1');
      expect(await first).toBe('v1');
      expect(pendingSize()).toBe(0);
      expect(await l1.get('k')).toBe('v2'); // the older read did not overwrite the newer backfill
    });
  });

  it('honours a custom l1Ttl', async () => {
    const remote = new FakeStore();
    const s = tieredStore({ l1: memoryStore(), l2: remote, l1Ttl: 2_000 });
    await s.set('k', 'v', 60_000);
    remote.data.clear();
    vi.advanceTimersByTime(1_999);
    expect(await s.get('k')).toBe('v');
    vi.advanceTimersByTime(1);
    expect(await s.get('k')).toBeUndefined();
  });

  it.each([0, -1, Number.NaN])('rejects l1Ttl %s', (n) => {
    expect(() => tieredStore({ l1, l2, l1Ttl: n })).toThrow(CacheConfigError);
  });

  it('rejects an infinite l1Ttl', () => {
    expect(() => tieredStore({ l1, l2, l1Ttl: Number.POSITIVE_INFINITY })).toThrow(
      CacheConfigError,
    );
  });

  it('exposes the L2 lock', () => {
    const fakeLock = { acquire: vi.fn() };
    const withLock = Object.assign(new FakeStore(), { lock: fakeLock });
    expect(tieredStore({ l1: memoryStore(), l2: withLock }).lock).toBe(fakeLock);
    expect('lock' in tieredStore({ l1: memoryStore(), l2: withLock })).toBe(true);
    const without = tieredStore({ l1: memoryStore(), l2: new FakeStore() });
    expect(without.lock).toBeUndefined();
    expect('lock' in without).toBe(false);
    expect(Object.keys(without)).not.toContain('lock');
  });

  describe('getAndTouch', () => {
    class TouchStore extends FakeStore {
      readonly touch = vi.fn((key: string, ttlMs: number): Promise<string | undefined> => {
        const entry = this.data.get(key);
        if (entry) this.data.set(key, { value: entry.value, ttlMs });
        return Promise.resolve(entry?.value);
      });
      getAndTouch(key: string, ttlMs: number): Promise<string | undefined> {
        return this.touch(key, ttlMs);
      }
    }

    it('reads L1 without touching it or calling L2', async () => {
      await l1.set('k', 'v', 5_000);
      expect(await store.getAndTouch('k', 60_000)).toBe('v');
      expect(l2.calls.filter((c) => c.op === 'get')).toHaveLength(0);
      vi.advanceTimersByTime(5_000);
      expect(await l1.get('k')).toBeUndefined();
    });

    it('touches L2 and backfills L1 with min(ttl, l1Ttl)', async () => {
      const touching = new TouchStore();
      touching.data.set('k', { value: 'v', ttlMs: 1 });
      const t = tieredStore({ l1, l2: touching, invalidation: bus });
      t.bind(sink);
      expect(await t.getAndTouch('k', 60_000)).toBe('v');
      expect(touching.touch).toHaveBeenCalledWith('k', 60_000);
      expect(touching.calls.filter((c) => c.op === 'get')).toHaveLength(0);
      vi.advanceTimersByTime(9_999);
      expect(await l1.get('k')).toBe('v');
      vi.advanceTimersByTime(1);
      expect(await l1.get('k')).toBeUndefined();
    });

    it('backfills with the requested ttl when it is below l1Ttl', async () => {
      const touching = new TouchStore();
      touching.data.set('k', { value: 'v', ttlMs: 1 });
      const t = tieredStore({ l1, l2: touching, invalidation: bus });
      expect(await t.getAndTouch('k', 2_000)).toBe('v');
      vi.advanceTimersByTime(2_000);
      expect(await l1.get('k')).toBeUndefined();
    });

    it('falls back to l2.get when L2 has no getAndTouch', async () => {
      l2.data.set('k', { value: 'v', ttlMs: 1 });
      expect(await store.getAndTouch('k', 60_000)).toBe('v');
      expect(l2.calls.filter((c) => c.op === 'get')).toHaveLength(1);
      vi.advanceTimersByTime(9_999);
      expect(await l1.get('k')).toBe('v');
    });

    it('does not backfill across an invalidation', async () => {
      const touching = new TouchStore();
      touching.data.set('k', { value: 'old', ttlMs: 1 });
      const t = tieredStore({ l1, l2: touching, invalidation: bus });
      t.bind(sink);
      await flush();
      let release: () => void = () => undefined;
      touching.touch.mockImplementationOnce(
        (): Promise<string | undefined> =>
          new Promise((resolve) => {
            release = () => {
              resolve('old');
            };
          }),
      );
      const result = t.getAndTouch('k', 60_000);
      await flush();
      bus.deliver({ origin: 'other', keys: ['k'] });
      release();
      expect(await result).toBe('old');
      expect(await l1.get('k')).toBeUndefined();
    });

    it('an older overlapping read neither backfills nor removes the newer token', async () => {
      const touching = new TouchStore();
      const replies: ((value: string) => void)[] = [];
      touching.touch.mockImplementation(
        (): Promise<string | undefined> =>
          new Promise((resolve) => {
            replies.push(resolve);
          }),
      );
      const t = tieredStore({ l1, l2: touching, invalidation: bus });
      t.bind(sink);
      const pending = (t as unknown as { pending: Map<string, symbol> }).pending;
      const older = t.getAndTouch('k', 60_000);
      await flush();
      const olderToken = pending.get('k');
      const newer = t.getAndTouch('k', 60_000);
      await flush();
      expect(replies).toHaveLength(2);
      const newerToken = pending.get('k');
      expect(newerToken).toBeDefined();
      expect(newerToken).not.toBe(olderToken);

      replies[0]!('v1');
      expect(await older).toBe('v1');
      expect(await l1.get('k')).toBeUndefined(); // the older read did not backfill
      expect(pending.get('k')).toBe(newerToken); // and left the newer token in place

      replies[1]!('v2');
      expect(await newer).toBe('v2');
      expect(await l1.get('k')).toBe('v2'); // the newer read still backfills
      expect(pending.size).toBe(0);
    });

    it('reports an L2 failure as get and resolves undefined', async () => {
      const touching = new TouchStore();
      const boom = new Error('boom');
      touching.touch.mockRejectedValueOnce(boom);
      const t = tieredStore({ l1, l2: touching, invalidation: bus });
      t.bind(sink);
      expect(await t.getAndTouch('k', 1_000)).toBeUndefined();
      expect(sink.emit).toHaveBeenCalledWith('error', { operation: 'get', error: boom });
    });

    it('reports an L1 failure as get and still reads L2', async () => {
      l2.data.set('k', { value: 'v', ttlMs: 1 });
      const boom = new Error('l1 down');
      vi.spyOn(l1, 'get').mockRejectedValueOnce(boom);
      expect(await store.getAndTouch('k', 1_000)).toBe('v');
      expect(sink.emit).toHaveBeenCalledWith('error', { operation: 'get', error: boom });
    });

    it('reports a backfill failure as set and still returns the value', async () => {
      l2.data.set('k', { value: 'v', ttlMs: 1 });
      const boom = new Error('l1 set');
      vi.spyOn(l1, 'set').mockRejectedValueOnce(boom);
      expect(await store.getAndTouch('k', 1_000)).toBe('v');
      expect(sink.emit).toHaveBeenCalledWith('error', { operation: 'set', error: boom });
    });
  });

  describe('getStrict and setStrict', () => {
    /* The key is in L1: getStrict returns it and L2 is never read. */
    it('getStrict returns an L1 hit without reading L2', async () => {
      await l1.set('k', 'v', 5_000);
      expect(await store.getStrict('k')).toBe('v');
      expect(l2.calls.filter((c) => c.op === 'get')).toEqual([]);
    });

    /* L1 misses and L2 rejects: getStrict rejects with that same error and reports one get
       error, instead of resolving undefined as get does. */
    it('getStrict rejects with the L2 error and reports a get error when L1 misses', async () => {
      const l2Error = new Error('l2 down');
      l2.failNext('get', l2Error);
      await expect(store.getStrict('k')).rejects.toBe(l2Error);
      expect(sink.emit.mock.calls).toEqual([['error', { operation: 'get', error: l2Error }]]);
      const pending = (store as unknown as { pending: Map<string, symbol> }).pending;
      expect(pending.size).toBe(0);
    });

    /* L2 is an open circuit breaker: getStrict rejects with CircuitOpenError, which is not
       reported (an open circuit is an absent store, not a broken one). */
    it('getStrict rejects with CircuitOpenError from a breaker-wrapped L2', async () => {
      const inner = new FakeStore();
      const t = tieredStore({
        l1: memoryStore(),
        l2: circuitBreakerStore(inner, { failureThreshold: 1 }),
        invalidation: bus,
      });
      t.bind(sink);
      inner.failNext('get', new Error('down'));
      expect(await t.get('a')).toBeUndefined();
      sink.emit.mockClear();
      await expect(t.getStrict('k')).rejects.toBeInstanceOf(CircuitOpenError);
      expect(sink.emit).not.toHaveBeenCalled();
    });

    /* An L2 hit is backfilled into L1 with l1Ttl, as get does; an L2 miss is a real miss and
       resolves undefined without any error. */
    it('getStrict backfills L1 on an L2 hit and resolves undefined on an L2 miss', async () => {
      l2.data.set('k', { value: 'v', ttlMs: 60_000 });
      expect(await store.getStrict('k')).toBe('v');
      vi.advanceTimersByTime(9_999);
      expect(await l1.get('k')).toBe('v');
      vi.advanceTimersByTime(1);
      expect(await l1.get('k')).toBeUndefined();
      await expect(store.getStrict('missing')).resolves.toBeUndefined();
      expect(await l1.get('missing')).toBeUndefined();
      expect(sink.emit).not.toHaveBeenCalled();
    });

    /* L1 throws on read: reported as a get error and treated as a miss, so L2 is read. */
    it('getStrict treats an L1 read failure as a miss and reads L2', async () => {
      l2.data.set('k', { value: 'v', ttlMs: 60_000 });
      const boom = new Error('l1 down');
      vi.spyOn(l1, 'get').mockRejectedValueOnce(boom);
      expect(await store.getStrict('k')).toBe('v');
      expect(sink.emit).toHaveBeenCalledWith('error', { operation: 'get', error: boom });
    });

    /* L2 rejects the write: setStrict reports a set error and rejects with it; L1 is not
       written and nothing is published. An open circuit rejects the same way, unreported. */
    it('setStrict rejects and neither writes L1 nor publishes when L2 fails', async () => {
      const publish = vi.spyOn(bus, 'publish');
      const l2Error = new Error('l2 down');
      l2.failNext('set', l2Error);
      await expect(store.setStrict('k', 'v', 60_000)).rejects.toBe(l2Error);
      expect(await l1.get('k')).toBeUndefined();
      expect(publish).not.toHaveBeenCalled();
      expect(sink.emit.mock.calls).toEqual([['error', { operation: 'set', error: l2Error }]]);

      sink.emit.mockClear();
      l2.failNext('set', new CircuitOpenError());
      await expect(store.setStrict('k', 'v', 60_000)).rejects.toBeInstanceOf(CircuitOpenError);
      expect(await l1.get('k')).toBeUndefined();
      expect(publish).not.toHaveBeenCalled();
      expect(sink.emit).not.toHaveBeenCalled();
    });

    /* L2 stores the value with the full TTL, then L1 with min(ttl, l1Ttl), then one message
       is published, in that order. */
    it('setStrict writes L2, then L1 with min(ttl, l1Ttl), then publishes', async () => {
      const l2Set = vi.spyOn(l2, 'set');
      const l1Set = vi.spyOn(l1, 'set');
      const publish = vi.spyOn(bus, 'publish');
      await store.setStrict('k', 'v', 60_000);
      expect(l2Set).toHaveBeenCalledWith('k', 'v', 60_000);
      expect(l1Set).toHaveBeenCalledWith('k', 'v', 10_000);
      expect(publish).toHaveBeenCalledWith({ origin: anyString, keys: ['k'] });
      const [l2Order] = l2Set.mock.invocationCallOrder;
      const [l1Order] = l1Set.mock.invocationCallOrder;
      const [publishOrder] = publish.mock.invocationCallOrder;
      expect(l2Order).toBeLessThan(l1Order ?? 0);
      expect(l1Order).toBeLessThan(publishOrder ?? 0);

      await store.setStrict('short', 'v', 5_000);
      expect(l1Set).toHaveBeenLastCalledWith('short', 'v', 5_000);
      expect(sink.emit).not.toHaveBeenCalled();
    });
  });

  describe('open circuit on L2', () => {
    it('L2 open circuit: L1 written, no publish, no sink error', async () => {
      l2.failNext('set', new CircuitOpenError());
      await store.set('k', 'v', 1_000);
      expect(await l1.get('k')).toBe('v');
      expect(bus.published).toEqual([]);
      expect(sink.emit).not.toHaveBeenCalled();
    });

    it('L2 open circuit on get and getAndTouch reports nothing', async () => {
      l2.failNext('get', new CircuitOpenError());
      expect(await store.get('k')).toBeUndefined();
      // No getAndTouch on L2: the touching read falls back to l2.get.
      l2.failNext('get', new CircuitOpenError());
      expect(await store.getAndTouch('k', 1_000)).toBeUndefined();
      const touching = Object.assign(new FakeStore(), {
        getAndTouch: vi.fn(() => Promise.reject(new CircuitOpenError())),
      });
      const t = tieredStore({ l1, l2: touching, invalidation: bus });
      t.bind(sink);
      expect(await t.getAndTouch('k', 1_000)).toBeUndefined();
      expect(touching.getAndTouch).toHaveBeenCalledOnce();
      expect(sink.emit).not.toHaveBeenCalled();
    });

    it('L2 open circuit on delete and clear skips publish', async () => {
      l2.failNext('delete', new CircuitOpenError());
      l2.failNext('clear', new CircuitOpenError());
      await store.delete(['k']);
      await store.clear('p:');
      expect(bus.published).toEqual([]);
      expect(sink.emit).not.toHaveBeenCalled();
    });

    it('other L2 errors still publish and report', async () => {
      l2.failNext('set', new Error('boom'));
      await store.set('k', 'v', 1_000);
      expect(bus.published).toHaveLength(1);
      expect(sink.emit).toHaveBeenCalledWith('error', { operation: 'set', error: anyError });
    });

    it('a circuit breaker as L2 serves from L1 while open', async () => {
      const inner = new FakeStore();
      const tiered = tieredStore({
        l1: memoryStore(),
        l2: circuitBreakerStore(inner, { failureThreshold: 1 }),
        invalidation: bus,
      });
      tiered.bind(sink);
      inner.failNext('set', new Error('down'));
      await tiered.set('a', '1', 1_000);
      sink.emit.mockClear();
      bus.published.length = 0;
      await tiered.set('k', 'v', 1_000);
      expect(await tiered.get('k')).toBe('v');
      expect(bus.published).toEqual([]);
      expect(sink.emit).not.toHaveBeenCalledWith('error', expect.anything());
    });
  });
});

describe('TieredStore batch', () => {
  /** A FakeStore with getMany/setMany that count batch calls. */
  class BatchStore extends FakeStore {
    getManyCalls: (readonly string[])[] = [];
    setManyCalls: unknown[] = [];
    getManyFn: ((keys: readonly string[]) => Promise<(string | undefined)[]>) | undefined;
    getMany(keys: readonly string[]): Promise<(string | undefined)[]> {
      this.getManyCalls.push(keys);
      if (this.getManyFn) return this.getManyFn(keys);
      return Promise.resolve(keys.map((k) => this.data.get(k)?.value));
    }
    setMany(entries: readonly { key: string; value: string; ttlMs: number }[]): Promise<void> {
      this.setManyCalls.push(entries);
      for (const e of entries) this.data.set(e.key, { value: e.value, ttlMs: e.ttlMs });
      return Promise.resolve();
    }
  }

  let l1: MemoryStore;
  let l2: BatchStore;
  let bus: FakeBus;
  let sink: { emit: Mock };
  let store: TieredStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    l1 = memoryStore();
    l2 = new BatchStore();
    bus = new FakeBus();
    sink = { emit: vi.fn() };
    store = tieredStore({ l1, l2, invalidation: bus });
    store.bind(sink);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /* L1 hits are not re-read; one L2 call serves the misses, which are then backfilled with l1Ttl. */
  it('getMany reads L2 once for the L1 misses and backfills', async () => {
    await l1.set('a', 'A', 60_000);
    l2.data.set('b', { value: 'B', ttlMs: 60_000 });
    l2.data.set('c', { value: 'C', ttlMs: 60_000 });
    expect(await store.getMany(['a', 'b', 'x', 'c'])).toEqual(['A', 'B', undefined, 'C']);
    expect(l2.getManyCalls).toEqual([['b', 'x', 'c']]);
    l2.data.clear();
    expect(await store.getMany(['b', 'c'])).toEqual(['B', 'C']);
    vi.advanceTimersByTime(10_000);
    expect(await store.getMany(['b', 'c'])).toEqual([undefined, undefined]);
  });

  /* When every key hits L1, L2 is not read at all; an empty list does nothing. */
  it('getMany skips L2 when L1 has everything', async () => {
    await l1.set('a', 'A', 60_000);
    expect(await store.getMany(['a'])).toEqual(['A']);
    expect(await store.getMany([])).toEqual([]);
    expect(l2.getManyCalls).toEqual([]);
  });

  /* Without batch support on the tiers, per-key get is used. */
  it('getMany falls back to per-key get when the tiers lack getMany', async () => {
    const plain = new FakeStore();
    plain.data.set('b', { value: 'B', ttlMs: 1_000 });
    const t = tieredStore({ l1: new FakeStore(), l2: plain, invalidation: bus });
    expect(await t.getMany(['a', 'b'])).toEqual([undefined, 'B']);
    expect(plain.calls.filter((c) => c.op === 'get')).toHaveLength(2);
  });

  /* A remote invalidation for b between the L2 call and its resolution blocks b's backfill only. */
  it('an invalidation during the L2 read prevents the backfill of that key only', async () => {
    l2.data.set('a', { value: 'A', ttlMs: 60_000 });
    l2.data.set('b', { value: 'B', ttlMs: 60_000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    l2.getManyFn = async (keys) => {
      await gate;
      return keys.map((k) => l2.data.get(k)?.value);
    };
    const pending = store.getMany(['a', 'b']);
    await flush();
    bus.deliver({ origin: 'other', keys: ['b'] });
    release();
    expect(await pending).toEqual(['A', 'B']);
    l2.data.clear();
    expect(await l1.get('a')).toBe('A');
    expect(await l1.get('b')).toBeUndefined();
  });

  /* An invalidation landing right after the backfill started (next microtask, after `a` is written) must still remove b: the backfill writes all entries in one synchronous step. */
  it('an invalidation right after the backfill starts does not leave a stale b in L1', async () => {
    l2.data.set('a', { value: 'A', ttlMs: 60_000 });
    l2.data.set('b', { value: 'B', ttlMs: 60_000 });
    const realSet = l1.set.bind(l1);
    vi.spyOn(l1, 'set').mockImplementation((key, value, ttlMs) => {
      const done = realSet(key, value, ttlMs);
      if (key === 'a')
        queueMicrotask(() => {
          bus.deliver({ origin: 'other', keys: ['b'] });
        });
      return done;
    });
    expect(await store.getMany(['a', 'b'])).toEqual(['A', 'B']);
    await flush();
    expect(await l1.get('a')).toBe('A');
    expect(await l1.get('b')).toBeUndefined();
  });

  /* setMany writes L2 then L1 (capped TTL) and publishes a single message with all keys. */
  it('setMany publishes one message with every key', async () => {
    await store.setMany([
      { key: 'a', value: '1', ttlMs: 60_000 },
      { key: 'b', value: '2', ttlMs: 500 },
    ]);
    expect(l2.data.get('a')?.ttlMs).toBe(60_000);
    expect(l2.data.get('b')?.ttlMs).toBe(500);
    expect(await l1.get('a')).toBe('1');
    vi.advanceTimersByTime(600);
    expect(await l1.get('b')).toBeUndefined();
    vi.advanceTimersByTime(10_000);
    expect(await l1.get('a')).toBeUndefined();
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0]).toEqual({ origin: anyString, keys: ['a', 'b'] });
  });

  /* An open L2 circuit skips the publish and reports nothing. */
  it('setMany with an open L2 circuit skips the publish', async () => {
    const inner = new BatchStore();
    const t = tieredStore({
      l1: memoryStore(),
      l2: circuitBreakerStore(inner, { failureThreshold: 1 }),
      invalidation: bus,
    });
    t.bind(sink);
    inner.failNext('set', new Error('down'));
    await t.set('x', '1', 1_000);
    sink.emit.mockClear();
    bus.published.length = 0;
    await t.setMany([{ key: 'k', value: 'v', ttlMs: 1_000 }]);
    expect(await t.get('k')).toBe('v');
    expect(bus.published).toEqual([]);
    expect(sink.emit).not.toHaveBeenCalledWith('error', expect.anything());
  });

  /* Review Focus 5: a rejecting L2 yields L1 hits plus undefined, no rejection, one error. */
  it('getMany with a rejecting L2 returns L1 hits and reports one error', async () => {
    await l1.set('a', 'A', 60_000);
    l2.getManyFn = () => Promise.reject(new Error('down'));
    expect(await store.getMany(['a', 'b', 'c'])).toEqual(['A', undefined, undefined]);
    const errors = sink.emit.mock.calls.filter((c) => c[0] === 'error');
    expect(errors).toEqual([['error', { operation: 'get', error: anyError }]]);
  });

  /* Per-key fallback with a failing L2 also reports a single error for the batch. */
  it('getMany with a failing per-key L2 reports one error', async () => {
    const plain = new FakeStore();
    plain.failNext('get');
    plain.failNext('get');
    const t = tieredStore({ l1: memoryStore(), l2: plain, invalidation: bus });
    t.bind(sink);
    expect(await t.getMany(['a', 'b'])).toEqual([undefined, undefined]);
    expect(sink.emit.mock.calls.filter((c) => c[0] === 'error')).toHaveLength(1);
  });

  /* Review Focus 5: an open circuit on L2 gives L1 hits plus misses and no error event. */
  it('getMany with an open L2 circuit returns L1 hits and no error', async () => {
    const inner = new BatchStore();
    const t = tieredStore({
      l1,
      l2: circuitBreakerStore(inner, { failureThreshold: 1 }),
      invalidation: bus,
    });
    t.bind(sink);
    inner.getManyFn = () => Promise.reject(new Error('down'));
    await l1.set('a', 'A', 1_000);
    await t.getMany(['z']); // opens the circuit
    sink.emit.mockClear();
    expect(await t.getMany(['a', 'b'])).toEqual(['A', undefined]);
    expect(sink.emit.mock.calls.filter((c) => c[0] === 'error')).toEqual([]);
  });
});
