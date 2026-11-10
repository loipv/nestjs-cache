import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEngine } from '../helpers/engine.js';
import { FakeStore } from '../helpers/fake-store.js';

describe('CacheEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('round-trips a value under the plain key', async () => {
    const { engine, store } = makeEngine();
    await engine.set({ key: 'a' }, { n: 1 });
    expect([...store.data.keys()]).toEqual(['a']);
    expect(await engine.get({ key: 'a' })).toEqual({ n: 1 });
  });

  it('composes prefix, namespace and key', async () => {
    const { engine, store } = makeEngine({ prefix: 'app' });
    await engine.set({ namespace: 'users', key: 'u:1' }, 1);
    expect([...store.data.keys()]).toEqual(['app:users:u:1']);
  });

  it('uses the default TTL, or the given one, for store and envelope', async () => {
    const { engine, store, emitted } = makeEngine();
    await engine.set({ key: 'a' }, 1);
    await engine.set({ key: 'b' }, 1, 5_000);
    expect(store.data.get('a')?.ttlMs).toBe(60_000);
    expect(store.data.get('b')?.ttlMs).toBe(5_000);
    expect(JSON.parse(store.data.get('b')!.value)).toMatchObject({
      storedAt: 1_000_000,
      expiresAt: 1_005_000,
    });
    expect(emitted.at(-1)).toEqual({
      event: 'set',
      payload: { store: 'default', namespace: undefined, key: 'b', ttl: 5_000 },
    });
  });

  it.each([0, '', false, [], null])('treats stored %j as a hit (Review Focus 1)', async (value) => {
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'k' }, value);
    expect(await engine.get({ key: 'k' })).toEqual(value);
    expect(emitted.at(-1)).toEqual({
      event: 'hit',
      payload: { store: 'default', namespace: undefined, key: 'k', stale: false },
    });
  });

  it('a stored undefined is a hit that returns undefined', async () => {
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'k' }, undefined);
    expect(await engine.get({ key: 'k' })).toBeUndefined();
    expect(emitted.at(-1)?.event).toBe('hit');
  });

  it('a missing key is a miss', async () => {
    const { engine, emitted } = makeEngine();
    expect(await engine.get({ key: 'x' })).toBeUndefined();
    expect(emitted.at(-1)).toEqual({
      event: 'miss',
      payload: { store: 'default', namespace: undefined, key: 'x' },
    });
  });

  it('an envelope past expiresAt is a miss even if the store still holds it', async () => {
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'a' }, 1, 1_000);
    vi.advanceTimersByTime(1_000);
    expect(await engine.get({ key: 'a' })).toBeUndefined();
    expect(emitted.at(-1)?.event).toBe('miss');
  });

  it('a failing read is a miss plus an error event', async () => {
    const { engine, store, emitted } = makeEngine();
    const boom = new Error('down');
    store.failNext('get', boom);
    await expect(engine.get({ key: 'a' })).resolves.toBeUndefined();
    expect(emitted).toContainEqual({
      event: 'error',
      payload: { store: 'default', operation: 'get', error: boom },
    });
    expect(emitted.at(-1)?.event).toBe('miss');
  });

  it('a failing write resolves and reports', async () => {
    const { engine, store, emitted } = makeEngine();
    const boom = new Error('down');
    store.failNext('set', boom);
    await expect(engine.set({ key: 'a' }, 1)).resolves.toBeUndefined();
    expect(emitted).toEqual([
      { event: 'error', payload: { store: 'default', operation: 'set', error: boom } },
    ]);
  });

  it.each(['not json', '{"v":2,"value":1,"storedAt":0}'])(
    'unreadable entry %s is a miss, is deleted and reported',
    async (raw) => {
      const { engine, store, emitted } = makeEngine();
      store.data.set('a', { value: raw, ttlMs: 1 });
      expect(await engine.get({ key: 'a' })).toBeUndefined();
      expect(store.data.has('a')).toBe(false);
      expect(
        emitted.some(
          (e) =>
            e.event === 'error' && (e.payload as { operation: string }).operation === 'deserialize',
        ),
      ).toBe(true);
      expect(emitted.at(-1)?.event).toBe('miss');
    },
  );

  it('swallows a failing cleanup delete after a deserialize failure', async () => {
    const { engine, store, emitted } = makeEngine();
    store.data.set('a', { value: 'not json', ttlMs: 1 });
    store.failNext('delete');
    await expect(engine.get({ key: 'a' })).resolves.toBeUndefined();
    expect(emitted.filter((e) => e.event === 'error')).toHaveLength(1);
  });

  it('delete maps keys through prefix and namespace', async () => {
    const { engine, store, emitted } = makeEngine({ prefix: 'app' });
    await engine.delete({ namespace: 'users' }, ['a', 'b']);
    expect(store.calls.at(-1)).toEqual({ op: 'delete', args: [['app:users:a', 'app:users:b']] });
    expect(emitted.at(-1)).toEqual({
      event: 'delete',
      payload: { store: 'default', namespace: 'users', keys: ['a', 'b'] },
    });
  });

  it('delete with no keys does not touch the store', async () => {
    const { engine, store } = makeEngine();
    await engine.delete({}, []);
    expect(store.calls).toEqual([]);
  });

  it('a failing delete or clear resolves and reports', async () => {
    const { engine, store, emitted } = makeEngine();
    store.failNext('delete');
    store.failNext('clear');
    await expect(engine.delete({}, ['a'])).resolves.toBeUndefined();
    await expect(engine.clear('users')).resolves.toBeUndefined();
    const ops = emitted.map((e) => [e.event, (e.payload as { operation?: string }).operation]);
    expect(ops).toEqual([
      ['error', 'delete'],
      ['error', 'clear'],
    ]);
  });

  it('clear removes the namespace prefix', async () => {
    const { engine, store, emitted } = makeEngine({ prefix: 'app' });
    await engine.clear('users');
    expect(store.calls.at(-1)).toEqual({ op: 'clear', args: ['app:users:'] });
    expect(emitted.at(-1)).toEqual({
      event: 'clear',
      payload: { store: 'default', namespace: 'users' },
    });
  });

  it('routes to a named store and rejects unknown names', async () => {
    const sessions = new FakeStore();
    const { engine, store, emitted } = makeEngine({
      stores: { default: new FakeStore(), sessions },
    });
    await engine.set({ store: 'sessions', key: 'a' }, 1);
    expect(sessions.data.has('a')).toBe(true);
    expect(store.data.size).toBe(0);
    emitted.length = 0;
    await expect(engine.get({ store: 'nope', key: 'a' })).rejects.toThrow(
      /Unknown cache store "nope"\. Configured stores: default, sessions/,
    );
    expect(emitted).toEqual([]);
    expect(engine.hasStore('sessions')).toBe(true);
    expect(engine.hasStore('nope')).toBe(false);
    expect(engine.storeNames()).toEqual(['default', 'sessions']);
  });

  it('applies jitter and always passes an integer TTL of at least 1 (Review Focus 4)', async () => {
    const { engine, store } = makeEngine({ defaults: { jitter: 0.5 } });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await engine.set({ key: 'low' }, 1, 60_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
    await engine.set({ key: 'high' }, 1, 60_000);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await engine.set({ key: 'tiny' }, 1, 1);
    vi.spyOn(Math, 'random').mockReturnValue(0.3);
    await engine.set({ key: 'odd' }, 1, 1_001);
    expect(store.data.get('low')?.ttlMs).toBe(30_000);
    expect(store.data.get('high')?.ttlMs).toBe(75_000);
    expect(store.data.get('tiny')?.ttlMs).toBe(1);
    expect(Number.isInteger(store.data.get('odd')?.ttlMs)).toBe(true);
  });

  it('put follows the @CachePut table', async () => {
    const { engine, store } = makeEngine();
    const ref = { key: 'a' };
    await engine.put(ref, { n: 1 });
    expect(store.data.has('a')).toBe(true);
    await engine.put(ref, { n: 2 }, { unless: () => true });
    expect(await engine.get(ref)).toEqual({ n: 1 });
    await engine.put(ref, null);
    expect(store.data.has('a')).toBe(false);
    await engine.put(ref, null, { cacheNull: true });
    expect(store.data.get('a')?.ttlMs).toBe(30_000);
    await engine.put(ref, undefined, { cacheNull: true, nullTtl: 7 });
    expect(store.data.get('a')?.ttlMs).toBe(7);
  });

  it('put reports a throwing unless and stores nothing', async () => {
    const { engine, store, emitted } = makeEngine();
    const boom = new Error('bad predicate');
    await engine.put({ key: 'a' }, 1, {
      unless: () => {
        throw boom;
      },
    });
    expect(store.data.size).toBe(0);
    expect(emitted).toEqual([
      { event: 'error', payload: { store: 'default', operation: 'set', error: boom } },
    ]);
  });

  it('reportError emits an error event with store "default" when none is given', () => {
    const { engine, emitted } = makeEngine();
    const error = new Error('x');
    engine.reportError(undefined, 'key', error);
    expect(emitted).toEqual([
      { event: 'error', payload: { store: 'default', operation: 'key', error } },
    ]);
  });
});
