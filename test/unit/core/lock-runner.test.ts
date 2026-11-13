import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  loadWithLock,
  refreshWithLock,
  type LockSettings,
  type Reread,
} from '../../../src/core/lock-runner.js';
import type { LockHandle, LockProvider } from '../../../src/stores/cache-store.interface.js';
import { FakeLock } from '../helpers/fake-lock.js';

const S: LockSettings = { ttl: 10_000, waitTimeout: 3_000, retryDelay: 50 };
const miss: Reread<string> = async () => ({ found: false });

function slowLock(inner: LockProvider, ms: number): LockProvider {
  return {
    acquire: (key, ttlMs) =>
      new Promise<LockHandle | undefined>((resolve, reject) => {
        setTimeout(() => {
          inner.acquire(key, ttlMs).then(resolve, reject);
        }, ms);
      }),
  };
}

describe('lock runner', () => {
  let hooks: { onLock: Mock<(acquired: boolean, waitedMs: number) => void>; onError: Mock };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    hooks = { onLock: vi.fn(), onError: vi.fn() };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('loadWithLock', () => {
    it('acquires, loads once and releases', async () => {
      const lock = new FakeLock();
      const load = vi.fn(async () => 'v');
      expect(await loadWithLock(lock, 'k', S, miss, load, hooks)).toEqual({
        value: 'v',
        from: 'load',
      });
      expect(load).toHaveBeenCalledOnce();
      expect(lock.acquireCalls).toEqual(['k']);
      expect(lock.acquireTtls).toEqual([10_000]);
      expect(lock.releaseCalls).toEqual(['k']);
      expect(lock.held.size).toBe(0);
      expect(hooks.onLock).toHaveBeenCalledOnce();
      expect(hooks.onLock).toHaveBeenCalledWith(true, 0);
      expect(hooks.onError).not.toHaveBeenCalled();
    });

    it('reports the time spent acquiring as waitedMs', async () => {
      const lock = new FakeLock();
      const p = loadWithLock(slowLock(lock, 20), 'k', S, miss, async () => 'v', hooks);
      await vi.advanceTimersByTimeAsync(20);
      expect(await p).toEqual({ value: 'v', from: 'load' });
      expect(hooks.onLock).toHaveBeenCalledWith(true, 20);
    });

    it('waits for the holder and returns the cached value (giả định 3)', async () => {
      const lock = new FakeLock();
      lock.held.add('k');
      let cached = false;
      const reread = vi.fn<Reread<string>>(async () =>
        cached ? { found: true, value: 'c' } : { found: false },
      );
      const load = vi.fn(async () => 'v');
      const p = loadWithLock(
        lock,
        'k',
        { ttl: 10_000, waitTimeout: 3_000, retryDelay: 50 },
        reread,
        load,
        hooks,
      );
      await vi.advanceTimersByTimeAsync(120);
      expect(reread).toHaveBeenCalledTimes(2);
      expect(hooks.onLock).not.toHaveBeenCalled();
      cached = true;
      await vi.advanceTimersByTimeAsync(50);
      expect(await p).toEqual({ value: 'c', from: 'cache' });
      expect(hooks.onLock).toHaveBeenCalledOnce();
      expect(hooks.onLock).toHaveBeenCalledWith(false, 150);
      expect(reread).toHaveBeenCalledTimes(3);
      expect(load).not.toHaveBeenCalled();
      expect(lock.acquireCalls).toEqual(['k']);
      expect(lock.releaseCalls).toEqual([]);
      // Polling stops once the value is found.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reread).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('loads without the lock after waitTimeout', async () => {
      const lock = new FakeLock();
      lock.held.add('k');
      const reread = vi.fn(miss);
      const load = vi.fn(async () => 'v');
      const p = loadWithLock(lock, 'k', S, reread, load, hooks);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(load).not.toHaveBeenCalled();
      expect(hooks.onLock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toEqual({ value: 'v', from: 'load' });
      expect(load).toHaveBeenCalledOnce();
      expect(hooks.onLock).toHaveBeenCalledOnce();
      expect(hooks.onLock).toHaveBeenCalledWith(false, 3_000);
      expect(reread).toHaveBeenCalledTimes(60);
      expect(lock.acquireCalls).toEqual(['k']);
      expect(lock.releaseCalls).toEqual([]);
      // The other holder's lock is untouched.
      expect(lock.held.has('k')).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('never waits past waitTimeout when retryDelay is longer', async () => {
      const lock = new FakeLock();
      lock.held.add('k');
      const reread = vi.fn(miss);
      const load = vi.fn(async () => 'v');
      const p = loadWithLock(
        lock,
        'k',
        { ttl: 10_000, waitTimeout: 30, retryDelay: 50 },
        reread,
        load,
        hooks,
      );
      await vi.advanceTimersByTimeAsync(30);
      expect(await p).toEqual({ value: 'v', from: 'load' });
      expect(reread).toHaveBeenCalledOnce();
      expect(hooks.onLock).toHaveBeenCalledWith(false, 30);
    });

    it('acquire failure: reports and loads, no lock event', async () => {
      const lock = new FakeLock();
      const boom = new Error('redis down');
      lock.failNext('acquire', boom);
      const reread = vi.fn(miss);
      const load = vi.fn(async () => 'v');
      expect(await loadWithLock(lock, 'k', S, reread, load, hooks)).toEqual({
        value: 'v',
        from: 'load',
      });
      expect(hooks.onError).toHaveBeenCalledOnce();
      expect(hooks.onError).toHaveBeenCalledWith(boom);
      expect(hooks.onLock).not.toHaveBeenCalled();
      expect(load).toHaveBeenCalledOnce();
      expect(reread).not.toHaveBeenCalled();
      expect(lock.releaseCalls).toEqual([]);
    });

    it('release failure is reported and the value still returned', async () => {
      const lock = new FakeLock();
      const boom = new Error('release failed');
      lock.failNext('release', boom);
      expect(await loadWithLock(lock, 'k', S, miss, async () => 'v', hooks)).toEqual({
        value: 'v',
        from: 'load',
      });
      expect(lock.releaseCalls).toEqual(['k']);
      expect(hooks.onLock).toHaveBeenCalledWith(true, 0);
      await vi.waitFor(() => {
        expect(hooks.onError).toHaveBeenCalledOnce();
      });
      expect(hooks.onError).toHaveBeenCalledWith(boom);
    });

    it('starts the background release through hooks.detach when set (M5)', async () => {
      const lock = new FakeLock();
      const boom = new Error('release failed');
      lock.failNext('release', boom);
      const detach = vi.fn((run: () => void) => {
        expect(lock.releaseCalls).toEqual([]);
        run();
      });
      expect(await loadWithLock(lock, 'k', S, miss, async () => 'v', { ...hooks, detach })).toEqual(
        { value: 'v', from: 'load' },
      );
      expect(detach).toHaveBeenCalledOnce();
      expect(lock.releaseCalls).toEqual(['k']);
      await vi.waitFor(() => {
        expect(hooks.onError).toHaveBeenCalledWith(boom);
      });
    });

    it('re-reads after acquire: a found value is returned, the loader is not called', async () => {
      const lock = new FakeLock();
      const reread = vi.fn<Reread<string>>(async () => ({ found: true, value: 'c' }));
      const load = vi.fn(async () => 'v');
      expect(await loadWithLock(lock, 'k', S, reread, load, hooks)).toEqual({
        value: 'c',
        from: 'cache',
      });
      expect(load).not.toHaveBeenCalled();
      expect(reread).toHaveBeenCalledOnce();
      expect(lock.releaseCalls).toEqual(['k']);
      expect(hooks.onLock).toHaveBeenCalledOnce();
      expect(hooks.onLock).toHaveBeenCalledWith(true, 0);
      expect(hooks.onError).not.toHaveBeenCalled();
    });

    it('a re-read that throws is reported, then the load runs under the lock', async () => {
      const lock = new FakeLock();
      const boom = new Error('read failed');
      const reread = vi.fn<Reread<string>>(async () => {
        throw boom;
      });
      const load = vi.fn(async () => 'v');
      expect(await loadWithLock(lock, 'k', S, reread, load, hooks)).toEqual({
        value: 'v',
        from: 'load',
      });
      expect(hooks.onError).toHaveBeenCalledWith(boom);
      expect(load).toHaveBeenCalledOnce();
      expect(lock.releaseCalls).toEqual(['k']);
    });

    it('does not wait for the release', async () => {
      const lock: LockProvider = {
        acquire: () => Promise.resolve({ release: () => new Promise<void>(() => undefined) }),
      };
      expect(await loadWithLock(lock, 'k', S, miss, async () => 'v', hooks)).toEqual({
        value: 'v',
        from: 'load',
      });
    });

    it('does not wait for the release after a re-read hit', async () => {
      const lock: LockProvider = {
        acquire: () => Promise.resolve({ release: () => new Promise<void>(() => undefined) }),
      };
      const reread: Reread<string> = async () => ({ found: true, value: 'c' });
      expect(await loadWithLock(lock, 'k', S, reread, async () => 'v', hooks)).toEqual({
        value: 'c',
        from: 'cache',
      });
    });

    it('a synchronous throw from release is reported and the call resolves', async () => {
      const boom = new Error('sync release');
      const lock: LockProvider = {
        acquire: () =>
          Promise.resolve({
            release: (): Promise<void> => {
              throw boom;
            },
          }),
      };
      expect(await loadWithLock(lock, 'k', S, miss, async () => 'v', hooks)).toEqual({
        value: 'v',
        from: 'load',
      });
      expect(hooks.onError).toHaveBeenCalledWith(boom);
    });

    it('releases when the loader throws (Review Focus 3)', async () => {
      const lock = new FakeLock();
      const boom = new Error('db');
      await expect(
        loadWithLock(
          lock,
          'k',
          S,
          miss,
          async () => {
            throw boom;
          },
          hooks,
        ),
      ).rejects.toBe(boom);
      expect(lock.held.size).toBe(0);
      expect(lock.releaseCalls).toEqual(['k']);
      expect(hooks.onError).not.toHaveBeenCalled();
      expect(await lock.acquire('k', 1)).toBeDefined();
    });

    it('releases when the loader throws synchronously', async () => {
      const lock = new FakeLock();
      const boom = new Error('sync');
      const load = (): Promise<string> => {
        throw boom;
      };
      await expect(loadWithLock(lock, 'k', S, miss, load, hooks)).rejects.toBe(boom);
      expect(lock.held.size).toBe(0);
    });

    it('a failed release does not mask the loader error', async () => {
      const lock = new FakeLock();
      const boom = new Error('db');
      const releaseError = new Error('release failed');
      lock.failNext('release', releaseError);
      await expect(
        loadWithLock(
          lock,
          'k',
          S,
          miss,
          async () => {
            throw boom;
          },
          hooks,
        ),
      ).rejects.toBe(boom);
      await vi.waitFor(() => {
        expect(hooks.onError).toHaveBeenCalledWith(releaseError);
      });
    });
  });

  describe('refreshWithLock', () => {
    it('refreshWithLock skips the load when the lock is held', async () => {
      const lock = new FakeLock();
      lock.held.add('k');
      const load = vi.fn(async () => undefined);
      await refreshWithLock(lock, 'k', 10_000, load, hooks);
      expect(load).not.toHaveBeenCalled();
      expect(lock.acquireCalls).toEqual(['k']);
      expect(lock.releaseCalls).toEqual([]);
      expect(hooks.onLock).toHaveBeenCalledOnce();
      expect(hooks.onLock).toHaveBeenCalledWith(false, 0);
      expect(hooks.onError).not.toHaveBeenCalled();
      // Exactly one attempt: nothing is left polling.
      expect(vi.getTimerCount()).toBe(0);
    });

    it('acquires, loads and releases', async () => {
      const lock = new FakeLock();
      const load = vi.fn(async () => undefined);
      await refreshWithLock(lock, 'k', 10_000, load, hooks);
      expect(load).toHaveBeenCalledOnce();
      expect(lock.acquireTtls).toEqual([10_000]);
      expect(lock.releaseCalls).toEqual(['k']);
      expect(lock.held.size).toBe(0);
      expect(hooks.onLock).toHaveBeenCalledWith(true, 0);
    });

    it('acquire failure: reports, then loads without the lock', async () => {
      const lock = new FakeLock();
      const boom = new Error('redis down');
      lock.failNext('acquire', boom);
      const load = vi.fn(async () => undefined);
      await refreshWithLock(lock, 'k', 10_000, load, hooks);
      expect(hooks.onError).toHaveBeenCalledWith(boom);
      expect(hooks.onLock).not.toHaveBeenCalled();
      expect(load).toHaveBeenCalledOnce();
      expect(lock.releaseCalls).toEqual([]);
    });

    it('releases when the loader throws, and rejects with the loader error', async () => {
      const lock = new FakeLock();
      const boom = new Error('db');
      await expect(
        refreshWithLock(
          lock,
          'k',
          10_000,
          async () => {
            throw boom;
          },
          hooks,
        ),
      ).rejects.toBe(boom);
      expect(lock.held.size).toBe(0);
      expect(lock.releaseCalls).toEqual(['k']);
    });

    it('reports a failed release', async () => {
      const lock = new FakeLock();
      const boom = new Error('release failed');
      lock.failNext('release', boom);
      await refreshWithLock(lock, 'k', 10_000, async () => undefined, hooks);
      await vi.waitFor(() => {
        expect(hooks.onError).toHaveBeenCalledWith(boom);
      });
    });

    it('does not wait for the release and a rejecting release reaches onError', async () => {
      const pending: LockProvider = {
        acquire: () => Promise.resolve({ release: () => new Promise<void>(() => undefined) }),
      };
      await refreshWithLock(pending, 'k', 10_000, async () => undefined, hooks);
      const boom = new Error('release failed');
      const failing: LockProvider = {
        acquire: () => Promise.resolve({ release: () => Promise.reject(boom) }),
      };
      await refreshWithLock(failing, 'k', 10_000, async () => undefined, hooks);
      await vi.waitFor(() => {
        expect(hooks.onError).toHaveBeenCalledWith(boom);
      });
    });
  });
});
