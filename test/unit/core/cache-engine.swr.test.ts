import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEngine } from '../helpers/engine.js';

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
