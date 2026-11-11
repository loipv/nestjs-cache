import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { CacheEvents } from '../../../src/core/events.js';
import { resolveOptions, type CacheModuleOptions } from '../../../src/module/cache.options.js';
import type { CacheStore } from '../../../src/stores/cache-store.interface.js';
import { tieredStore } from '../../../src/stores/tiered.store.js';
import { makeEngine } from '../helpers/engine.js';
import { FakeLock } from '../helpers/fake-lock.js';
import { FakeStore } from '../helpers/fake-store.js';

/** A FakeStore with strict members whose durable tier can be switched off (`down`). */
class StrictStore extends FakeStore {
  down = false;
  readonly getStrict = vi.fn((key: string): Promise<string | undefined> =>
    this.down ? Promise.reject(new Error('l2 down')) : Promise.resolve(this.data.get(key)?.value),
  );
  readonly setStrict = vi.fn((key: string, value: string, ttlMs: number): Promise<void> => {
    if (this.down) return Promise.reject(new Error('l2 down'));
    this.data.set(key, { value, ttlMs });
    return Promise.resolve();
  });
}

const OPTIONS = { prefix: 'app', namespaces: { users: { versioned: true } } } as const;
const REF = { namespace: 'users', key: '1' } as const;
const DATA_KEY = /^app:users@[0-9a-z]{8}:1$/;

function setup(options: CacheModuleOptions = OPTIONS) {
  return makeEngine(options);
}

function dataKeys(store: FakeStore): string[] {
  return [...store.data.keys()].filter((key) => !key.startsWith('app:__version__:'));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('CacheEngine versioned namespaces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes and reads under the versioned key', async () => {
    /* A set on a versioned namespace stores `app:users@<v>:1`; get reads it back, and the
       events carry the plain namespace and key. */
    const { engine, store, emitted } = setup();
    await engine.set(REF, { n: 1 });
    const keys = dataKeys(store);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(DATA_KEY);
    expect(store.data.has('app:__version__:users')).toBe(true);
    expect(await engine.get(REF)).toEqual({ n: 1 });
    expect(emitted.map((e) => e.event)).toEqual(['set', 'hit']);
    expect(emitted[0]?.payload).toEqual({
      store: 'default',
      namespace: 'users',
      key: '1',
      ttl: 60_000,
    });
    expect(emitted[1]?.payload).toEqual({
      store: 'default',
      namespace: 'users',
      key: '1',
      stale: false,
    });
  });

  it('clear bumps the version and never calls store.clear', async () => {
    /* clear('users') writes a new token: the old entry stays in the store but is no longer
       read, and the clear event is emitted as before. */
    const { engine, store, emitted } = setup();
    await engine.set(REF, 'x');
    const [oldKey] = dataKeys(store);
    await engine.clear('users');
    expect(await engine.get(REF)).toBeUndefined();
    expect(store.calls.some((c) => c.op === 'clear')).toBe(false);
    expect(store.data.has(oldKey ?? '')).toBe(true);
    expect(emitted.map((e) => e.event)).toEqual(['set', 'clear', 'miss']);
    expect(emitted[1]?.payload).toEqual({ store: 'default', namespace: 'users' });
  });

  it('a load that started before clear writes under the old version', async () => {
    /* Review Focus 2: a getOrSet whose loader is running when clear happens finishes after
       it. Its write goes under the old version, so the next get misses and the next
       getOrSet loads again. */
    const { engine, store } = setup();
    const slow = deferred<string>();
    const loader = vi.fn(() => slow.promise);
    const pending = engine.getOrSet(REF, loader);
    await vi.waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(1);
    });
    await engine.clear('users');
    slow.resolve('old');
    expect(await pending).toBe('old');
    expect(dataKeys(store)).toHaveLength(1);
    expect(await engine.get(REF)).toBeUndefined();
    const again = vi.fn(async () => 'new');
    expect(await engine.getOrSet(REF, again)).toBe('new');
    expect(again).toHaveBeenCalledTimes(1);
    expect(await engine.get(REF)).toBe('new');
  });

  it('a getOrSet after clear does not join a load that started before it', async () => {
    /* The flight key carries the version: a miss after clear starts its own load instead of
       waiting for the pre-clear one. */
    const { engine } = setup();
    const slow = deferred<string>();
    const first = vi.fn(() => slow.promise);
    const before = engine.getOrSet(REF, first);
    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledTimes(1);
    });
    await engine.clear('users');
    const after = vi.fn(async () => 'new');
    expect(await engine.getOrSet(REF, after)).toBe('new');
    expect(after).toHaveBeenCalledTimes(1);
    slow.resolve('old');
    expect(await before).toBe('old');
    expect(await engine.get(REF)).toBe('new');
  });

  it('another instance sees the bump within cacheTtl', async () => {
    /* Engine B caches the version for cacheTtl (1 s by default): it keeps reading the old
       entry after A clears, and misses once cacheTtl has passed. */
    const a = setup();
    const b = setup({ ...OPTIONS, stores: { default: a.store } });
    await a.engine.set(REF, 'x');
    expect(await b.engine.get(REF)).toBe('x');
    await a.engine.clear('users');
    expect(await a.engine.get(REF)).toBeUndefined();
    vi.setSystemTime(999);
    expect(await b.engine.get(REF)).toBe('x');
    vi.setSystemTime(1_000);
    expect(await b.engine.get(REF)).toBeUndefined();
  });

  it('a delete on another instance removes the live key within cacheTtl', async () => {
    /* B cached v1; A clears (v2) and writes users:1 under v2. B deletes users:1 before its
       cache expires: the delete reads the version fresh, so the live v2 entry is removed,
       together with the v1 entry B's stale token names. */
    const a = setup();
    const b = setup({ ...OPTIONS, stores: { default: a.store } });
    await a.engine.set(REF, 'x');
    const [v1Key] = dataKeys(a.store);
    expect(await b.engine.get(REF)).toBe('x');
    await a.engine.clear('users');
    await a.engine.set(REF, 'y');
    const v2Key = dataKeys(a.store).find((key) => key !== v1Key);
    expect(v2Key).toMatch(DATA_KEY);
    await b.engine.delete({ namespace: 'users' }, ['1']);
    const deletes = a.store.calls.filter((c) => c.op === 'delete');
    expect(deletes).toEqual([{ op: 'delete', args: [[v2Key, v1Key]] }]);
    expect(await a.engine.get(REF)).toBeUndefined();
    expect(await b.engine.get(REF)).toBeUndefined();
    expect(b.emitted.at(-2)).toEqual({
      event: 'delete',
      payload: { store: 'default', namespace: 'users', keys: ['1'] },
    });
  });

  it('a delete with a current cached token deletes one key per entry', async () => {
    /* The fresh read matches the cached token: one data key per deleted key, and the delete
       still reads the version even though it is cached. */
    const { engine, store } = setup();
    await engine.set(REF, 'x');
    await engine.set({ namespace: 'users', key: '2' }, 'y');
    const gets = store.calls.filter((c) => c.op === 'get').length;
    await engine.delete({ namespace: 'users' }, ['1', '2']);
    expect(store.calls.filter((c) => c.op === 'get')).toHaveLength(gets + 1);
    const deleted = store.calls.find((c) => c.op === 'delete')?.args[0] as string[];
    expect(deleted).toHaveLength(2);
    expect(deleted[0]).toMatch(DATA_KEY);
    expect(deleted[1]).toBe(deleted[0]?.replace(/:1$/, ':2'));
    expect(dataKeys(store)).toEqual([]);
  });

  it('an empty put deletes under the fresh token', async () => {
    /* put(null) without cacheNull deletes the entry: like delete, it reads the version fresh,
       so a stale cached token on B does not leave A's v2 entry alive. */
    const a = setup();
    const b = setup({ ...OPTIONS, stores: { default: a.store } });
    await a.engine.set(REF, 'x');
    expect(await b.engine.get(REF)).toBe('x');
    await a.engine.clear('users');
    await a.engine.set(REF, 'y');
    await b.engine.put(REF, null);
    expect(await a.engine.get(REF)).toBeUndefined();
  });

  it('lock and flight keys carry the version', async () => {
    /* The lock key is `app:__lock__:users@<v>:1` with the same token as the data key, and
       concurrent misses of a versioned key still share one load. */
    const lock = new FakeLock();
    const store = Object.assign(new FakeStore(), { lock });
    const { engine } = setup({ ...OPTIONS, stores: { default: store } });
    const loader = vi.fn(async () => 'v');
    const results = await Promise.all([
      engine.getOrSet(REF, loader, { lock: true }),
      engine.getOrSet(REF, loader, { lock: true }),
    ]);
    expect(results).toEqual(['v', 'v']);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(lock.acquireCalls).toHaveLength(1);
    const lockKey = lock.acquireCalls[0] ?? '';
    expect(lockKey).toMatch(/^app:__lock__:users@[0-9a-z]{8}:1$/);
    const token = /@([0-9a-z]{8}):/.exec(lockKey)?.[1];
    expect(dataKeys(store)).toEqual([`app:users@${String(token)}:1`]);
  });

  it('a failing version read skips the cache', async () => {
    /* Each operation whose version read rejects reports one version error and touches no
       data key: get misses without a miss event, getOrSet runs the loader only, and
       set/put/delete do nothing. */
    const { engine, store, emitted } = setup();
    store.failNext('get');
    expect(await engine.get(REF)).toBeUndefined();
    store.failNext('get');
    const loader = vi.fn(async () => 'v');
    expect(await engine.getOrSet(REF, loader)).toBe('v');
    expect(loader).toHaveBeenCalledTimes(1);
    store.failNext('get');
    await engine.set(REF, 'x');
    store.failNext('get');
    await engine.put(REF, 'x');
    store.failNext('get');
    await engine.delete({ namespace: 'users' }, ['1']);
    expect(store.calls.filter((c) => c.op !== 'get')).toEqual([]);
    expect(store.calls.map((c) => c.args[0])).toEqual(
      Array.from({ length: 5 }, () => 'app:__version__:users'),
    );
    expect(emitted.map((e) => e.event)).toEqual(['error', 'error', 'error', 'error', 'error']);
    for (const { payload } of emitted) {
      expect(payload).toMatchObject({ store: 'default', operation: 'version' });
    }
  });

  it('a failed version read falls back to the last known token', async () => {
    /* R5: the namespace was read once, then cacheTtl passes and the strict version read
       rejects. getOrSet serves the entry under the last known token without the loader and
       reports exactly one version error; the token is not re-cached, so the next call reads
       the store again. */
    const store = new StrictStore();
    const { engine, emitted } = setup({ ...OPTIONS, stores: { default: store } });
    const loader = vi.fn(async () => 'v');
    expect(await engine.getOrSet(REF, loader)).toBe('v');
    vi.advanceTimersByTime(1_000);
    store.down = true;
    const reads = store.getStrict.mock.calls.length;
    emitted.length = 0;
    expect(await engine.getOrSet(REF, loader)).toBe('v');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(store.getStrict).toHaveBeenCalledTimes(reads + 1);
    const errors = emitted.filter((e) => e.event === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload).toMatchObject({ store: 'default', operation: 'version' });
    expect(await engine.getOrSet(REF, loader)).toBe('v');
    expect(store.getStrict).toHaveBeenCalledTimes(reads + 2);
  });

  it('a failed version read with no known token loads without caching', async () => {
    /* The very first version read fails: the loader runs, nothing is written (neither the
       version key nor the entry), and one version error is reported. */
    const store = new StrictStore();
    store.down = true;
    const { engine, emitted } = setup({ ...OPTIONS, stores: { default: store } });
    const loader = vi.fn(async () => 'v');
    expect(await engine.getOrSet(REF, loader)).toBe('v');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(store.calls.filter((c) => c.op === 'set')).toEqual([]);
    expect(store.setStrict).not.toHaveBeenCalled();
    expect(emitted.map((e) => e.event)).toEqual(['error']);
    expect(emitted[0]?.payload).toMatchObject({ store: 'default', operation: 'version' });
  });

  it('a delete whose fresh version read fails deletes nothing, even with a known token', async () => {
    /* R3 stays: a delete never uses the last known token, since a wrong token would miss the
       live entry. One version error, no store delete, no delete event. */
    const store = new StrictStore();
    const { engine, emitted } = setup({ ...OPTIONS, stores: { default: store } });
    await engine.set(REF, 'x');
    store.down = true;
    emitted.length = 0;
    await engine.delete({ namespace: 'users' }, ['1']);
    expect(store.calls.filter((c) => c.op === 'delete')).toEqual([]);
    expect(dataKeys(store)).toHaveLength(1);
    expect(emitted.map((e) => e.event)).toEqual(['error']);
    expect(emitted[0]?.payload).toMatchObject({ store: 'default', operation: 'version' });
  });

  it('a tiered store whose L2 is down before the first version read loads every time and writes nothing', async () => {
    /* Review Focus 5: L2 rejects everything from the start. The strict version read rejects
       instead of creating a token in L1 only, so each getOrSet runs the loader, and L1 holds
       neither a version key nor an entry of the namespace. */
    const l1 = new FakeStore();
    const down = (): Promise<never> => Promise.reject(new Error('l2 down'));
    const l2: CacheStore = { get: down, set: down, delete: down, clear: down };
    const tiered = tieredStore({ l1, l2 });
    const engine = new CacheEngine(
      resolveOptions({ ...OPTIONS, stores: { default: tiered } }),
      new CacheEvents(),
    );
    const loader = vi.fn(async () => 'v');
    expect(await engine.getOrSet(REF, loader)).toBe('v');
    expect(await engine.getOrSet(REF, loader)).toBe('v');
    expect(loader).toHaveBeenCalledTimes(2);
    expect(
      [...l1.data.keys()].filter((key) => key.includes('__version__') || key.includes('users')),
    ).toEqual([]);
  });

  it('a failing bump reports a version error and no clear event', async () => {
    /* The new token cannot be written: one version error, no clear event, no store.clear,
       and the old entry is still served. */
    const { engine, store, emitted } = setup();
    await engine.set(REF, 'x');
    store.failNext('set');
    await engine.clear('users');
    expect(store.calls.some((c) => c.op === 'clear')).toBe(false);
    expect(emitted.map((e) => e.event)).toEqual(['set', 'error']);
    expect(emitted[1]?.payload).toMatchObject({ store: 'default', operation: 'version' });
    expect(await engine.get(REF)).toBe('x');
  });

  it('a non-versioned namespace is unchanged', async () => {
    /* posts keeps the 0.3 keys and scan-based clear; users:admin is not versioned and is
       not affected by clear('users'). */
    const { engine, store } = setup();
    await engine.set({ namespace: 'posts', key: '1' }, 'p');
    await engine.set({ namespace: 'users:admin', key: '1' }, 'a');
    expect(store.data.has('app:posts:1')).toBe(true);
    expect(store.data.has('app:users:admin:1')).toBe(true);
    await engine.clear('users');
    expect(await engine.get({ namespace: 'users:admin', key: '1' })).toBe('a');
    await engine.clear('posts');
    expect(store.calls.filter((c) => c.op === 'clear')).toEqual([
      { op: 'clear', args: ['app:posts:'] },
    ]);
    expect(await engine.get({ namespace: 'posts', key: '1' })).toBeUndefined();
  });
});
