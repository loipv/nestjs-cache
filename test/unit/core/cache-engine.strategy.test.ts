import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StrategyOptions } from '../../../src/decorators/options.js';
import { CacheConfigError } from '../../../src/errors.js';
import { makeEngine } from '../helpers/engine.js';
import { FakeStore } from '../helpers/fake-store.js';

function envelopeOf(store: FakeStore, key: string): Record<string, unknown> {
  return JSON.parse(store.data.get(key)!.value) as Record<string, unknown>;
}

function touchStore(): FakeStore & {
  getAndTouch: ReturnType<
    typeof vi.fn<(key: string, ttlMs: number) => Promise<string | undefined>>
  >;
} {
  const store = new FakeStore();
  return Object.assign(store, {
    getAndTouch: vi.fn((key: string) => Promise.resolve(store.data.get(key)?.value)),
  });
}

describe('CacheEngine with expiry strategies', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('set with swr stores staleAt/expiresAt and the full store TTL', async () => {
    const { engine, store, emitted } = makeEngine();
    vi.setSystemTime(0);
    await engine.set({ key: 'k' }, 'v', { ttl: 100, strategy: 'swr', staleTtl: 300 });
    expect(store.data.get('k')?.ttlMs).toBe(400);
    expect(JSON.parse(store.data.get('k')!.value)).toMatchObject({ staleAt: 100, expiresAt: 400 });
    expect(emitted.at(-1)).toEqual({
      event: 'set',
      payload: { store: 'default', namespace: undefined, key: 'k', ttl: 400 },
    });
  });

  it('get returns a stale value with hit stale:true', async () => {
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'k' }, 'v', { ttl: 100, strategy: 'swr', staleTtl: 300 });
    vi.setSystemTime(50);
    expect(await engine.get({ key: 'k' })).toBe('v');
    expect(emitted.at(-1)).toEqual({
      event: 'hit',
      payload: { store: 'default', namespace: undefined, key: 'k', stale: false },
    });
    vi.setSystemTime(150);
    expect(await engine.get({ key: 'k' })).toBe('v');
    expect(emitted.at(-1)).toEqual({
      event: 'hit',
      payload: { store: 'default', namespace: undefined, key: 'k', stale: true },
    });
    vi.setSystemTime(400);
    expect(await engine.get({ key: 'k' })).toBeUndefined();
    expect(emitted.at(-1)?.event).toBe('miss');
  });

  it('getOrSet with swr serves stale without waiting for the load', async () => {
    const { engine, emitted } = makeEngine();
    const options = { ttl: 100, strategy: 'swr', staleTtl: 300 } as const;
    await engine.set({ key: 'k' }, 'v', options);
    vi.setSystemTime(150);
    emitted.length = 0;
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('new');
          }, 10);
        }),
    );
    expect(await engine.getOrSet({ key: 'k' }, loader, options)).toBe('v');
    // The load runs in the background (see cache-engine.swr.test.ts).
    expect(loader).toHaveBeenCalledOnce();
    expect(emitted).toEqual([
      {
        event: 'hit',
        payload: { store: 'default', namespace: undefined, key: 'k', stale: true },
      },
    ]);
    await vi.runAllTimersAsync();
  });

  it('getOrSet without swr reloads a stale-window entry', async () => {
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'k' }, 'v', { ttl: 100, strategy: 'swr', staleTtl: 300 });
    vi.setSystemTime(150);
    emitted.length = 0;
    const loader = vi.fn(async () => 'new');
    expect(await engine.getOrSet({ key: 'k' }, loader)).toBe('new');
    expect(await engine.getOrSet({ key: 'k' }, loader, { strategy: 'fixed' })).toBe('new');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(emitted.map((e) => e.event)).toEqual(['miss', 'load', 'set', 'hit']);
  });

  it('0.1 envelopes stay readable after upgrade (Review Focus 1)', async () => {
    const { engine, store, emitted } = makeEngine();
    store.data.set('k', {
      value: JSON.stringify({ v: 1, value: 'old', storedAt: 0, expiresAt: 100 }),
      ttlMs: 100,
    });
    vi.setSystemTime(50);
    expect(
      await engine.getOrSet({ key: 'k' }, async () => 'new', { strategy: 'swr', staleTtl: 1_000 }),
    ).toBe('old');
    // A 0.1 envelope has no staleAt: before expiresAt it is a fresh hit, with no refresh.
    expect(emitted).toEqual([
      {
        event: 'hit',
        payload: { store: 'default', namespace: undefined, key: 'k', stale: false },
      },
    ]);
    vi.setSystemTime(100);
    expect(
      await engine.getOrSet({ key: 'k' }, async () => 'new', { strategy: 'swr', staleTtl: 1_000 }),
    ).toBe('new');
  });

  it('sliding uses getAndTouch with the effective ttl and writes without jitter', async () => {
    const store = Object.assign(new FakeStore(), { getAndTouch: vi.fn(async () => undefined) });
    const { engine } = makeEngine({
      stores: { default: store },
      defaults: { ttl: 1_000, jitter: 0.5 },
    });
    await engine.set({ key: 'k' }, 'v', { strategy: 'sliding' });
    expect(store.data.get('k')?.ttlMs).toBe(1_000);
    await engine.get({ key: 'k' }, { strategy: 'sliding' });
    expect(store.getAndTouch).toHaveBeenCalledWith('k', 1_000);
    await engine.getOrSet({ key: 'k' }, async () => 'v', { strategy: 'sliding', ttl: 2_000 });
    expect(store.getAndTouch).toHaveBeenLastCalledWith('k', 2_000);
    expect(store.data.get('k')?.ttlMs).toBe(2_000);
    expect(store.calls.filter((c) => c.op === 'get')).toEqual([]);
  });

  it('a touching read deletes an entry past its own expiresAt, and swallows a failed delete', async () => {
    const store = touchStore();
    const { engine, emitted } = makeEngine({ stores: { default: store } });
    await engine.put({ key: 'k' }, null, { cacheNull: true, nullTtl: 100 });
    vi.setSystemTime(500);
    store.calls.length = 0;
    store.getAndTouch.mockClear();
    store.failNext('delete');
    emitted.length = 0;
    expect(await engine.get({ key: 'k' }, { strategy: 'sliding' })).toBeUndefined();
    expect(store.getAndTouch).toHaveBeenCalledTimes(1);
    expect(store.calls).toEqual([{ op: 'delete', args: [['k']] }]);
    expect(emitted.map((e) => e.event)).toEqual(['miss']);
  });

  it('a non-touching fixed read of an expiresAt-expired entry issues no delete', async () => {
    const { engine, store } = makeEngine();
    await engine.set({ key: 'k' }, 'v', { ttl: 100 });
    vi.setSystemTime(500);
    store.calls.length = 0;
    expect(await engine.get({ key: 'k' })).toBeUndefined();
    expect(store.calls).toEqual([{ op: 'get', args: ['k'] }]);
  });

  it('a non-touching swr read of an entry past expiresAt issues no delete', async () => {
    const { engine, store, emitted } = makeEngine();
    await engine.set({ key: 'k' }, 'v', { ttl: 100, strategy: 'swr', staleTtl: 300 });
    vi.setSystemTime(400);
    store.calls.length = 0;
    emitted.length = 0;
    expect(await engine.get({ key: 'k' }, { strategy: 'swr', staleTtl: 300 })).toBeUndefined();
    expect(store.calls).toEqual([{ op: 'get', args: ['k'] }]);
    expect(emitted.map((e) => e.event)).toEqual(['miss']);
  });

  it('sliding hits through getAndTouch without re-setting the entry', async () => {
    const store = touchStore();
    const { engine, emitted } = makeEngine({ stores: { default: store } });
    await engine.set({ key: 'k' }, 'v', { strategy: 'sliding' });
    expect(envelopeOf(store, 'k')).toEqual({ v: 1, value: 'v', storedAt: 0 });
    store.calls.length = 0;
    vi.setSystemTime(1e9);
    expect(await engine.get({ key: 'k' }, { strategy: 'sliding' })).toBe('v');
    expect(store.getAndTouch).toHaveBeenCalledWith('k', 60_000);
    expect(store.calls).toEqual([]);
    expect(emitted.at(-1)?.payload).toMatchObject({ key: 'k', stale: false });
  });

  it('sliding falls back to get + re-set when the store has no getAndTouch', async () => {
    const { engine, store, emitted } = makeEngine();
    await engine.set({ key: 'k' }, 'v', { strategy: 'sliding', ttl: 1_000 });
    const raw = store.data.get('k')!.value;
    store.calls.length = 0;

    expect(await engine.get({ key: 'k' }, { strategy: 'sliding' })).toBe('v');
    expect(store.calls).toEqual([
      { op: 'get', args: ['k'] },
      { op: 'set', args: ['k', raw, 60_000] },
    ]);

    store.calls.length = 0;
    const loader = vi.fn(async () => 'new');
    expect(await engine.getOrSet({ key: 'k' }, loader, { strategy: 'sliding', ttl: 2_000 })).toBe(
      'v',
    );
    expect(loader).not.toHaveBeenCalled();
    expect(store.calls).toEqual([
      { op: 'get', args: ['k'] },
      { op: 'set', args: ['k', raw, 2_000] },
    ]);
    expect(emitted.filter((e) => e.event === 'set')).toHaveLength(1);

    store.calls.length = 0;
    expect(await engine.get({ key: 'missing' }, { strategy: 'sliding' })).toBeUndefined();
    expect(store.calls).toEqual([{ op: 'get', args: ['missing'] }]);
  });

  it('a sliding reader without getAndTouch does not re-set a stale swr entry', async () => {
    const { engine, store, emitted } = makeEngine();
    await engine.set({ key: 'k' }, 'old', { ttl: 100, strategy: 'swr', staleTtl: 300 });
    vi.setSystemTime(150);
    store.calls.length = 0;
    emitted.length = 0;
    const loader = vi.fn(async () => 'new');
    expect(await engine.getOrSet({ key: 'k' }, loader, { strategy: 'sliding', ttl: 1_000 })).toBe(
      'new',
    );
    expect(loader).toHaveBeenCalledOnce();
    // The only set is the reload's write: no wasted re-set of the stale string first.
    expect(store.calls.map((c) => c.op)).toEqual(['get', 'set']);
    expect(envelopeOf(store, 'k')).toEqual({ v: 1, value: 'new', storedAt: 150 });
    expect(emitted.map((e) => e.event)).toEqual(['miss', 'load', 'set']);

    // `get` serves the stale value without re-setting it either.
    await engine.set({ key: 'j' }, 'old', { ttl: 100, strategy: 'swr', staleTtl: 300 });
    vi.setSystemTime(300);
    store.calls.length = 0;
    expect(await engine.get({ key: 'j' }, { strategy: 'sliding' })).toBe('old');
    expect(store.calls).toEqual([{ op: 'get', args: ['j'] }]);
    expect(emitted.at(-1)).toEqual({
      event: 'hit',
      payload: { store: 'default', namespace: undefined, key: 'j', stale: true },
    });
  });

  it('a failed sliding re-set is reported as set and keeps the read result', async () => {
    const { engine, store, emitted } = makeEngine();
    await engine.set({ key: 'k' }, 'v', { strategy: 'sliding' });
    store.failNext('set');
    expect(await engine.get({ key: 'k' }, { strategy: 'sliding' })).toBe('v');
    const loader = vi.fn(async () => 'new');
    store.failNext('set');
    expect(await engine.getOrSet({ key: 'k' }, loader, { strategy: 'sliding' })).toBe('v');
    expect(loader).not.toHaveBeenCalled();
    const errors = emitted.filter((e) => e.event === 'error');
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => (e.payload as { operation: string }).operation)).toEqual([
      'set',
      'set',
    ]);
    expect(emitted.filter((e) => e.event === 'hit')).toHaveLength(2);
  });

  it('sliding fallback never re-sets an entry past maxTtl (Review Focus 1b)', async () => {
    const { engine, store, emitted } = makeEngine({ defaults: { ttl: 1_000 } });
    const options = { strategy: 'sliding', maxTtl: 2_000 } as const;
    await engine.set({ key: 'k' }, 'v', options);
    vi.setSystemTime(1_999);
    expect(await engine.get({ key: 'k' }, options)).toBe('v');

    vi.setSystemTime(2_000);
    store.calls.length = 0;
    expect(await engine.get({ key: 'k' }, options)).toBeUndefined();
    expect(store.calls).toEqual([
      { op: 'get', args: ['k'] },
      { op: 'delete', args: [['k']] },
    ]);
    expect(emitted.at(-1)).toEqual({
      event: 'miss',
      payload: { store: 'default', namespace: undefined, key: 'k' },
    });

    store.calls.length = 0;
    const loader = vi.fn(async () => 'new');
    expect(await engine.getOrSet({ key: 'k' }, loader, options)).toBe('new');
    expect(loader).toHaveBeenCalledTimes(1);
    // The entry was already deleted by the previous read, so this is a plain miss.
    expect(store.calls.map((c) => c.op)).toEqual(['get', 'set']);
    expect(envelopeOf(store, 'k')).toEqual({ v: 1, value: 'new', storedAt: 2_000 });
  });

  it('deletes a sliding entry past maxTtl, best effort', async () => {
    const { engine, store, emitted } = makeEngine({ prefix: 'app' });
    const ref = { namespace: 'ns', key: 'k' };
    const options = { strategy: 'sliding', ttl: 1_000, maxTtl: 2_000 } as const;
    await engine.set(ref, 'v', options);
    vi.setSystemTime(2_000);
    store.calls.length = 0;
    emitted.length = 0;
    expect(await engine.get(ref, options)).toBeUndefined();
    expect(store.calls).toContainEqual({ op: 'delete', args: [['app:ns:k']] });
    expect(store.data.has('app:ns:k')).toBe(false);
    // The best-effort delete emits no delete event either.
    expect(emitted.map((e) => e.event)).toEqual(['miss']);

    // A failing delete is swallowed: no error event, still a miss.
    await engine.set(ref, 'v', options);
    vi.setSystemTime(4_000);
    store.failNext('delete');
    emitted.length = 0;
    expect(await engine.get(ref, options)).toBeUndefined();
    expect(emitted.map((e) => e.event)).toEqual(['miss']);

    // getOrSet deletes before the miss load, and a failing delete still loads.
    vi.setSystemTime(6_000);
    store.failNext('delete');
    store.calls.length = 0;
    emitted.length = 0;
    const loader = vi.fn(async () => 'new');
    expect(await engine.getOrSet(ref, loader, options)).toBe('new');
    expect(store.calls.map((c) => c.op)).toEqual(['get', 'delete', 'set']);
    expect(emitted.map((e) => e.event)).toEqual(['miss', 'load', 'set']);
  });

  it('leaves an entry expired by expiresAt for the store to drop on non-touching reads', async () => {
    const { engine, store } = makeEngine();
    await engine.set({ key: 'k' }, 'v', { ttl: 1_000 });
    vi.setSystemTime(1_000);
    store.calls.length = 0;
    expect(await engine.get({ key: 'k' })).toBeUndefined();
    expect(await engine.getOrSet({ key: 'k' }, async () => 'new', { ttl: 1_000 })).toBe('new');
    expect(store.calls.map((c) => c.op)).not.toContain('delete');
    // A touching read has just extended the store TTL, so it must drop the dead entry.
    await engine.set({ key: 'j' }, 'v', { ttl: 1_000 });
    vi.setSystemTime(2_000);
    store.calls.length = 0;
    expect(await engine.get({ key: 'j' }, { strategy: 'sliding' })).toBeUndefined();
    expect(store.calls.map((c) => c.op)).toContain('delete');
  });

  it('sliding expires after maxTtl', async () => {
    const store = touchStore();
    const { engine } = makeEngine({ stores: { default: store } });
    const options = { strategy: 'sliding', ttl: 1_000, maxTtl: 5_000 } as const;
    const loader = vi.fn(async () => `v${String(Date.now())}`);
    expect(await engine.getOrSet({ key: 'k' }, loader, options)).toBe('v0');
    vi.setSystemTime(4_999);
    expect(await engine.getOrSet({ key: 'k' }, loader, options)).toBe('v0');
    expect(loader).toHaveBeenCalledTimes(1);
    vi.setSystemTime(5_000);
    expect(await engine.getOrSet({ key: 'k' }, loader, options)).toBe('v5000');
    expect(loader).toHaveBeenCalledTimes(2);
    expect(envelopeOf(store, 'k')).toEqual({ v: 1, value: 'v5000', storedAt: 5_000 });
  });

  it('empty values ignore the strategy', async () => {
    const { engine, store, emitted } = makeEngine({ defaults: { jitter: 0.5 } });
    const empty = { cacheNull: true, nullTtl: 50.4 } as const;
    await engine.getOrSet({ key: 'a' }, async () => null, {
      ...empty,
      strategy: 'swr',
      staleTtl: 300,
    });
    expect(envelopeOf(store, 'a')).toEqual({
      v: 1,
      value: null,
      storedAt: 0,
      expiresAt: 50,
      nil: 'null',
    });
    expect(store.data.get('a')?.ttlMs).toBe(50);
    expect(emitted.at(-1)?.payload).toMatchObject({ key: 'a', ttl: 50 });

    await engine.put({ key: 'b' }, undefined, { ...empty, strategy: 'sliding' });
    expect(envelopeOf(store, 'b')).toEqual({
      v: 1,
      value: null,
      storedAt: 0,
      expiresAt: 50,
      nil: 'undefined',
    });
    expect(store.data.get('b')?.ttlMs).toBe(50);
    vi.setSystemTime(49);
    const loader = vi.fn(async () => 'x');
    expect(await engine.getOrSet({ key: 'b' }, loader, { ...empty, strategy: 'sliding' })).toBe(
      undefined,
    );
    expect(loader).not.toHaveBeenCalled();
  });

  it('set keeps the nil marker of an empty value whatever the strategy', async () => {
    const { engine, store } = makeEngine();
    await engine.set({ key: 'k' }, null, { strategy: 'sliding', ttl: 1_000 });
    expect(envelopeOf(store, 'k')).toEqual({
      v: 1,
      value: null,
      storedAt: 0,
      expiresAt: 1_000,
      nil: 'null',
    });
    expect(store.data.get('k')?.ttlMs).toBe(1_000);
    expect(await engine.get({ key: 'k' }, { strategy: 'sliding' })).toBeNull();
  });

  it.each([
    ['staleTtl', 0],
    ['maxTtl', -1],
    ['staleTtl', Number.NaN],
    ['maxTtl', Number.POSITIVE_INFINITY],
  ] as const)('rejects %s = %s before any store call', async (field, value) => {
    const { engine, store, emitted } = makeEngine();
    const strategy = field === 'staleTtl' ? 'swr' : 'sliding';
    const options = { strategy, [field]: value } as unknown as StrategyOptions;
    const loader = vi.fn(async () => 1);
    const ref = { key: 'k' };
    await expect(engine.getOrSet(ref, loader, options)).rejects.toBeInstanceOf(CacheConfigError);
    await expect(engine.getOrSet(ref, loader, options)).rejects.toThrow(
      `Invalid ${field}: ${String(value)}. Durations are milliseconds, finite numbers greater than 0.`,
    );
    await expect(engine.put(ref, 1, options)).rejects.toBeInstanceOf(CacheConfigError);
    await expect(engine.set(ref, 1, options)).rejects.toBeInstanceOf(CacheConfigError);
    await expect(engine.get(ref, options)).rejects.toBeInstanceOf(CacheConfigError);
    expect(loader).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('rejects swr without staleTtl and an unknown strategy before any store call', async () => {
    const { engine, store } = makeEngine();
    const loader = vi.fn(async () => 1);
    const noWindow = { strategy: 'swr' } as unknown as StrategyOptions;
    const unknown = { strategy: 'lru' } as unknown as StrategyOptions;
    await expect(engine.getOrSet({ key: 'k' }, loader, noWindow)).rejects.toThrow(
      /^Invalid staleTtl: undefined/,
    );
    await expect(engine.set({ key: 'k' }, 1, noWindow)).rejects.toBeInstanceOf(CacheConfigError);
    await expect(engine.getOrSet({ key: 'k' }, loader, unknown)).rejects.toThrow(
      'Unknown cache strategy: lru',
    );
    await expect(engine.get({ key: 'k' }, unknown)).rejects.toBeInstanceOf(CacheConfigError);
    expect(loader).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);
  });

  it('rejects maxTtl below the effective ttl', async () => {
    const { engine, store } = makeEngine({ defaults: { ttl: 60_000 } });
    await expect(
      engine.getOrSet({ key: 'k' }, async () => 1, { strategy: 'sliding', maxTtl: 1_000 }),
    ).rejects.toThrow('Invalid maxTtl: 1000. It must be >= ttl (60000).');
    await expect(
      engine.set({ key: 'k' }, 1, { strategy: 'sliding', ttl: 5_000, maxTtl: 4_999 }),
    ).rejects.toThrow('Invalid maxTtl: 4999. It must be >= ttl (5000).');
    await expect(
      engine.put({ key: 'k' }, 1, { strategy: 'sliding', maxTtl: 1_000 }),
    ).rejects.toBeInstanceOf(CacheConfigError);
    expect(store.calls).toEqual([]);
    await engine.set({ key: 'k' }, 1, { strategy: 'sliding', ttl: 5_000, maxTtl: 5_000 });
    expect(store.data.get('k')?.ttlMs).toBe(5_000);
  });
});
