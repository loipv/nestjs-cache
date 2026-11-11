import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import type { CacheStore, LockProvider } from '../../../src/stores/cache-store.interface.js';
import { makeEngine } from '../helpers/engine.js';
import { FakeLock } from '../helpers/fake-lock.js';
import { FakeStore } from '../helpers/fake-store.js';

const SWR = { ttl: 100, strategy: 'swr', staleTtl: 1_000 } as const;

/** A FakeStore with the optional batch methods, recording each batch call. */
class BatchStore extends FakeStore {
  readonly getManyCalls: string[][] = [];
  readonly setManyCalls: { key: string; value: string; ttlMs: number }[][] = [];
  getAndTouchCalls: string[] = [];
  failGetMany: Error | undefined;
  failSetMany: Error | undefined;

  getMany(keys: readonly string[]): Promise<(string | undefined)[]> {
    this.getManyCalls.push([...keys]);
    if (this.failGetMany) return Promise.reject(this.failGetMany);
    return Promise.resolve(keys.map((key) => this.data.get(key)?.value));
  }

  setMany(entries: readonly { key: string; value: string; ttlMs: number }[]): Promise<void> {
    this.setManyCalls.push(entries.map((e) => ({ ...e })));
    if (this.failSetMany) return Promise.reject(this.failSetMany);
    for (const e of entries) this.data.set(e.key, { value: e.value, ttlMs: e.ttlMs });
    return Promise.resolve();
  }

  getAndTouch(key: string, ttlMs: number): Promise<string | undefined> {
    this.getAndTouchCalls.push(key);
    const entry = this.data.get(key);
    if (entry) entry.ttlMs = ttlMs;
    return Promise.resolve(entry?.value);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(options: Parameters<typeof makeEngine>[0] = {}) {
  const store = new BatchStore();
  const made = makeEngine({ ...options, stores: { ...options.stores, default: store } });
  return { ...made, store };
}

function events(emitted: { event: string }[]): string[] {
  return emitted.map((e) => e.event);
}

describe('CacheEngine batch API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('getMany', () => {
    it('returns values in input order through one store.getMany call', async () => {
      /* Three keys, two cached: the result follows the input order, the store is read once
         with every full key, and each key emits its own hit or miss. */
      const { engine, store, emitted } = setup();
      await engine.set({ namespace: 'n', key: 'a' }, 1);
      await engine.set({ namespace: 'n', key: 'c' }, 3);
      emitted.length = 0;
      expect(await engine.getMany({ namespace: 'n' }, ['c', 'b', 'a'])).toEqual([3, undefined, 1]);
      expect(store.getManyCalls).toEqual([['n:c', 'n:b', 'n:a']]);
      expect(store.calls.filter((c) => c.op === 'get')).toEqual([]);
      expect(events(emitted)).toEqual(['hit', 'miss', 'hit']);
      expect(emitted[1]?.payload).toEqual({ store: 'default', namespace: 'n', key: 'b' });
    });

    it('reads a duplicate key once and returns it at every position', async () => {
      /* ['a', 'b', 'a']: the store sees ['a', 'b'] and the result repeats a's value. */
      const { engine, store, emitted } = setup();
      await engine.set({ key: 'a' }, 'x');
      emitted.length = 0;
      expect(await engine.getMany({}, ['a', 'b', 'a'])).toEqual(['x', undefined, 'x']);
      expect(store.getManyCalls).toEqual([['a', 'b']]);
      expect(events(emitted)).toEqual(['hit', 'miss']);
    });

    it('an empty list makes no store call', async () => {
      /* getMany([]) resolves [] without touching the store or emitting anything. */
      const { engine, store, emitted } = setup();
      expect(await engine.getMany({}, [])).toEqual([]);
      expect(store.getManyCalls).toEqual([]);
      expect(store.calls).toEqual([]);
      expect(emitted).toEqual([]);
    });

    it('an empty key gives undefined and one key error for the batch', async () => {
      /* Two empty keys among valid ones: one key error, their positions are undefined, the
         other keys are still read. */
      const { engine, store, emitted } = setup();
      await engine.set({ key: 'a' }, 1);
      emitted.length = 0;
      expect(await engine.getMany({}, ['', 'a', ''])).toEqual([undefined, 1, undefined]);
      expect(store.getManyCalls).toEqual([['a']]);
      expect(events(emitted)).toEqual(['error', 'hit']);
      expect(emitted[0]?.payload).toMatchObject({ operation: 'key' });
    });

    it('only empty keys make no store call', async () => {
      /* [''] reports the key error and reads nothing. */
      const { engine, store } = setup();
      expect(await engine.getMany({}, [''])).toEqual([undefined]);
      expect(store.getManyCalls).toEqual([]);
    });

    it('sliding reads each key with getAndTouch, never getMany', async () => {
      /* The sliding window must be reset per entry, so the batch read goes key by key. */
      const { engine, store } = setup();
      const sliding = { strategy: 'sliding' } as const;
      await engine.set({ key: 'a' }, 1, sliding);
      await engine.set({ key: 'b' }, 2, sliding);
      expect(await engine.getMany({}, ['a', 'b', 'c'], sliding)).toEqual([1, 2, undefined]);
      expect(store.getManyCalls).toEqual([]);
      expect(store.getAndTouchCalls).toEqual(['a', 'b', 'c']);
    });

    it('a version failure returns all undefined with no miss', async () => {
      /* The namespace version cannot be read: one version error, no hit/miss, no data read. */
      const { engine, store, emitted } = setup({ namespaces: { users: { versioned: true } } });
      store.failNext('get');
      expect(await engine.getMany({ namespace: 'users' }, ['1', '2'])).toEqual([
        undefined,
        undefined,
      ]);
      expect(events(emitted)).toEqual(['error']);
      expect(emitted[0]?.payload).toMatchObject({ operation: 'version' });
      expect(store.getManyCalls).toEqual([]);
    });

    it('a versioned namespace reads its version once for the batch', async () => {
      /* One version read serves every key; data keys carry the version. */
      const { engine, store } = setup({ namespaces: { users: { versioned: true } } });
      await engine.set({ namespace: 'users', key: '1' }, 'one');
      const versionReads = (): number =>
        store.calls.filter((c) => c.op === 'get' && c.args[0] === '__version__:users').length;
      const before = versionReads();
      expect(await engine.getMany({ namespace: 'users' }, ['1', '2'])).toEqual(['one', undefined]);
      expect(versionReads()).toBe(before);
      expect(store.getManyCalls[0]?.every((k) => /^users@[0-9a-z]{8}:\d$/.test(k))).toBe(true);
    });

    it('a failing store.getMany counts as misses and reports one get error', async () => {
      /* The batch read rejects: every key is a miss and one get error is reported. */
      const { engine, store, emitted } = setup();
      store.failGetMany = new Error('down');
      expect(await engine.getMany({}, ['a', 'b'])).toEqual([undefined, undefined]);
      expect(events(emitted)).toEqual(['error', 'miss', 'miss']);
      expect(emitted[0]?.payload).toMatchObject({ operation: 'get' });
    });

    it('falls back to one get per key when the store has no getMany', async () => {
      /* A plain store: one get per key; a failing get is a miss and one get error. */
      const store = new FakeStore();
      const { engine, emitted } = makeEngine({ stores: { default: store } });
      await engine.set({ key: 'a' }, 1);
      await engine.set({ key: 'b' }, 2);
      emitted.length = 0;
      store.failNext('get');
      expect(await engine.getMany({}, ['a', 'b'])).toEqual([undefined, 2]);
      expect(store.calls.filter((c) => c.op === 'get').map((c) => c.args[0])).toEqual(['a', 'b']);
      expect(events(emitted)).toEqual(['error', 'miss', 'hit']);
    });

    it('serves a stale swr entry as a stale hit and an expired one as a miss', async () => {
      /* Classification is the single-key get's: stale is a stale hit, expired a miss. */
      const { engine, emitted } = setup();
      await engine.set({ key: 's' }, 'old', SWR);
      await engine.set({ key: 'e' }, 'gone', { ttl: 50 });
      vi.setSystemTime(150);
      emitted.length = 0;
      expect(await engine.getMany({}, ['s', 'e'], SWR)).toEqual(['old', undefined]);
      expect(emitted[0]?.payload).toMatchObject({ key: 's', stale: true });
      expect(events(emitted)).toEqual(['hit', 'miss']);
    });

    it('validates store, namespace, options, then keys', async () => {
      /* Each check rejects with CacheConfigError, in the documented order. */
      const { engine } = setup();
      await expect(
        engine.getMany({ store: 'nope', namespace: '__x' }, 'k' as unknown as string[]),
      ).rejects.toThrow(/Unknown cache store/);
      await expect(
        engine.getMany({ namespace: '__x' }, 'k' as unknown as string[], {
          strategy: 'bad' as 'fixed',
        }),
      ).rejects.toThrow(/reserved/);
      await expect(
        engine.getMany({}, 'k' as unknown as string[], { strategy: 'bad' as 'fixed' }),
      ).rejects.toThrow(/Unknown cache strategy/);
      await expect(engine.getMany({}, 'k' as unknown as string[])).rejects.toThrow(
        new CacheConfigError('Invalid keys: k. It must be an array of strings.'),
      );
    });
  });

  describe('setMany', () => {
    it('writes every entry with one store.setMany call and emits set per entry', async () => {
      /* Two entries go to the store in one call, each under its full key. */
      const { engine, store, emitted } = setup();
      await engine.setMany({ namespace: 'n' }, [
        ['a', 1],
        ['b', { x: 2 }],
      ]);
      expect(store.setManyCalls).toHaveLength(1);
      expect(store.setManyCalls[0]?.map((e) => [e.key, e.ttlMs])).toEqual([
        ['n:a', 60_000],
        ['n:b', 60_000],
      ]);
      expect(store.calls.filter((c) => c.op === 'set')).toEqual([]);
      expect(events(emitted)).toEqual(['set', 'set']);
      expect(emitted[1]?.payload).toEqual({
        store: 'default',
        namespace: 'n',
        key: 'b',
        ttl: 60_000,
      });
      expect(await engine.getMany({ namespace: 'n' }, ['a', 'b'])).toEqual([1, { x: 2 }]);
    });

    it('jitters the ttl of each entry separately', async () => {
      /* With jitter, each entry draws its own random factor. */
      const { engine, store } = setup({ defaults: { jitter: 0.5 } });
      vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(1);
      await engine.setMany(
        {},
        [
          ['a', 1],
          ['b', 2],
        ],
        { ttl: 1_000 },
      );
      expect(store.setManyCalls[0]?.map((e) => e.ttlMs)).toEqual([500, 1_500]);
    });

    it('an empty value follows set semantics: the 0.1 ttl, written as fixed', async () => {
      /* Under swr, null is written with a fixed envelope and the plain ttl, as set does. */
      const { engine, store } = setup();
      await engine.setMany(
        {},
        [
          ['n', null],
          ['v', 'x'],
        ],
        SWR,
      );
      const [nullEntry, valueEntry] = store.setManyCalls[0] ?? [];
      expect(nullEntry?.ttlMs).toBe(100);
      const envelope: unknown = JSON.parse(nullEntry?.value ?? '');
      expect(envelope).toEqual({ v: 1, value: null, storedAt: 0, expiresAt: 100, nil: 'null' });
      expect(valueEntry?.ttlMs).toBe(1_100);
    });

    it('dedupes keys, keeping the last value, and drops empty keys with one key error', async () => {
      /* A repeated key is written once, with its last value; '' is reported once. */
      const { engine, store, emitted } = setup();
      await engine.setMany({}, [
        ['a', 1],
        ['', 2],
        ['a', 3],
        ['', 4],
      ]);
      expect(store.setManyCalls[0]?.map((e) => e.key)).toEqual(['a']);
      expect(await engine.get({ key: 'a' })).toBe(3);
      expect(events(emitted).filter((e) => e === 'error')).toHaveLength(1);
    });

    it('an empty list or only empty keys make no store call', async () => {
      /* Nothing to write: no setMany, no set. */
      const { engine, store } = setup();
      await engine.setMany({}, []);
      await engine.setMany({}, [['', 1]]);
      expect(store.setManyCalls).toEqual([]);
      expect(store.calls).toEqual([]);
    });

    it('a failing setMany reports one set error and emits no set', async () => {
      /* The batch write rejects: one set error, nothing reaches the caller. */
      const { engine, store, emitted } = setup();
      store.failSetMany = new Error('down');
      await engine.setMany({}, [
        ['a', 1],
        ['b', 2],
      ]);
      expect(events(emitted)).toEqual(['error']);
      expect(emitted[0]?.payload).toMatchObject({ operation: 'set' });
    });

    it('falls back to one set per entry when the store has no setMany', async () => {
      /* A plain store gets one set per entry; a failing set is one error, the others emit set. */
      const store = new FakeStore();
      const { engine, emitted } = makeEngine({ stores: { default: store } });
      store.failNext('set');
      await engine.setMany({}, [
        ['a', 1],
        ['b', 2],
      ]);
      expect(store.calls.filter((c) => c.op === 'set').map((c) => c.args[0])).toEqual(['a', 'b']);
      expect(events(emitted)).toEqual(['error', 'set']);
      expect(emitted[1]?.payload).toMatchObject({ key: 'b' });
    });

    it('an unserializable value reports a set error and the others are written', async () => {
      /* serialize throws for one entry only: the rest still go through setMany. */
      const { engine, store, emitted } = setup();
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      await engine.setMany({}, [
        ['a', cyclic],
        ['b', 2],
      ]);
      expect(store.setManyCalls[0]?.map((e) => e.key)).toEqual(['b']);
      expect(events(emitted)).toEqual(['error', 'set']);
    });

    it('a version failure writes nothing', async () => {
      /* The version cannot be read: one version error and no data write. */
      const { engine, store, emitted } = setup({ namespaces: { users: { versioned: true } } });
      store.failNext('get');
      await engine.setMany({ namespace: 'users' }, [['1', 'x']]);
      expect(store.setManyCalls).toEqual([]);
      expect(events(emitted)).toEqual(['error']);
    });

    it('validates store, namespace, options, then entries', async () => {
      /* Each check rejects with CacheConfigError, in the documented order. */
      const { engine } = setup();
      const bad = 5 as unknown as [string, unknown][];
      await expect(engine.setMany({ store: 'nope' }, bad)).rejects.toThrow(/Unknown cache store/);
      await expect(engine.setMany({ namespace: '__x' }, bad, { ttl: -1 })).rejects.toThrow(
        /reserved/,
      );
      await expect(engine.setMany({}, bad, { ttl: -1 })).rejects.toThrow(/Invalid ttl/);
      await expect(engine.setMany({}, bad)).rejects.toThrow(
        new CacheConfigError('Invalid entries: 5. It must be an array of [key, value] pairs.'),
      );
    });
  });

  describe('getOrSetMany', () => {
    it('loads only the misses, in input order and deduped, and returns every position', async () => {
      /* 'b' is cached; the loader receives ['c', 'a'] once and the result repeats 'a'. */
      const { engine, store, emitted } = setup();
      await engine.set({ key: 'b' }, 'B');
      emitted.length = 0;
      const loader = vi.fn(
        async (missing: string[]) => new Map(missing.map((k) => [k, k.toUpperCase()])),
      );
      expect(await engine.getOrSetMany({}, ['c', 'b', 'a', 'c'], loader)).toEqual([
        'C',
        'B',
        'A',
        'C',
      ]);
      expect(loader).toHaveBeenCalledOnce();
      expect(loader).toHaveBeenCalledWith(['c', 'a']);
      expect(store.setManyCalls).toHaveLength(1);
      expect(store.setManyCalls[0]?.map((e) => e.key)).toEqual(['c', 'a']);
      expect(events(emitted)).toEqual(['miss', 'hit', 'miss', 'load', 'set', 'set']);
      // Served from the cache now.
      expect(await engine.getOrSetMany({}, ['a', 'c'], loader)).toEqual(['A', 'C']);
      expect(loader).toHaveBeenCalledOnce();
    });

    it('emits one load event carrying every loaded key', async () => {
      /* The load event's key is the first missing key and keys lists all of them. */
      const { engine, emitted } = setup();
      const pending = engine.getOrSetMany({ namespace: 'n' }, ['x', 'y'], async () => {
        await new Promise((r) => setTimeout(r, 40));
        return new Map([['x', 1]]);
      });
      await vi.advanceTimersByTimeAsync(40);
      expect(await pending).toEqual([1, undefined]);
      const loads = emitted.filter((e) => e.event === 'load');
      expect(loads).toHaveLength(1);
      expect(loads[0]?.payload).toEqual({
        store: 'default',
        namespace: 'n',
        key: 'x',
        keys: ['x', 'y'],
        durationMs: 40,
        success: true,
      });
    });

    it('cacheNull writes a null marker for a key the loader omits; off, nothing is written', async () => {
      /* 'b' is absent from the map: with cacheNull it is cached as null with nullTtl, without
         it nothing is written for it. */
      const loader = async (): Promise<Map<string, number>> => new Map([['a', 1]]);
      const on = setup();
      expect(
        await on.engine.getOrSetMany({}, ['a', 'b'], loader, { cacheNull: true, nullTtl: 7 }),
      ).toEqual([1, undefined]);
      expect(on.store.setManyCalls[0]?.map((e) => [e.key, e.ttlMs])).toEqual([
        ['a', 60_000],
        ['b', 7],
      ]);
      const reload = vi.fn(loader);
      // The marker is a hit for `undefined`: the omitted key is not loaded again.
      expect(await on.engine.getOrSetMany({}, ['b'], reload, { cacheNull: true })).toEqual([
        undefined,
      ]);
      expect(reload).not.toHaveBeenCalled();
      expect(on.emitted.at(-1)).toMatchObject({ event: 'hit', payload: { key: 'b' } });

      const off = setup();
      await off.engine.getOrSetMany({}, ['a', 'b'], loader, { cacheNull: false });
      expect(off.store.setManyCalls[0]?.map((e) => e.key)).toEqual(['a']);
    });

    it('applies unless, ttl and jitter per value', async () => {
      /* unless skips one value; the other is written with its own jittered ttl. A throwing
         unless is a set error for that value only. */
      const { engine, store, emitted } = setup({ defaults: { jitter: 0.5 } });
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const loader = async (): Promise<Map<string, number>> =>
        new Map([
          ['a', 1],
          ['b', -1],
          ['c', 3],
        ]);
      const unless = (v: number): boolean => {
        if (v === 3) throw new Error('bad unless');
        return v < 0;
      };
      expect(await engine.getOrSetMany({}, ['a', 'b', 'c'], loader, { ttl: 100, unless })).toEqual([
        1, -1, 3,
      ]);
      expect(store.setManyCalls[0]?.map((e) => [e.key, e.ttlMs])).toEqual([['a', 150]]);
      expect(events(emitted).filter((e) => e === 'error')).toHaveLength(1);
    });

    it('writes nothing when every loaded value is skipped', async () => {
      /* No write item left: no store call at all. */
      const { engine, store } = setup();
      await engine.getOrSetMany({}, ['a'], async () => new Map(), { cacheNull: false });
      expect(store.setManyCalls).toEqual([]);
      expect(store.calls.filter((c) => c.op === 'set')).toEqual([]);
    });

    it('a loader rejection reaches the caller and a joined single-key getOrSet', async () => {
      /* The batch loader for ['a', 'b'] fails; getOrSet('b') started meanwhile joined the
         batch's flight and gets the same error. Nothing is stored. */
      const { engine, store, emitted } = setup();
      const pending = deferred<Map<string, string>>();
      const batch = engine.getOrSetMany({}, ['a', 'b'], () => pending.promise);
      await vi.advanceTimersByTimeAsync(0);
      const single = vi.fn(async () => 'single');
      const joined = engine.getOrSet({ key: 'b' }, single);
      await vi.advanceTimersByTimeAsync(0);
      const boom = new Error('db down');
      pending.reject(boom);
      await expect(batch).rejects.toBe(boom);
      await expect(joined).rejects.toBe(boom);
      expect(single).not.toHaveBeenCalled();
      expect(store.data.size).toBe(0);
      expect(emitted.find((e) => e.event === 'load')?.payload).toMatchObject({
        success: false,
        keys: ['a', 'b'],
      });
      // The failed flights are gone: the next call loads again.
      expect(await engine.getOrSetMany({}, ['a'], async () => new Map([['a', 'A']]))).toEqual([
        'A',
      ]);
    });

    it('a loader returning a plain object rejects the caller with a TypeError', async () => {
      /* Not a Map: TypeError for the caller, a failed load event and nothing stored. */
      const { engine, store, emitted } = setup();
      const loader = async () => ({ a: 1 }) as unknown as ReadonlyMap<string, number>;
      await expect(engine.getOrSetMany({}, ['a'], loader)).rejects.toThrow(TypeError);
      expect(store.data.size).toBe(0);
      expect(emitted.find((e) => e.event === 'load')?.payload).toMatchObject({ success: false });
      const nullLoader = async () => null as unknown as ReadonlyMap<string, number>;
      await expect(engine.getOrSetMany({}, ['a'], nullLoader)).rejects.toThrow(TypeError);
    });

    it('a synchronous loader throw reaches the caller', async () => {
      /* The loader throws before returning a promise: the caller rejects with it. */
      const { engine } = setup();
      const boom = new Error('sync');
      await expect(
        engine.getOrSetMany({}, ['a'], () => {
          throw boom;
        }),
      ).rejects.toBe(boom);
    });

    it('ignores keys the loader returns that were not requested (Review Focus 3)', async () => {
      /* The loader for ['a'] also returns 'z' and 'b' ('b' was a hit): neither is cached
         nor returned. */
      const { engine, store } = setup();
      await engine.set({ key: 'b' }, 'cached');
      const loader = async (): Promise<Map<string, string>> =>
        new Map([
          ['a', 'A'],
          ['z', 'Z'],
          ['b', 'B'],
        ]);
      expect(await engine.getOrSetMany({}, ['a', 'b'], loader)).toEqual(['A', 'cached']);
      expect(store.setManyCalls[0]?.map((e) => e.key)).toEqual(['a']);
      expect(store.data.has('z')).toBe(false);
      expect(await engine.get({ key: 'b' })).toBe('cached');
    });

    it('overlapping concurrent batches share the common key (Review Focus 4)', async () => {
      /* ['a','b'] and ['b','c'] run together: the loaders get ['a','b'] and ['c'], 'b' is
         loaded once, and each caller gets its own order. */
      const { engine } = setup();
      const first = deferred<Map<string, string>>();
      const loader1 = vi.fn(() => first.promise);
      const loader2 = vi.fn(async (missing: string[]) => new Map(missing.map((k) => [k, `2${k}`])));
      const one = engine.getOrSetMany({}, ['a', 'b'], loader1);
      const two = engine.getOrSetMany({}, ['c', 'b'], loader2);
      await vi.advanceTimersByTimeAsync(0);
      first.resolve(
        new Map([
          ['a', '1a'],
          ['b', '1b'],
        ]),
      );
      expect(await one).toEqual(['1a', '1b']);
      expect(await two).toEqual(['2c', '1b']);
      expect(loader1).toHaveBeenCalledWith(['a', 'b']);
      expect(loader2).toHaveBeenCalledWith(['c']);
    });

    it('a concurrent single-key getOrSet joins the batch flight', async () => {
      /* getOrSet('b') arrives while the batch loads ['a','b']: the single loader never runs
         and both get the batch's value. */
      const { engine } = setup();
      const pending = deferred<Map<string, string>>();
      const batch = engine.getOrSetMany({}, ['a', 'b'], () => pending.promise);
      await vi.advanceTimersByTimeAsync(0);
      const single = vi.fn(async () => 'single');
      const joined = engine.getOrSet({ key: 'b' }, single);
      await vi.advanceTimersByTimeAsync(0);
      pending.resolve(
        new Map([
          ['a', 'A'],
          ['b', 'B'],
        ]),
      );
      expect(await batch).toEqual(['A', 'B']);
      expect(await joined).toBe('B');
      expect(single).not.toHaveBeenCalled();
    });

    it('a batch joins an in-flight single-key getOrSet', async () => {
      /* getOrSet('a') is loading; the batch for ['a','b'] loads only ['b'] and waits for a. */
      const { engine } = setup();
      const pending = deferred<string>();
      const single = engine.getOrSet({ key: 'a' }, () => pending.promise);
      await vi.advanceTimersByTimeAsync(0);
      const loader = vi.fn(async (missing: string[]) => new Map(missing.map((k) => [k, k])));
      const batch = engine.getOrSetMany({}, ['a', 'b'], loader);
      await vi.advanceTimersByTimeAsync(0);
      expect(loader).toHaveBeenCalledWith(['b']);
      pending.resolve('single-a');
      expect(await single).toBe('single-a');
      expect(await batch).toEqual(['single-a', 'b']);
    });

    it('a joined refresh that a held lock skipped is loaded by the batch itself', async () => {
      /* A locked swr refresh of 'a' finds the lock held and settles without a value. A fixed
         batch reading the stale 'a' as a miss joined that flight; it then loads 'a' with
         its own loader call. */
      const lock = new FakeLock();
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const slowLock: LockProvider = {
        acquire: async (key, ttlMs) => {
          await gate;
          return lock.acquire(key, ttlMs);
        },
      };
      const store = Object.assign(new BatchStore(), { lock: slowLock }) as BatchStore & CacheStore;
      const { engine } = makeEngine({ stores: { default: store } });
      await engine.set({ key: 'a' }, 'old', SWR);
      vi.setSystemTime(150);
      lock.held.add('__lock__:a');
      const refreshLoader = vi.fn(async () => 'refreshed');
      expect(await engine.getOrSet({ key: 'a' }, refreshLoader, { ...SWR, lock: true })).toBe(
        'old',
      );
      const loader = vi.fn(async (missing: string[]) => new Map(missing.map((k) => [k, `L${k}`])));
      const batch = engine.getOrSetMany({}, ['a', 'b'], loader);
      await vi.advanceTimersByTimeAsync(0);
      expect(loader).toHaveBeenCalledWith(['b']);
      release();
      expect(await batch).toEqual(['La', 'Lb']);
      expect(refreshLoader).not.toHaveBeenCalled();
      expect(loader).toHaveBeenCalledTimes(2);
      expect(loader).toHaveBeenLastCalledWith(['a']);
    });

    it('serves stale swr entries at once and refreshes them with one loader call', async () => {
      /* Two stale entries and one miss: the stale values are returned, the miss is loaded,
         and the stale keys are refreshed together in the background. */
      const { engine, emitted } = setup();
      await engine.set({ key: 'a' }, 'oldA', SWR);
      await engine.set({ key: 'b' }, 'oldB', SWR);
      vi.setSystemTime(150);
      emitted.length = 0;
      const refresh = deferred<undefined>();
      const loader = vi.fn(async (missing: string[]) => {
        if (missing.includes('a')) await refresh.promise;
        return new Map(missing.map((k) => [k, `new${k}`]));
      });
      expect(await engine.getOrSetMany({}, ['a', 'c', 'b'], loader, SWR)).toEqual([
        'oldA',
        'newc',
        'oldB',
      ]);
      expect(loader).toHaveBeenCalledTimes(2);
      expect(loader).toHaveBeenCalledWith(['c']);
      expect(loader).toHaveBeenCalledWith(['a', 'b']);
      expect(
        emitted.slice(0, 3).map((e) => [e.event, (e.payload as { stale?: boolean }).stale]),
      ).toEqual([
        ['hit', true],
        ['miss', undefined],
        ['hit', true],
      ]);
      refresh.resolve(undefined);
      await vi.runAllTimersAsync();
      expect(await engine.getMany({}, ['a', 'b'], SWR)).toEqual(['newa', 'newb']);
    });

    it('a stale key already refreshing is not refreshed again', async () => {
      /* A second batch over the same stale keys while the refresh runs starts no new one. */
      const { engine } = setup();
      await engine.set({ key: 'a' }, 'old', SWR);
      vi.setSystemTime(150);
      const refresh = deferred<Map<string, string>>();
      const loader = vi.fn(() => refresh.promise);
      expect(await engine.getOrSetMany({}, ['a'], loader, SWR)).toEqual(['old']);
      expect(await engine.getOrSetMany({}, ['a'], loader, SWR)).toEqual(['old']);
      expect(loader).toHaveBeenCalledOnce();
      refresh.resolve(new Map([['a', 'new']]));
      await vi.runAllTimersAsync();
      expect(await engine.get({ key: 'a' }, SWR)).toBe('new');
    });

    it('getOrSetMany: keys refreshed in time get new values, the rest stale', async () => {
      /* softTimeout 100: 'b' is already being refreshed by a slow single-key call (500 ms) and
         is joined; 'a' is refreshed by the batch loader in 20 ms; 'c' is a miss. One shared
         window: 'a' gets its new value, 'b' its stale one, and the call returns at 100 ms. */
      const { engine } = setup();
      await engine.set({ key: 'a' }, 'oldA', SWR);
      await engine.set({ key: 'b' }, 'oldB', SWR);
      vi.setSystemTime(150);
      const slow = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            setTimeout(() => {
              resolve('slowB');
            }, 500);
          }),
      );
      expect(await engine.getOrSet({ key: 'b' }, slow, SWR)).toBe('oldB');
      const loader = vi.fn(async (missing: string[]) => {
        if (missing.includes('a')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return new Map(missing.map((k) => [k, `new${k}`]));
      });
      let settled: (string | undefined)[] | undefined;
      void engine
        .getOrSetMany({}, ['a', 'b', 'c'], loader, { ...SWR, softTimeout: 100 })
        .then((values) => {
          settled = values;
        });
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toEqual(['newa', 'oldB', 'newc']);
      expect(loader).toHaveBeenCalledTimes(2);
      expect(loader).toHaveBeenCalledWith(['c']);
      expect(loader).toHaveBeenCalledWith(['a']);
      expect(slow).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(400);
      expect(vi.getTimerCount()).toBe(0);
      expect(await engine.getMany({}, ['a', 'b'], SWR)).toEqual(['newa', 'slowB']);
    });

    it('getOrSetMany with softTimeout returns as soon as every stale key is refreshed', async () => {
      /* All stale keys refresh in 30 ms: the call returns then with the new values, and no
         timer is left; a failed refresh gives the stale values. */
      const { engine, emitted } = setup();
      await engine.set({ key: 'a' }, 'oldA', SWR);
      await engine.set({ key: 'b' }, 'oldB', SWR);
      vi.setSystemTime(150);
      const loader = vi.fn(async (missing: string[]) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Map(missing.map((k) => [k, `new${k}`]));
      });
      const soft = { ...SWR, softTimeout: 100 };
      let settled: (string | undefined)[] | undefined;
      void engine.getOrSetMany({}, ['a', 'b'], loader, soft).then((values) => {
        settled = values;
      });
      await vi.advanceTimersByTimeAsync(30);
      expect(settled).toEqual(['newa', 'newb']);
      expect(vi.getTimerCount()).toBe(0);
      vi.setSystemTime(400);
      emitted.length = 0;
      const boom = new Error('refresh failed');
      expect(await engine.getOrSetMany({}, ['a', 'b'], () => Promise.reject(boom), soft)).toEqual([
        'newa',
        'newb',
      ]);
      expect(vi.getTimerCount()).toBe(0);
      expect(emitted.filter((e) => e.event === 'error')).toHaveLength(1);
    });

    it('getOrSetMany with softTimeout: a key the refresh did not write keeps its stale value (F-2)', async () => {
      /* softTimeout 50: the loader returns 'b' and omits 'a' within the window. 'a' was not
         written, so it gets its stale value (the store still holds it); 'b' gets the new one. */
      const { engine } = setup();
      await engine.set({ key: 'a' }, 'oldA', SWR);
      await engine.set({ key: 'b' }, 'oldB', SWR);
      vi.setSystemTime(150);
      const loader = vi.fn(async () => new Map([['b', 'newb']]));
      expect(
        await engine.getOrSetMany({}, ['a', 'b'], loader, { ...SWR, softTimeout: 50 }),
      ).toEqual(['oldA', 'newb']);
      expect(loader).toHaveBeenCalledOnce();
      expect(await engine.getMany({}, ['a', 'b'], SWR)).toEqual(['oldA', 'newb']);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('getOrSetMany with softTimeout and cacheNull: a written empty value is returned (F-2)', async () => {
      /* With cacheNull the refreshed null for 'a' and the omitted 'b' are written, so the
         caller gets them instead of the stale values. */
      const { engine } = setup();
      await engine.set({ key: 'a' }, 'oldA', SWR);
      await engine.set({ key: 'b' }, 'oldB', SWR);
      vi.setSystemTime(150);
      const loader = vi.fn(async () => new Map<string, string | null>([['a', null]]));
      const soft = { ...SWR, softTimeout: 50, cacheNull: true };
      expect(await engine.getOrSetMany({}, ['a', 'b'], loader, soft)).toEqual([null, undefined]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a failed refresh only emits error{operation: refresh}', async () => {
      /* The background loader rejects: the caller already has the stale value, one refresh
         error is reported and the stale entry stays. */
      const { engine, emitted } = setup();
      await engine.set({ key: 'a' }, 'old', SWR);
      await engine.set({ key: 'b' }, 'old', SWR);
      vi.setSystemTime(150);
      emitted.length = 0;
      const boom = new Error('refresh failed');
      expect(await engine.getOrSetMany({}, ['a', 'b'], () => Promise.reject(boom), SWR)).toEqual([
        'old',
        'old',
      ]);
      await vi.runAllTimersAsync();
      const errors = emitted.filter((e) => e.event === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.payload).toEqual({ store: 'default', operation: 'refresh', error: boom });
      expect(await engine.get({ key: 'a' }, SWR)).toBe('old');
    });

    it('a version failure loads every key and writes nothing', async () => {
      /* The version cannot be read: the loader gets every unique non-empty key, the result
         is returned, and nothing is written. */
      const { engine, store, emitted } = setup({ namespaces: { users: { versioned: true } } });
      store.failNext('get');
      const loader = vi.fn(async (missing: string[]) => new Map(missing.map((k) => [k, `v${k}`])));
      expect(
        await engine.getOrSetMany({ namespace: 'users' }, ['1', '', '2', '1'], loader),
      ).toEqual(['v1', undefined, 'v2', 'v1']);
      expect(loader).toHaveBeenCalledWith(['1', '2']);
      expect(store.setManyCalls).toEqual([]);
      expect(store.getManyCalls).toEqual([]);
      expect(events(emitted).filter((e) => e === 'miss' || e === 'set')).toEqual([]);
      const bad = async () => ({}) as ReadonlyMap<string, string>;
      store.failNext('get');
      await expect(engine.getOrSetMany({ namespace: 'users' }, ['1'], bad)).rejects.toThrow(
        TypeError,
      );
    });

    it('an empty list or only empty keys never call the loader', async () => {
      /* [] resolves []; [''] resolves [undefined] with one key error. */
      const { engine, store, emitted } = setup();
      const loader = vi.fn(async () => new Map<string, number>());
      expect(await engine.getOrSetMany({}, [], loader)).toEqual([]);
      expect(await engine.getOrSetMany({}, ['', ''], loader)).toEqual([undefined, undefined]);
      expect(loader).not.toHaveBeenCalled();
      expect(store.calls).toEqual([]);
      expect(events(emitted)).toEqual(['error']);
    });

    it('lock: true rejects; defaults.lock.enabled is ignored', async () => {
      /* A per-call lock is a configuration error; the module default does not lock batches. */
      const lock = new FakeLock();
      const store = Object.assign(new BatchStore(), { lock });
      const { engine } = makeEngine({
        stores: { default: store },
        defaults: { lock: { enabled: true } },
      });
      const loader = async (missing: string[]) => new Map(missing.map((k) => [k, k]));
      await expect(engine.getOrSetMany({}, ['a'], loader, { lock: true })).rejects.toThrow(
        new CacheConfigError('Invalid lock: true. getOrSetMany does not support lock.'),
      );
      expect(await engine.getOrSetMany({}, ['a'], loader)).toEqual(['a']);
      expect(await engine.getOrSetMany({}, ['b'], loader, { lock: false })).toEqual(['b']);
      expect(lock.acquireCalls).toEqual([]);
    });

    it('validates store, namespace, options, then keys', async () => {
      /* Each check rejects with CacheConfigError, in the documented order. */
      const { engine } = setup();
      const bad = 'k' as unknown as string[];
      const loader = async () => new Map<string, number>();
      await expect(engine.getOrSetMany({ store: 'nope' }, bad, loader)).rejects.toThrow(
        /Unknown cache store/,
      );
      await expect(
        engine.getOrSetMany({ namespace: '__x' }, bad, loader, { lock: true }),
      ).rejects.toThrow(/reserved/);
      await expect(engine.getOrSetMany({}, bad, loader, { lock: true })).rejects.toThrow(
        /Invalid lock/,
      );
      await expect(engine.getOrSetMany({}, bad, loader, { nullTtl: 0 })).rejects.toThrow(
        /Invalid nullTtl/,
      );
      await expect(
        engine.getOrSetMany({}, bad, loader, { strategy: 'swr' } as {
          strategy: 'swr';
          staleTtl: number;
        }),
      ).rejects.toThrow(/requires staleTtl/);
      await expect(engine.getOrSetMany({}, bad, loader)).rejects.toThrow(
        new CacheConfigError('Invalid keys: k. It must be an array of strings.'),
      );
    });

    it('sliding reads each key with getAndTouch', async () => {
      /* The batch read path is the getMany one: per-key getAndTouch under sliding. */
      const { engine, store } = setup();
      const sliding = { strategy: 'sliding' } as const;
      await engine.set({ key: 'a' }, 1, sliding);
      const loader = async (missing: string[]) => new Map(missing.map((k) => [k, 2]));
      expect(await engine.getOrSetMany({}, ['a', 'b'], loader, sliding)).toEqual([1, 2]);
      expect(store.getAndTouchCalls).toEqual(['a', 'b']);
      expect(store.getManyCalls).toEqual([]);
    });
  });
});
