import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../../../src/core/cache.service.js';
import { SingleFlight } from '../../../src/core/single-flight.js';
import { CacheConfigError } from '../../../src/errors.js';
import type { LockHandle, LockProvider } from '../../../src/stores/cache-store.interface.js';
import { makeEngine } from '../helpers/engine.js';
import { FakeLock } from '../helpers/fake-lock.js';
import { FakeStore } from '../helpers/fake-store.js';

const SWR = { ttl: 100, strategy: 'swr', staleTtl: 1_000 } as const;

function delayed<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(value);
    }, ms);
  });
}

describe('CacheEngine swr background refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('serves stale immediately and stores the refreshed value', async () => {
    const { engine, emitted } = makeEngine();
    const loader = vi.fn(async () => 'new');
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.advanceTimersByTime(150);
    emitted.length = 0;
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    await vi.runAllTimersAsync();
    expect(loader).toHaveBeenCalledOnce();
    expect(emitted.map((e) => e.event)).toEqual(['hit', 'load', 'set']);
    expect(emitted[0]?.payload).toMatchObject({ key: 'k', stale: true });
    expect(emitted[1]?.payload).toMatchObject({ store: 'default', key: 'k', success: true });
    expect(await engine.get({ key: 'k' })).toBe('new');
  });

  it('returns before a slow refresh settles', async () => {
    const { engine } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const loader = vi.fn(() => delayed(500, 'new'));
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    expect(await engine.get({ key: 'k' })).toBe('old');
    await vi.advanceTimersByTimeAsync(500);
    expect(await engine.get({ key: 'k' })).toBe('new');
  });

  it('coalesces concurrent stale reads into one refresh', async () => {
    const { engine } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const loader = vi.fn(() => delayed(50, 'new'));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => engine.getOrSet({ key: 'k' }, loader, SWR)),
    );
    expect(results).toEqual(['old', 'old', 'old', 'old', 'old']);
    // A stale read that arrives while the refresh runs does not start another one.
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    await vi.runAllTimersAsync();
    expect(loader).toHaveBeenCalledOnce();
    expect(await engine.get({ key: 'k' })).toBe('new');
  });

  it('a miss during a refresh joins it', async () => {
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const loader = vi.fn(() => delayed(200, 'new'));
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    expect(loader).toHaveBeenCalledOnce();
    await engine.delete({}, ['k']);
    emitted.length = 0;
    const missLoader = vi.fn(async () => 'other');
    const joined = engine.getOrSet({ key: 'k' }, missLoader, SWR);
    await vi.advanceTimersByTimeAsync(200);
    expect(await joined).toBe('new');
    expect(loader).toHaveBeenCalledOnce();
    expect(missLoader).not.toHaveBeenCalled();
    expect(emitted.map((e) => e.event)).toEqual(['miss', 'load', 'set']);
    expect(await engine.get({ key: 'k' })).toBe('new');
  });

  it('a miss that joins a failing refresh gets the loader error', async () => {
    const { engine } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const boom = new Error('boom');
    const loader = vi.fn(async () => {
      await delayed(200, undefined);
      throw boom;
    });
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    expect(loader).toHaveBeenCalledOnce();
    await engine.delete({}, ['k']);
    const missLoader = vi.fn(async () => 'other');
    const joined = engine.getOrSet({ key: 'k' }, missLoader, SWR);
    const settled = Promise.allSettled([joined]);
    await vi.advanceTimersByTimeAsync(200);
    expect(await settled).toEqual([{ status: 'rejected', reason: boom }]);
    expect(loader).toHaveBeenCalledOnce();
    expect(missLoader).not.toHaveBeenCalled();
  });

  it('a failing refresh keeps the stale value and reports refresh', async () => {
    const { engine, emitted, store } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const boom = new Error('boom');
    const loader = vi.fn((): Promise<string> => Promise.reject(boom));
    store.calls.length = 0;
    emitted.length = 0;
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    await vi.runAllTimersAsync();
    expect(loader).toHaveBeenCalledOnce();
    expect(emitted.map((e) => e.event)).toEqual(['hit', 'load', 'error']);
    expect(emitted[1]?.payload).toMatchObject({ key: 'k', success: false });
    expect(emitted[2]?.payload).toEqual({ store: 'default', operation: 'refresh', error: boom });
    expect(store.calls.map((c) => c.op)).toEqual(['get']);

    vi.setSystemTime(1_099);
    expect(await engine.get({ key: 'k' })).toBe('old');
    // The next stale read tries again.
    loader.mockImplementation(async () => 'new');
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    await vi.runAllTimersAsync();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(await engine.get({ key: 'k' })).toBe('new');
  });

  it('a failing refresh lets the entry expire at expiresAt', async () => {
    const { engine } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    await engine.getOrSet({ key: 'k' }, () => Promise.reject(new Error('boom')), SWR);
    await vi.runAllTimersAsync();
    vi.setSystemTime(1_100);
    expect(await engine.get({ key: 'k' })).toBeUndefined();
  });

  it('a synchronously throwing refresh loader counts as a failed load', async () => {
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const boom = new Error('sync');
    const loader = vi.fn((): Promise<string> => {
      throw boom;
    });
    emitted.length = 0;
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    await vi.runAllTimersAsync();
    expect(emitted.map((e) => e.event)).toEqual(['hit', 'load', 'error']);
    expect(emitted[1]?.payload).toMatchObject({ success: false });
    expect(emitted[2]?.payload).toEqual({ store: 'default', operation: 'refresh', error: boom });
    expect(await engine.get({ key: 'k' })).toBe('old');
  });

  it('stores the refreshed value through the miss storage policy', async () => {
    const { engine, store } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const options = { ...SWR, unless: (v: string | null) => v === 'skip' };
    // unless: nothing is written, the stale value stays.
    expect(await engine.getOrSet({ key: 'k' }, async () => 'skip', options)).toBe('old');
    await vi.runAllTimersAsync();
    expect(await engine.get({ key: 'k' })).toBe('old');
    // empty without cacheNull: nothing is written and nothing is deleted.
    store.calls.length = 0;
    expect(await engine.getOrSet({ key: 'k' }, async () => null, options)).toBe('old');
    await vi.runAllTimersAsync();
    expect(store.calls.map((c) => c.op)).toEqual(['get']);
    expect(await engine.get({ key: 'k' })).toBe('old');
    // the written entry is a fresh swr entry again.
    expect(await engine.getOrSet({ key: 'k' }, async () => 'new', options)).toBe('old');
    await vi.runAllTimersAsync();
    expect(JSON.parse(store.data.get('k')!.value)).toMatchObject({
      value: 'new',
      storedAt: 150,
      staleAt: 250,
      expiresAt: 1_250,
    });
  });

  it('a failing store write during refresh is reported as set, not thrown', async () => {
    const { engine, emitted, store } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    store.failNext('set');
    emitted.length = 0;
    expect(await engine.getOrSet({ key: 'k' }, async () => 'new', SWR)).toBe('old');
    await vi.runAllTimersAsync();
    expect(emitted.map((e) => e.event)).toEqual(['hit', 'load', 'error']);
    expect(emitted[2]?.payload).toMatchObject({ operation: 'set' });
  });

  it('a stale read during a running refresh starts no second flight', async () => {
    const { engine } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const run = vi.spyOn(SingleFlight.prototype, 'run');
    const loader = vi.fn(() => delayed(50, 'new'));
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    expect(run).toHaveBeenCalledTimes(1);
    // The refresh is still running: `has()` short-circuits before `run` is called again.
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(loader).toHaveBeenCalledOnce();
    expect(await engine.get({ key: 'k' })).toBe('new');
  });

  it('fresh reads never refresh', async () => {
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    const loader = vi.fn(async () => 'new');
    vi.setSystemTime(99);
    emitted.length = 0;
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    await vi.runAllTimersAsync();
    expect(loader).not.toHaveBeenCalled();
    expect(emitted.map((e) => e.event)).toEqual(['hit']);
    expect(emitted[0]?.payload).toMatchObject({ stale: false });
  });

  it('get never refreshes a stale entry', async () => {
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    emitted.length = 0;
    expect(await engine.get({ key: 'k' }, SWR)).toBe('old');
    await vi.runAllTimersAsync();
    expect(emitted.map((e) => e.event)).toEqual(['hit']);
  });

  it('a stale entry read without swr reloads in the foreground', async () => {
    const { engine } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const loader = vi.fn(async () => 'new');
    expect(await engine.getOrSet({ key: 'k' }, loader, { ttl: 100 })).toBe('new');
    expect(loader).toHaveBeenCalledOnce();
  });
});

describe('CacheEngine swr refresh and unhandled rejections (Review Focus 2)', () => {
  beforeEach(() => {
    // setImmediate stays real so the flush below reaches the unhandledRejection check.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('never leaks an unhandled rejection (Review Focus 2)', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const { engine, emitted } = makeEngine();
      await engine.set({ key: 'sync' }, 'old', SWR);
      await engine.set({ key: 'late' }, 'old', SWR);
      vi.setSystemTime(150);

      const throwsSync = vi.fn((): Promise<string> => {
        throw new Error('sync');
      });
      expect(await engine.getOrSet({ key: 'sync' }, throwsSync, SWR)).toBe('old');

      const rejectsLate = vi.fn(
        () =>
          new Promise<string>((_, reject) =>
            setTimeout(() => {
              reject(new Error('late'));
            }, 1_000),
          ),
      );
      expect(await engine.getOrSet({ key: 'late' }, rejectsLate, SWR)).toBe('old');
      expect(rejectsLate).toHaveBeenCalledOnce();

      await vi.runAllTimersAsync();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(onUnhandled).not.toHaveBeenCalled();
      const refreshErrors = emitted.filter(
        (e) => e.event === 'error' && (e.payload as { operation: string }).operation === 'refresh',
      );
      expect(refreshErrors).toHaveLength(2);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('CacheEngine swr softTimeout', () => {
  const SOFT = { ...SWR, softTimeout: 100 } as const;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Tracks when `promise` settles, without awaiting it. */
  function track<T>(promise: Promise<T>): { settled: boolean; value: T | undefined } {
    const state: { settled: boolean; value: T | undefined } = { settled: false, value: undefined };
    void promise.then((value) => {
      state.settled = true;
      state.value = value;
    });
    return state;
  }

  it('a stale hit returns the refreshed value when the refresh finishes within softTimeout', async () => {
    /* The refresh takes 50 ms, under the 100 ms softTimeout: the caller gets the new value as
       soon as it lands, with the usual stale hit, load and set events. */
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    emitted.length = 0;
    const loader = vi.fn(() => delayed(50, 'new'));
    const state = track(engine.getOrSet({ key: 'k' }, loader, SOFT));
    await vi.advanceTimersByTimeAsync(49);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toEqual({ settled: true, value: 'new' });
    expect(loader).toHaveBeenCalledOnce();
    expect(emitted.map((e) => e.event)).toEqual(['hit', 'load', 'set']);
    expect(emitted[0]?.payload).toMatchObject({ key: 'k', stale: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a stale hit returns the stale value after softTimeout and the refresh still writes', async () => {
    /* The refresh takes 500 ms: the caller gets the stale value at 100 ms, and the refresh
       keeps running and stores its value at 500 ms. */
    const { engine } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const loader = vi.fn(() => delayed(500, 'new'));
    const state = track(engine.getOrSet({ key: 'k' }, loader, SOFT));
    await vi.advanceTimersByTimeAsync(99);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toEqual({ settled: true, value: 'old' });
    // Only the loader's own timer is left.
    expect(vi.getTimerCount()).toBe(1);
    expect(await engine.get({ key: 'k' })).toBe('old');
    await vi.advanceTimersByTimeAsync(400);
    expect(await engine.get({ key: 'k' })).toBe('new');
    expect(loader).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failing refresh returns the stale value', async () => {
    /* The refresh rejects after 20 ms: the caller gets the stale value then, without waiting
       for the rest of softTimeout, and the failure is reported as refresh. */
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    emitted.length = 0;
    const boom = new Error('boom');
    const loader = vi.fn(async () => {
      await delayed(20, undefined);
      throw boom;
    });
    const state = track(engine.getOrSet({ key: 'k' }, loader, SOFT));
    await vi.advanceTimersByTimeAsync(20);
    expect(state).toEqual({ settled: true, value: 'old' });
    expect(emitted.map((e) => e.event)).toEqual(['hit', 'load', 'error']);
    expect(emitted[2]?.payload).toEqual({ store: 'default', operation: 'refresh', error: boom });
    expect(vi.getTimerCount()).toBe(0);
    expect(await engine.get({ key: 'k' })).toBe('old');
  });

  it('a concurrent refresh is joined, not duplicated', async () => {
    /* A stale read without softTimeout starts an 80 ms refresh; a stale read with softTimeout
       arriving during it waits on that refresh and gets its value. The loader runs once. */
    const { engine } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const loader = vi.fn(() => delayed(80, 'new'));
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    await vi.advanceTimersByTimeAsync(30);
    const second = vi.fn(async () => 'other');
    const state = track(engine.getOrSet({ key: 'k' }, second, SOFT));
    await vi.advanceTimersByTimeAsync(49);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toEqual({ settled: true, value: 'new' });
    expect(loader).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a fresh hit never waits and starts no refresh (Review Focus 3)', async () => {
    /* A fresh entry is returned at once, with no timer and no loader call. */
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(99);
    emitted.length = 0;
    const loader = vi.fn(async () => 'new');
    const state = track(engine.getOrSet({ key: 'k' }, loader, SOFT));
    await vi.advanceTimersByTimeAsync(0);
    expect(state).toEqual({ settled: true, value: 'old' });
    expect(vi.getTimerCount()).toBe(0);
    expect(loader).not.toHaveBeenCalled();
    expect(emitted.map((e) => e.event)).toEqual(['hit']);
    expect(emitted[0]?.payload).toMatchObject({ stale: false });
  });

  it('a refresh blocked on a lock returns stale after softTimeout (Review Focus 4)', async () => {
    /* Another instance holds the lock. A non-swr reader of the stale entry misses and waits on
       the lock for up to waitTimeout (3 s); a swr reader with softTimeout joins that flight and
       gets the stale value at 100 ms, not at 3 s. */
    const lock = new FakeLock();
    const store = Object.assign(new FakeStore(), { lock });
    const { engine } = makeEngine({ stores: { default: store } });
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    lock.held.add('__lock__:k');
    const waiting = engine.getOrSet({ key: 'k' }, async () => 'mine', { ttl: 100, lock: true });
    const loader = vi.fn(async () => 'new');
    const state = track(engine.getOrSet({ key: 'k' }, loader, { ...SOFT, lock: true }));
    await vi.advanceTimersByTimeAsync(99);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toEqual({ settled: true, value: 'old' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await waiting).toBe('mine');
    expect(loader).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a refresh whose lock acquire hangs returns stale after softTimeout', async () => {
    /* The lock store answers acquire only after 5 s: the caller gets the stale value at
       100 ms; the refresh then takes the lock and writes. */
    const inner = new FakeLock();
    const slow: LockProvider = {
      acquire: (key, ttlMs) =>
        delayed(5_000, undefined).then((): Promise<LockHandle | undefined> =>
          inner.acquire(key, ttlMs),
        ),
    };
    const store = Object.assign(new FakeStore(), { lock: slow });
    const { engine } = makeEngine({ stores: { default: store } });
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const state = track(engine.getOrSet({ key: 'k' }, async () => 'new', { ...SOFT, lock: true }));
    await vi.advanceTimersByTimeAsync(100);
    expect(state).toEqual({ settled: true, value: 'old' });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(await engine.get({ key: 'k' })).toBe('new');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a refresh skipped by a held lock returns stale at once', async () => {
    /* The refresh finds the lock held and loads nothing: there is nothing to wait for, so
       the stale value is returned without waiting for softTimeout. */
    const lock = new FakeLock();
    const store = Object.assign(new FakeStore(), { lock });
    const { engine } = makeEngine({ stores: { default: store } });
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    lock.held.add('__lock__:k');
    const loader = vi.fn(async () => 'new');
    const state = track(engine.getOrSet({ key: 'k' }, loader, { ...SOFT, lock: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(state).toEqual({ settled: true, value: 'old' });
    expect(loader).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, null])(
    'a refresh that loads %s without cacheNull returns the stale value (F-2)',
    async (empty) => {
      /* The refresh resolves an empty value within softTimeout 50, but it is not written: the
         store keeps 'old', so the caller gets 'old', as if the refresh had missed the window. */
      const { engine } = makeEngine();
      await engine.set({ key: 'k' }, 'old', SWR);
      vi.setSystemTime(150);
      const loader = vi.fn(() => delayed(10, empty));
      const state = track(
        engine.getOrSet<string | null | undefined>({ key: 'k' }, loader, {
          ...SWR,
          softTimeout: 50,
        }),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(state).toEqual({ settled: true, value: 'old' });
      expect(loader).toHaveBeenCalledOnce();
      expect(await engine.get({ key: 'k' })).toBe('old');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('a refresh that writes null with cacheNull returns null (F-2)', async () => {
    /* With cacheNull the refreshed null replaces the stale entry, so the caller gets null. */
    const { engine } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const loader = vi.fn(() => delayed(10, null));
    const state = track(
      engine.getOrSet<string | null>({ key: 'k' }, loader, {
        ...SWR,
        softTimeout: 50,
        cacheNull: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(state).toEqual({ settled: true, value: null });
    expect(await engine.get({ key: 'k' })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a refresh that writes null through defaults.cacheNull returns null (F-2)', async () => {
    /* cacheNull from the module defaults counts as written too: the caller gets null. */
    const { engine } = makeEngine({ defaults: { cacheNull: true } });
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const value = await engine.getOrSet<string | null>({ key: 'k' }, async () => null, {
      ...SWR,
      softTimeout: 50,
    });
    expect(value).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the softTimeout timer is always cleared', async () => {
    /* In time, timed out, failed and skipped: no timer is left behind once the call and its
       refresh are done, and the timer is unref'd. */
    const { engine } = makeEngine();
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const paths: (() => Promise<string>)[] = [
      () => delayed(10, 'new'),
      () => delayed(300, 'new'),
      () => Promise.reject(new Error('boom')),
    ];
    for (const loader of paths) {
      vi.setSystemTime(0);
      await engine.set({ key: 'k' }, 'old', SWR);
      vi.setSystemTime(150);
      setTimer.mockClear();
      const pending = engine.getOrSet({ key: 'k' }, loader, SOFT);
      await vi.advanceTimersByTimeAsync(300);
      await pending;
      expect(vi.getTimerCount()).toBe(0);
      const soft = setTimer.mock.results.find((r, i) => setTimer.mock.calls[i]?.[1] === 100);
      expect((soft?.value as { hasRef(): boolean }).hasRef()).toBe(false);
    }
  });

  it('without softTimeout the 0.7 behaviour is unchanged', async () => {
    /* A refresh that settles at once is still not awaited without softTimeout: the stale
       value is returned and no timer is started; with softTimeout the new value is. */
    const { engine } = makeEngine();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const loader = vi.fn(async () => 'new');
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(await engine.get({ key: 'k' })).toBe('new');
    vi.setSystemTime(300);
    loader.mockImplementation(async () => 'newer');
    expect(await engine.getOrSet({ key: 'k' }, loader, SOFT)).toBe('newer');
  });

  it('CacheService.getOrSet and getOrSetMany forward softTimeout', async () => {
    /* Spec 2.2: the service options carry softTimeout to the engine; a refresh that settles
       at once is returned by both calls. */
    const { engine } = makeEngine();
    const service = new CacheService(engine);
    await service.set('k', 'old', SWR);
    await service.set('m', 'oldM', SWR);
    vi.setSystemTime(150);
    expect(await service.getOrSet('k', async () => 'new', SOFT)).toBe('new');
    const loader = async (missing: string[]) => new Map(missing.map((k) => [k, `new${k}`]));
    expect(await service.getOrSetMany(['m'], loader, SOFT)).toEqual(['newm']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1'])(
    'rejects softTimeout = %s per call',
    async (value) => {
      /* Spec 2.2: softTimeout is a finite number > 0, checked per call like staleTtl, before
         any store call. */
      const { engine, store } = makeEngine();
      const options = { ...SWR, softTimeout: value } as unknown as typeof SOFT;
      const loader = vi.fn(async () => 1);
      const message = `Invalid softTimeout: ${String(value)}. Durations are milliseconds, finite numbers greater than 0.`;
      await expect(engine.getOrSet({ key: 'k' }, loader, options)).rejects.toThrow(
        new CacheConfigError(message),
      );
      await expect(
        engine.getOrSetMany({}, ['k'], async () => new Map(), options),
      ).rejects.toBeInstanceOf(CacheConfigError);
      expect(loader).not.toHaveBeenCalled();
      expect(store.calls).toEqual([]);
    },
  );
});
