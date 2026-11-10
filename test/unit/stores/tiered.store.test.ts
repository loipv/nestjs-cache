import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import { memoryStore, type MemoryStore } from '../../../src/stores/memory.store.js';
import { tieredStore, type TieredStore } from '../../../src/stores/tiered.store.js';
import { FakeBus } from '../helpers/fake-bus.js';
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

  it('does not backfill L1 with a value read before a concurrent invalidation', async () => {
    let release: (value: string | undefined) => void = () => undefined;
    l2.get = (): Promise<string | undefined> =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = store.get('k');
    await flush();
    bus.deliver({ origin: 'other', keys: ['k'] });
    release('old');
    expect(await pending).toBe('old');
    expect(await l1.get('k')).toBeUndefined();
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
});
