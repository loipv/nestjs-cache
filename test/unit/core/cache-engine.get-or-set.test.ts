import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import { makeEngine } from '../helpers/engine.js';
import { FakeStore } from '../helpers/fake-store.js';

describe('CacheEngine.getOrSet', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('loads on a miss, stores, then serves from cache', async () => {
    const { engine, emitted } = makeEngine();
    const loader = vi.fn(async () => ({ n: 1 }));
    expect(await engine.getOrSet({ key: 'a' }, loader)).toEqual({ n: 1 });
    expect(await engine.getOrSet({ key: 'a' }, loader)).toEqual({ n: 1 });
    expect(loader).toHaveBeenCalledOnce();
    expect(emitted.map((e) => e.event)).toEqual(['miss', 'load', 'set', 'hit']);
    expect(emitted[1]?.payload).toMatchObject({ store: 'default', key: 'a', success: true });
  });

  it('reports the load duration', async () => {
    const { engine, emitted } = makeEngine();
    const pending = engine.getOrSet({ key: 'a' }, async () => {
      await new Promise((r) => setTimeout(r, 250));
      return 1;
    });
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(emitted.find((e) => e.event === 'load')?.payload).toMatchObject({ durationMs: 250 });
  });

  it('coalesces concurrent misses into one load', async () => {
    const { engine } = makeEngine();
    const loader = vi.fn(async () => {
      await Promise.resolve();
      return 1;
    });
    expect(
      await Promise.all(Array.from({ length: 5 }, () => engine.getOrSet({ key: 'a' }, loader))),
    ).toEqual([1, 1, 1, 1, 1]);
    expect(loader).toHaveBeenCalledOnce();
  });

  it('does not coalesce across keys, namespaces or stores', async () => {
    const { engine } = makeEngine({ stores: { default: new FakeStore(), other: new FakeStore() } });
    const loader = vi.fn(async () => {
      await Promise.resolve();
      return 1;
    });
    await Promise.all([
      engine.getOrSet({ key: 'a' }, loader),
      engine.getOrSet({ key: 'b' }, loader),
      engine.getOrSet({ key: 'a', namespace: 'ns' }, loader),
      engine.getOrSet({ key: 'a', store: 'other' }, loader),
    ]);
    expect(loader).toHaveBeenCalledTimes(4);
  });

  it('a failed load reaches every waiter, stores nothing and is retried next time', async () => {
    const { engine, store, emitted } = makeEngine();
    const boom = new Error('db down');
    const failing = vi.fn(async () => {
      await Promise.resolve();
      throw boom;
    });
    const results = await Promise.allSettled([
      engine.getOrSet({ key: 'a' }, failing),
      engine.getOrSet({ key: 'a' }, failing),
    ]);
    expect(results.every((r) => r.status === 'rejected' && r.reason === boom)).toBe(true);
    expect(failing).toHaveBeenCalledOnce();
    expect(store.data.size).toBe(0);
    expect(emitted.find((e) => e.event === 'load')?.payload).toMatchObject({ success: false });
    expect(await engine.getOrSet({ key: 'a' }, async () => 5)).toBe(5);
  });

  it('a loader that throws synchronously rejects and is retried', async () => {
    const { engine, emitted } = makeEngine();
    const boom = new Error('sync');
    const bad = (): Promise<number> => {
      throw boom;
    };
    await expect(engine.getOrSet({ key: 'a' }, bad)).rejects.toBe(boom);
    expect(emitted.find((e) => e.event === 'load')?.payload).toMatchObject({ success: false });
    expect(await engine.getOrSet({ key: 'a' }, async () => 2)).toBe(2);
  });

  it('does not store empty results by default', async () => {
    const { engine, store } = makeEngine();
    const loader = vi.fn(async () => null);
    expect(await engine.getOrSet({ key: 'a' }, loader)).toBeNull();
    expect(await engine.getOrSet({ key: 'a' }, loader)).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(store.data.size).toBe(0);
    expect(store.calls.some((c) => c.op === 'delete')).toBe(false);
  });

  it('stores empty results with nullTtl when cacheNull is on', async () => {
    const { engine, store } = makeEngine({ defaults: { cacheNull: true } });
    const loader = vi.fn(async () => null);
    await engine.getOrSet({ key: 'a' }, loader);
    expect(await engine.getOrSet({ key: 'a' }, loader)).toBeNull();
    expect(loader).toHaveBeenCalledOnce();
    expect(store.data.get('a')?.ttlMs).toBe(30_000);
  });

  it('keeps undefined distinct from null', async () => {
    const { engine } = makeEngine({ defaults: { cacheNull: true } });
    const loader = vi.fn(async (): Promise<string | undefined> => undefined);
    await engine.getOrSet({ key: 'a' }, loader);
    expect(await engine.getOrSet({ key: 'a' }, loader)).toBeUndefined();
    expect(loader).toHaveBeenCalledOnce();
  });

  it('per-call cacheNull and nullTtl override the defaults', async () => {
    const { engine, store } = makeEngine();
    await engine.getOrSet({ key: 'a' }, async () => null, { cacheNull: true, nullTtl: 9 });
    expect(store.data.get('a')?.ttlMs).toBe(9);
  });

  it.each([0, '', false])('caches falsy result %j', async (value) => {
    const { engine } = makeEngine();
    const loader = vi.fn(async () => value);
    await engine.getOrSet({ key: 'a' }, loader);
    expect(await engine.getOrSet({ key: 'a' }, loader)).toBe(value);
    expect(loader).toHaveBeenCalledOnce();
  });

  it('returns but does not store when unless is true', async () => {
    const { engine, store } = makeEngine();
    expect(await engine.getOrSet({ key: 'a' }, async () => 3, { unless: () => true })).toBe(3);
    expect(store.data.size).toBe(0);
  });

  it('returns the value when unless throws', async () => {
    const { engine, store, emitted } = makeEngine();
    const boom = new Error('bad');
    const value = await engine.getOrSet({ key: 'a' }, async () => 3, {
      unless: () => {
        throw boom;
      },
    });
    expect(value).toBe(3);
    expect(store.data.size).toBe(0);
    expect(emitted).toContainEqual({
      event: 'error',
      payload: { store: 'default', operation: 'set', error: boom },
    });
  });

  it('still returns the loaded value when the store is down', async () => {
    const { engine, store } = makeEngine();
    store.failNext('get');
    store.failNext('set');
    expect(await engine.getOrSet({ key: 'a' }, async () => 7)).toBe(7);
  });

  it('waiters get the loaded value even if the store write fails', async () => {
    const { engine, store } = makeEngine();
    store.failNext('set');
    const loader = vi.fn(async () => {
      await Promise.resolve();
      return 4;
    });
    expect(
      await Promise.all([
        engine.getOrSet({ key: 'a' }, loader),
        engine.getOrSet({ key: 'a' }, loader),
      ]),
    ).toEqual([4, 4]);
    expect(loader).toHaveBeenCalledOnce();
  });

  it('rejects with CacheConfigError for an unknown store without calling the loader', async () => {
    const { engine, emitted } = makeEngine();
    const loader = vi.fn(async () => 1);
    await expect(engine.getOrSet({ store: 'nope', key: 'a' }, loader)).rejects.toBeInstanceOf(
      CacheConfigError,
    );
    expect(loader).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it.each([
    ['ttl', 0],
    ['ttl', -5],
    ['ttl', Number.NaN],
    ['ttl', Number.POSITIVE_INFINITY],
    ['nullTtl', 0],
    ['nullTtl', Number.NaN],
  ])('rejects invalid %s %j before any store or loader call', async (option, value) => {
    const { engine, store } = makeEngine();
    const loader = vi.fn(async () => 1);
    const ref = { key: 'a' };
    const opts = { [option]: value };
    const pattern = new RegExp(option);
    await expect(engine.getOrSet(ref, loader, opts)).rejects.toThrow(pattern);
    await expect(engine.getOrSet(ref, loader, opts)).rejects.toBeInstanceOf(CacheConfigError);
    await expect(engine.put(ref, 1, opts)).rejects.toBeInstanceOf(CacheConfigError);
    if (option === 'ttl') {
      await expect(engine.set(ref, 1, { ttl: value })).rejects.toBeInstanceOf(CacheConfigError);
    }
    expect(loader).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);
  });

  it('rounds a fractional nullTtl to an integer of at least 1, without jitter', async () => {
    const { engine, store } = makeEngine({ defaults: { jitter: 0.5 } });
    await engine.getOrSet({ key: 'a' }, async () => null, { cacheNull: true, nullTtl: 0.2 });
    await engine.put({ key: 'b' }, null, { cacheNull: true, nullTtl: 7.4 });
    expect(store.data.get('a')?.ttlMs).toBe(1);
    expect(store.data.get('b')?.ttlMs).toBe(7);
  });
});
