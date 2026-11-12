import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { CacheService } from '../../../src/core/cache.service.js';
import { CacheEvents } from '../../../src/core/events.js';
import { resolveOptions, type CacheModuleOptions } from '../../../src/module/cache.options.js';
import type { LockHandle, LockProvider } from '../../../src/stores/cache-store.interface.js';
import { RedisStore } from '../../../src/stores/redis.store.js';
import { makeEngine } from '../helpers/engine.js';
import { FakeLock } from '../helpers/fake-lock.js';
import { FakeRedis } from '../helpers/fake-redis.js';
import { FakeStore } from '../helpers/fake-store.js';

const SWR = { ttl: 100, strategy: 'swr', staleTtl: 1_000 } as const;
const LOCKED = { lock: true } as const;

function lockingStore(lock: LockProvider = new FakeLock()): FakeStore & { lock: LockProvider } {
  return Object.assign(new FakeStore(), { lock });
}

function setup(options: CacheModuleOptions = {}, lock = new FakeLock()) {
  const store = lockingStore(lock);
  const made = makeEngine({ ...options, stores: { ...options.stores, default: store } });
  // A second engine on the same store plays another instance.
  const other = makeEngine({ ...options, stores: { default: store } }).engine;
  return { ...made, lock, other };
}

function delayed<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(value);
    }, ms);
  });
}

describe('CacheEngine distributed lock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('no lock calls and no lock events when the lock is disabled', async () => {
    const { engine, emitted, lock } = setup();
    expect(await engine.getOrSet({ key: 'k' }, async () => 'v')).toBe('v');
    await engine.set({ key: 's' }, 'old', SWR);
    vi.setSystemTime(150);
    expect(await engine.getOrSet({ key: 's' }, async () => 'new', SWR)).toBe('old');
    await vi.runAllTimersAsync();
    expect(await engine.get({ key: 's' })).toBe('new');
    expect(lock.acquireCalls).toEqual([]);
    expect(emitted.some((e) => e.event === 'lock')).toBe(false);
    expect(emitted.slice(0, 3).map((e) => e.event)).toEqual(['miss', 'load', 'set']);
  });

  it('per-call lock: true overrides the default; lock: false overrides enabled', async () => {
    const off = setup({ prefix: 'app' });
    await off.engine.getOrSet({ namespace: 'ns', key: 'a' }, async () => 1, LOCKED);
    // The lock key is `<prefix>:__lock__:<cache key>`, built by the engine.
    expect(off.lock.acquireCalls).toEqual(['app:__lock__:ns:a']);

    const on = setup({ defaults: { lock: { enabled: true } } });
    await on.engine.getOrSet({ key: 'a' }, async () => 1, { lock: false });
    expect(on.lock.acquireCalls).toEqual([]);
    expect(on.emitted.some((e) => e.event === 'lock')).toBe(false);
    await on.engine.getOrSet({ key: 'b' }, async () => 1);
    expect(on.lock.acquireCalls).toEqual(['__lock__:b']);
  });

  it('lock events carry store, namespace, key, waitedMs, acquired', async () => {
    const { engine, emitted, lock } = setup();
    expect(await engine.getOrSet({ namespace: 'ns', key: 'k' }, async () => 'v', LOCKED)).toBe('v');
    expect(emitted.map((e) => e.event)).toEqual(['miss', 'lock', 'load', 'set']);
    expect(emitted[1]?.payload).toEqual({
      store: 'default',
      namespace: 'ns',
      key: 'k',
      waitedMs: 0,
      acquired: true,
    });
    expect(lock.releaseCalls).toEqual(['__lock__:ns:k']);
    expect(lock.held.size).toBe(0);
  });

  it('passes defaults.lock.ttl to acquire as an integer >= 1', async () => {
    const { engine, lock } = setup({ defaults: { lock: { ttl: 1_500.4 } } });
    await engine.getOrSet({ key: 'k' }, async () => 'v', LOCKED);
    expect(lock.acquireTtls).toEqual([1_500]);
  });

  it('waits for another holder, then serves its value with one hit', async () => {
    const { engine, emitted, lock, other } = setup();
    lock.held.add('__lock__:k');
    const loader = vi.fn(async () => 'mine');
    const p = engine.getOrSet({ key: 'k' }, loader, LOCKED);
    await vi.advanceTimersByTimeAsync(70);
    await other.set({ key: 'k' }, 'theirs');
    await vi.advanceTimersByTimeAsync(30);
    expect(await p).toBe('theirs');
    expect(loader).not.toHaveBeenCalled();
    expect(emitted.map((e) => e.event)).toEqual(['miss', 'lock', 'hit']);
    expect(emitted[1]?.payload).toEqual({
      store: 'default',
      namespace: undefined,
      key: 'k',
      waitedMs: 100,
      acquired: false,
    });
    expect(emitted[2]?.payload).toEqual({
      store: 'default',
      namespace: undefined,
      key: 'k',
      stale: false,
    });
  });

  it('a stale swr value found while waiting is served as a stale hit, without a refresh', async () => {
    const { engine, emitted, lock, other } = setup();
    lock.held.add('__lock__:k');
    const loader = vi.fn(async () => 'mine');
    const p = engine.getOrSet({ key: 'k' }, loader, { ...SWR, lock: true });
    await vi.advanceTimersByTimeAsync(10);
    await other.set({ key: 'k' }, 'theirs', { ttl: 20, strategy: 'swr', staleTtl: 1_000 });
    await vi.advanceTimersByTimeAsync(40);
    expect(await p).toBe('theirs');
    await vi.runAllTimersAsync();
    expect(loader).not.toHaveBeenCalled();
    expect(lock.acquireCalls).toEqual(['__lock__:k']);
    expect(emitted.map((e) => e.event)).toEqual(['miss', 'lock', 'hit']);
    expect(emitted[2]?.payload).toMatchObject({ key: 'k', stale: true });
  });

  it('a stale value does not end the wait of a reader that is not swr', async () => {
    const { engine, lock, other } = setup();
    lock.held.add('__lock__:k');
    const loader = vi.fn(async () => 'mine');
    const p = engine.getOrSet({ key: 'k' }, loader, LOCKED);
    await other.set({ key: 'k' }, 'theirs', { ttl: 20, strategy: 'swr', staleTtl: 10_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await p).toBe('mine');
    expect(loader).toHaveBeenCalledOnce();
  });

  it('loads without the lock after waitTimeout', async () => {
    const { engine, emitted, lock, store } = setup({
      defaults: { lock: { waitTimeout: 200, retryDelay: 50 } },
    });
    lock.held.add('__lock__:k');
    const loader = vi.fn(async () => 'mine');
    store.calls.length = 0;
    const p = engine.getOrSet({ key: 'k' }, loader, LOCKED);
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toBe('mine');
    expect(loader).toHaveBeenCalledOnce();
    expect(emitted.map((e) => e.event)).toEqual(['miss', 'lock', 'load', 'set']);
    expect(emitted[1]?.payload).toMatchObject({ waitedMs: 200, acquired: false });
    // One read, four silent re-reads, one write.
    expect(store.calls.map((c) => c.op)).toEqual(['get', 'get', 'get', 'get', 'get', 'set']);
    expect(lock.releaseCalls).toEqual([]);
  });

  it('concurrent misses in one process take the lock once', async () => {
    const { engine, lock } = setup();
    const loader = vi.fn(() => delayed(50, 'v'));
    const all = Promise.all(
      Array.from({ length: 5 }, () => engine.getOrSet({ key: 'k' }, loader, LOCKED)),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(await all).toEqual(['v', 'v', 'v', 'v', 'v']);
    expect(loader).toHaveBeenCalledOnce();
    expect(lock.acquireCalls).toEqual(['__lock__:k']);
  });

  it('releases when the loader throws, so the next request takes the lock at once', async () => {
    const { engine, emitted, lock } = setup();
    const boom = new Error('db');
    await expect(
      engine.getOrSet(
        { key: 'k' },
        async () => {
          throw boom;
        },
        LOCKED,
      ),
    ).rejects.toBe(boom);
    expect(lock.held.size).toBe(0);
    emitted.length = 0;
    expect(await engine.getOrSet({ key: 'k' }, async () => 'v', LOCKED)).toBe('v');
    expect(emitted[1]).toEqual({
      event: 'lock',
      payload: { store: 'default', namespace: undefined, key: 'k', waitedMs: 0, acquired: true },
    });
  });

  it('releases when the store write fails', async () => {
    const { engine, emitted, lock, store } = setup();
    store.failNext('set');
    expect(await engine.getOrSet({ key: 'k' }, async () => 'v', LOCKED)).toBe('v');
    expect(lock.releaseCalls).toEqual(['__lock__:k']);
    expect(lock.held.size).toBe(0);
    expect(emitted.map((e) => e.event)).toEqual(['miss', 'lock', 'load', 'error']);
    expect(emitted[3]?.payload).toMatchObject({ operation: 'set' });
  });

  it('acquire failure reports lock and loads without the lock', async () => {
    const { engine, emitted, lock } = setup();
    const boom = new Error('redis down');
    lock.failNext('acquire', boom);
    expect(await engine.getOrSet({ key: 'k' }, async () => 'v', LOCKED)).toBe('v');
    expect(emitted.map((e) => e.event)).toEqual(['miss', 'error', 'load', 'set']);
    expect(emitted[1]?.payload).toEqual({ store: 'default', operation: 'lock', error: boom });
  });

  it('release failure reports lock and keeps the result', async () => {
    const { engine, emitted, lock } = setup();
    const boom = new Error('release failed');
    lock.failNext('release', boom);
    expect(await engine.getOrSet({ key: 'k' }, async () => 'v', LOCKED)).toBe('v');
    expect(emitted.map((e) => e.event)).toEqual(['miss', 'lock', 'load', 'set', 'error']);
    expect(emitted[4]?.payload).toEqual({ store: 'default', operation: 'lock', error: boom });
  });

  it('a store without lock behaves like 0.1 with lock: true', async () => {
    const { engine, emitted, store } = makeEngine({ defaults: { lock: { enabled: true } } });
    expect('lock' in store).toBe(false);
    expect(await engine.getOrSet({ key: 'k' }, async () => 'v', LOCKED)).toBe('v');
    expect(await engine.getOrSet({ key: 'k' }, async () => 'other', LOCKED)).toBe('v');
    expect(emitted.map((e) => e.event)).toEqual(['miss', 'load', 'set', 'hit']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('swr refresh with a held lock does not load', async () => {
    const { engine, emitted, lock } = setup();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    lock.held.add('__lock__:k');
    emitted.length = 0;
    const loader = vi.fn(async () => 'new');
    expect(await engine.getOrSet({ key: 'k' }, loader, { ...SWR, lock: true })).toBe('old');
    await vi.runAllTimersAsync();
    expect(loader).not.toHaveBeenCalled();
    expect(lock.acquireCalls).toEqual(['__lock__:k']);
    expect(emitted.map((e) => e.event)).toEqual(['hit', 'lock']);
    expect(emitted[1]?.payload).toEqual({
      store: 'default',
      namespace: undefined,
      key: 'k',
      waitedMs: 0,
      acquired: false,
    });
    expect(await engine.get({ key: 'k' })).toBe('old');
  });

  it('swr refresh takes the lock, stores the new value and releases', async () => {
    const { engine, emitted, lock } = setup({ defaults: { lock: { enabled: true } } });
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    emitted.length = 0;
    expect(await engine.getOrSet({ key: 'k' }, async () => 'new', SWR)).toBe('old');
    await vi.runAllTimersAsync();
    expect(emitted.map((e) => e.event)).toEqual(['hit', 'lock', 'load', 'set']);
    expect(emitted[1]?.payload).toMatchObject({ acquired: true, waitedMs: 0 });
    expect(lock.releaseCalls).toEqual(['__lock__:k']);
    expect(await engine.get({ key: 'k' })).toBe('new');
  });

  it('a failing locked refresh reports refresh and still releases', async () => {
    const { engine, emitted, lock } = setup();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    emitted.length = 0;
    const boom = new Error('boom');
    const loader = (): Promise<string> => Promise.reject(boom);
    expect(await engine.getOrSet({ key: 'k' }, loader, { ...SWR, lock: true })).toBe('old');
    await vi.runAllTimersAsync();
    expect(emitted.map((e) => e.event)).toEqual(['hit', 'lock', 'load', 'error']);
    expect(emitted[3]?.payload).toEqual({ store: 'default', operation: 'refresh', error: boom });
    expect(lock.held.size).toBe(0);
  });

  it('a miss that joins a refresh skipped by a held lock still gets a value', async () => {
    const inner = new FakeLock();
    // acquire settles after 10 ms, so the refresh flight is still open when the miss arrives.
    const slow: LockProvider = {
      acquire: (key, ttlMs) =>
        delayed(10, undefined).then((): Promise<LockHandle | undefined> =>
          inner.acquire(key, ttlMs),
        ),
    };
    const { engine } = makeEngine({
      stores: { default: lockingStore(slow) },
      defaults: { lock: { waitTimeout: 200 } },
    });
    const opts = { ...SWR, lock: true };
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    inner.held.add('__lock__:k');
    const loader = vi.fn(async () => 'new');
    expect(await engine.getOrSet({ key: 'k' }, loader, opts)).toBe('old');
    await engine.delete({}, ['k']);
    const missLoader = vi.fn(async () => 'missed');
    const joined = engine.getOrSet({ key: 'k' }, missLoader, opts);
    await vi.advanceTimersByTimeAsync(10);
    expect(loader).not.toHaveBeenCalled();
    // The refresh was skipped; the miss runs its own locked load, waits, then loads alone.
    await vi.advanceTimersByTimeAsync(300);
    expect(await joined).toBe('missed');
    expect(missLoader).toHaveBeenCalledOnce();
    expect(inner.acquireCalls).toEqual(['__lock__:k', '__lock__:k']);
  });

  it('CacheService.getOrSet forwards lock to the engine', async () => {
    const { engine, lock } = setup();
    const service = new CacheService(engine);
    expect(await service.getOrSet('k', async () => 'v', { namespace: 'ns', lock: true })).toBe('v');
    expect(lock.acquireCalls).toEqual(['__lock__:ns:k']);
  });

  it('hasLock is true only for a configured store with a lock', () => {
    const { engine } = makeEngine({
      stores: { default: new FakeStore(), locked: lockingStore(), plain: new FakeStore() },
    });
    expect(engine.hasLock('locked')).toBe(true);
    expect(engine.hasLock('plain')).toBe(false);
    expect(engine.hasLock('default')).toBe(false);
    expect(engine.hasLock('missing')).toBe(false);
  });
});

describe('the lock key', () => {
  it('is the complete key under the prefix, passed to the provider', async () => {
    /* prefix 'app': getOrSet on users/1 with a lock acquires 'app:__lock__:users:1' */
    const { engine, lock } = setup({ prefix: 'app' });
    await engine.getOrSet({ namespace: 'users', key: '1' }, async () => 'v', LOCKED);
    expect(lock.acquireCalls).toEqual(['app:__lock__:users:1']);
  });
});

describe('a read of a lock key over a shared Redis', () => {
  it('rejects a reserved key and never touches the lock of another instance', async () => {
    /* the auditor's scenario: lock keys are `<prefix>:__lock__:<namespace>:<key>` holding a bare UUID, in the same
       Redis as the cache entries; a user-controlled key can name one, so a key starting with `__` is a key error */
    const redis = new FakeRedis();
    const store = new RedisStore({ client: redis });
    const events = new CacheEvents();
    const errors: string[] = [];
    events.on('error', ({ operation }) => errors.push(operation));
    const engine = new CacheEngine(resolveOptions({ stores: { default: store } }), events);
    const service = new CacheService(engine);
    const lock = store.lock;
    if (lock === undefined) throw new Error('RedisStore over FakeRedis must have a lock');

    const held = await lock.acquire('__lock__:users:1', 10_000);
    expect(held).toBeDefined();
    const token = redis.data.get('__lock__:users:1');

    expect(await engine.get({ key: '__lock__:users:1' })).toBeUndefined();
    expect(await service.get('__lock__:users:1')).toBeUndefined();

    expect(errors).toEqual(['key', 'key']);
    expect(redis.commands.filter((c) => c.name === 'unlink')).toEqual([]);
    expect(redis.data.get('__lock__:users:1')).toBe(token);
    expect(await lock.acquire('__lock__:users:1', 10_000)).toBeUndefined();
  });
});
