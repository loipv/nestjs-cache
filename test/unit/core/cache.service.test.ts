import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../../../src/core/cache.service.js';
import { CacheConfigError } from '../../../src/errors.js';
import { makeEngine } from '../helpers/engine.js';
import { FakeStore } from '../helpers/fake-store.js';

describe('CacheService', () => {
  function setup() {
    const { engine, store } = makeEngine();
    return { service: new CacheService(engine), store };
  }

  it('get/set/delete/clear/getOrSet delegate with namespace and store', async () => {
    const { service, store } = setup();
    await service.set('k', 1, { namespace: 'n', ttl: 5 });
    expect(store.data.get('n:k')?.ttlMs).toBe(5);
    expect(await service.get('k', { namespace: 'n' })).toBe(1);

    await service.set('j', 2, { namespace: 'n' });
    await service.delete(['k', 'j'], { namespace: 'n' });
    expect(store.calls.filter((c) => c.op === 'delete').at(-1)?.args).toEqual([['n:k', 'n:j']]);
    expect(store.data.size).toBe(0);

    await service.set('s', 3);
    await service.delete('s');
    expect(store.calls.filter((c) => c.op === 'delete').at(-1)?.args).toEqual([['s']]);

    await service.set('x', 1, { namespace: 'n' });
    await service.clear('n');
    expect(store.calls.filter((c) => c.op === 'clear').at(-1)?.args).toEqual(['n:']);
    expect(store.data.size).toBe(0);

    const value = await service.getOrSet('k', () => Promise.resolve('v'), {
      ttl: 9,
      cacheNull: true,
    });
    expect(value).toBe('v');
    expect(store.data.get('k')?.ttlMs).toBe(9);
  });

  it('rejects an unknown store with CacheConfigError', async () => {
    const { service } = setup();
    await expect(service.get('k', { store: 'nope' })).rejects.toThrow(CacheConfigError);
    await expect(service.clear('n', { store: 'nope' })).rejects.toThrow(CacheConfigError);
  });

  it('rejects an empty namespace for clear, with or without a prefix (F5)', async () => {
    for (const options of [{}, { prefix: 'app' }]) {
      const { engine, store, emitted } = makeEngine(options);
      const service = new CacheService(engine);
      await expect(service.clear('')).rejects.toThrow(CacheConfigError);
      await expect(engine.clear('')).rejects.toThrow(CacheConfigError);
      expect(store.calls.filter((c) => c.op === 'clear')).toEqual([]);
      expect(emitted).toEqual([]);
    }
  });

  describe('an empty key', () => {
    /* fullKey(prefix, namespace, '') collapses to `prefix:namespace`: it would collide with a
       namespace-less key and escape clear(namespace), so '' is a key error, as in decorators */
    const keyErrors = (emitted: { event: string; payload: unknown }[]): unknown[] =>
      emitted.filter((e) => e.event === 'error').map((e) => e.payload);
    const keyError = {
      store: 'default',
      operation: 'key',
      error: new TypeError('Cache key must not be empty'),
    };

    it.each([{}, { prefix: 'app' }])(
      'get is a miss without a store call or a miss event (%j)',
      async (options) => {
        const { engine, store, emitted } = makeEngine(options);
        const service = new CacheService(engine);
        await store.set(options.prefix === undefined ? 'n' : 'app:n', 'x', 1_000);
        store.calls.length = 0;
        expect(await service.get('', { namespace: 'n' })).toBeUndefined();
        expect(await service.get('')).toBeUndefined();
        expect(store.calls).toEqual([]);
        expect(emitted).toEqual([
          { event: 'error', payload: keyError },
          { event: 'error', payload: keyError },
        ]);
      },
    );

    it('getOrSet runs the loader each time and stores nothing', async () => {
      const { engine, store, emitted } = makeEngine();
      const service = new CacheService(engine);
      const loader = vi.fn(() => Promise.resolve('v'));
      expect(await service.getOrSet('', loader, { namespace: 'n' })).toBe('v');
      expect(await service.getOrSet('', loader, { namespace: 'n', lock: true })).toBe('v');
      expect(loader).toHaveBeenCalledTimes(2);
      expect(store.calls).toEqual([]);
      expect(keyErrors(emitted)).toEqual([keyError, keyError]);
      expect(emitted.filter((e) => e.event !== 'error')).toEqual([]);
    });

    it('getOrSet still lets a loader rejection reach the caller', async () => {
      const { engine } = makeEngine();
      const service = new CacheService(engine);
      await expect(service.getOrSet('', () => Promise.reject(new Error('db')))).rejects.toThrow(
        'db',
      );
    });

    it('set, put and a lone delete are no-ops', async () => {
      const { engine, store, emitted } = makeEngine();
      const service = new CacheService(engine);
      await service.set('', 1, { namespace: 'n' });
      await service.delete('', { namespace: 'n' });
      await service.delete(['', ''], { namespace: 'n' });
      await engine.put({ namespace: 'n', key: '' }, 1);
      expect(store.calls).toEqual([]);
      expect(keyErrors(emitted)).toEqual([keyError, keyError, keyError, keyError]);
      expect(emitted.filter((e) => e.event !== 'error')).toEqual([]);
    });

    it('delete of a list drops only the empty keys and reports them once', async () => {
      /* the valid keys must still be evicted, or they would stay stale until their TTL */
      const { engine, store, emitted } = makeEngine();
      const service = new CacheService(engine);
      await service.set('a', 1, { namespace: 'n' });
      await service.set('b', 2, { namespace: 'n' });
      store.calls.length = 0;
      emitted.length = 0;
      await service.delete(['a', '', 'b', ''], { namespace: 'n' });
      expect(store.calls).toEqual([{ op: 'delete', args: [['n:a', 'n:b']] }]);
      expect(store.data.size).toBe(0);
      expect(emitted).toEqual([
        { event: 'error', payload: keyError },
        { event: 'delete', payload: { store: 'default', namespace: 'n', keys: ['a', 'b'] } },
      ]);
    });

    it('invalid options and unknown stores are still rejected first', async () => {
      const { engine } = makeEngine();
      const service = new CacheService(engine);
      await expect(service.get('', { store: 'nope' })).rejects.toThrow(CacheConfigError);
      await expect(service.set('', 1, { ttl: 0 })).rejects.toThrow(CacheConfigError);
      await expect(service.getOrSet('', () => Promise.resolve(1), { ttl: -1 })).rejects.toThrow(
        CacheConfigError,
      );
      await expect(service.delete('', { store: 'nope' })).rejects.toThrow(CacheConfigError);
    });
  });

  describe('strategy options', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('CacheService passes strategy options through get, set and getOrSet', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const { engine, store, emitted } = makeEngine();
      const service = new CacheService(engine);
      await service.set('k', 'v', { ttl: 100, strategy: 'swr', staleTtl: 300 });
      expect(store.data.get('k')?.ttlMs).toBe(400);
      expect(JSON.parse(store.data.get('k')!.value)).toMatchObject({
        staleAt: 100,
        expiresAt: 400,
      });

      vi.setSystemTime(150);
      expect(await service.get('k')).toBe('v');
      expect(emitted.at(-1)?.payload).toMatchObject({ key: 'k', stale: true });

      const loader = vi.fn(async () => 'new');
      const swr = { ttl: 100, strategy: 'swr', staleTtl: 300 } as const;
      expect(await service.getOrSet('k', loader, swr)).toBe('v');
      // The stale entry is refreshed in the background, so the next read is fresh.
      await vi.runAllTimersAsync();
      expect(loader).toHaveBeenCalledTimes(1);
      expect(await service.getOrSet('k', loader)).toBe('new');
      expect(loader).toHaveBeenCalledTimes(1);

      await service.set('s', 'x', { ttl: 1_000, strategy: 'sliding', maxTtl: 2_000 });
      vi.setSystemTime(2_150);
      expect(await service.get('s', { strategy: 'sliding', maxTtl: 2_000 })).toBeUndefined();
      expect(
        await service.getOrSet('s', loader, { ttl: 1_000, strategy: 'sliding', maxTtl: 2_000 }),
      ).toBe('new');
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('get with sliding touches through getAndTouch with defaults.ttl', async () => {
      const store = Object.assign(new FakeStore(), { getAndTouch: vi.fn(async () => undefined) });
      const { engine } = makeEngine({ stores: { default: store }, defaults: { ttl: 7_000 } });
      const service = new CacheService(engine);
      expect(await service.get('k', { namespace: 'n', strategy: 'sliding' })).toBeUndefined();
      expect(store.getAndTouch).toHaveBeenCalledWith('n:k', 7_000);
    });

    it('forwards only the defined options to the engine', async () => {
      const { engine } = makeEngine();
      const service = new CacheService(engine);
      const get = vi.spyOn(engine, 'get');
      const set = vi.spyOn(engine, 'set');
      const getOrSet = vi.spyOn(engine, 'getOrSet');
      const loader = async (): Promise<number> => 1;

      await service.get('a');
      await service.get('a', { store: 'default', strategy: 'sliding', maxTtl: 90_000 });
      expect(get.mock.calls).toStrictEqual([
        [{ key: 'a' }, {}],
        [
          { key: 'a', store: 'default' },
          { strategy: 'sliding', maxTtl: 90_000 },
        ],
      ]);

      await service.set('a', 1);
      await service.set('a', 1, { namespace: 'n', ttl: 5, strategy: 'swr', staleTtl: 10 });
      expect(set.mock.calls).toStrictEqual([
        [{ key: 'a' }, 1, {}],
        [{ key: 'a', namespace: 'n' }, 1, { ttl: 5, strategy: 'swr', staleTtl: 10 }],
      ]);

      await service.getOrSet('b', loader);
      await service.getOrSet('c', loader, {
        ttl: 70_000,
        strategy: 'sliding',
        maxTtl: 80_000,
        cacheNull: false,
        nullTtl: 3,
        lock: true,
      });
      expect(getOrSet.mock.calls.map((c) => c[2])).toStrictEqual([
        {},
        {
          ttl: 70_000,
          strategy: 'sliding',
          maxTtl: 80_000,
          cacheNull: false,
          nullTtl: 3,
          lock: true,
        },
      ]);
    });

    it('rejects a maxTtl below the effective ttl', async () => {
      const { engine, store } = makeEngine();
      const service = new CacheService(engine);
      await expect(
        service.getOrSet('k', async () => 1, { strategy: 'sliding', maxTtl: 1 }),
      ).rejects.toThrow('Invalid maxTtl: 1. It must be >= ttl (60000).');
      await expect(
        service.set('k', 1, { ttl: 10, strategy: 'sliding', maxTtl: 9 }),
      ).rejects.toThrow(CacheConfigError);
      expect(store.calls).toEqual([]);
    });
  });

  describe('reserved namespaces', () => {
    const reserved = new CacheConfigError(
      'Invalid namespace: __x. Names starting with "__" are reserved.',
    );

    it('rejects get, getOrSet, set, delete and clear on a namespace starting with __', async () => {
      /* every public entry that takes a namespace throws before touching the store */
      const { service, store } = setup();
      await expect(service.get('k', { namespace: '__x' })).rejects.toThrow(reserved);
      await expect(
        service.getOrSet('k', () => Promise.resolve(1), { namespace: '__x' }),
      ).rejects.toThrow(reserved);
      await expect(service.set('k', 1, { namespace: '__x' })).rejects.toThrow(reserved);
      await expect(service.delete('k', { namespace: '__x' })).rejects.toThrow(reserved);
      await expect(service.clear('__x')).rejects.toThrow(reserved);
      expect(store.calls).toEqual([]);
    });

    it('accepts a namespace with a single underscore and keeps the empty clear message', async () => {
      /* '_x' works; clear('') still reports the empty namespace first */
      const { service, store } = setup();
      await service.set('k', 1, { namespace: '_x' });
      expect(store.data.has('_x:k')).toBe(true);
      await expect(service.clear('')).rejects.toThrow('clear requires a non-empty namespace');
    });

    it('rejects put on a namespace starting with __', async () => {
      /* put is engine-only (the @CachePut path) */
      const { engine } = makeEngine();
      await expect(engine.put({ namespace: '__x', key: 'k' }, 1)).rejects.toThrow(reserved);
    });
  });
  describe('batch methods', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('getMany/setMany/getOrSetMany pass namespace, store, ttl and strategy through', async () => {
      /* setMany writes to the named store and namespace with the ttl; getMany reads them back
         in input order; getOrSetMany forwards ttl, strategy and the null/unless options, and
         its stale swr entry is refreshed in the background. */
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const other = new FakeStore();
      const { engine, store } = makeEngine({ stores: { default: new FakeStore(), other } });
      const service = new CacheService(engine);
      await service.setMany(
        [
          ['a', 1],
          ['b', 2],
        ],
        { namespace: 'n', store: 'other', ttl: 500 },
      );
      expect(other.data.get('n:a')?.ttlMs).toBe(500);
      expect(other.data.get('n:b')?.ttlMs).toBe(500);
      expect(store.data.size).toBe(0);
      expect(await service.getMany(['b', 'a', 'c'], { namespace: 'n', store: 'other' })).toEqual([
        2,
        1,
        undefined,
      ]);

      const swr = { ttl: 100, strategy: 'swr', staleTtl: 300 } as const;
      await service.setMany([['s', 'x']], swr);
      expect(store.data.get('s')?.ttlMs).toBe(400);
      vi.setSystemTime(150);
      expect(await service.getMany(['s'])).toEqual(['x']);
      const loader = vi.fn(async (missing: string[]) => new Map(missing.map((k) => [k, `L${k}`])));
      expect(
        await service.getOrSetMany(['s', 't', 'u'], loader, {
          ...swr,
          cacheNull: true,
          nullTtl: 9,
          unless: (v) => v === 'Lu',
        }),
      ).toEqual(['x', 'Lt', 'Lu']);
      expect(loader).toHaveBeenNthCalledWith(1, ['t', 'u']);
      expect(store.data.get('t')?.ttlMs).toBe(400);
      expect(store.data.has('u')).toBe(false);
      await vi.runAllTimersAsync();
      expect(loader).toHaveBeenLastCalledWith(['s']);
      expect(await service.getMany(['s'], swr)).toEqual(['Ls']);

      const nulls = vi.fn(async () => new Map<string, string>());
      await service.getOrSetMany(['z'], nulls, { cacheNull: true, nullTtl: 9 });
      expect(store.data.get('z')?.ttlMs).toBe(9);
      await expect(service.getOrSetMany(['a'], loader, { lock: true })).rejects.toThrow(
        CacheConfigError,
      );
      expect(await service.getMany([])).toEqual([]);
      expect(await service.getOrSetMany([], loader)).toEqual([]);
    });
  });

  describe('tags', () => {
    function stampOf(store: FakeStore, key: string): unknown {
      const raw = store.data.get(key)?.value;
      return raw === undefined ? undefined : (JSON.parse(raw) as { tags?: unknown }).tags;
    }

    it('set, getOrSet, setMany and getOrSetMany forward tags to the engine', async () => {
      /* Each write method passes its `tags` (an array, or a function of the value, plus the key
         on batch methods) through; the stored envelopes carry the tag tokens. */
      const { engine, store } = makeEngine();
      const service = new CacheService(engine);
      const target = { name: 'default', store };
      const token = (tag: string) => engine.tokens.cached(target, 'tag', tag);
      const set = vi.spyOn(engine, 'set');
      const getOrSet = vi.spyOn(engine, 'getOrSet');
      const setMany = vi.spyOn(engine, 'setMany');
      const getOrSetMany = vi.spyOn(engine, 'getOrSetMany');

      await service.set('a', { id: 1 }, { tags: ['s'] });
      const valueTags = vi.fn((value: { id: number }) => [`u:${String(value.id)}`]);
      await service.getOrSet('b', async () => ({ id: 2 }), { tags: valueTags });
      const keyTags = vi.fn((value: number, key: string) => [`k:${key}`, `v:${String(value)}`]);
      await service.setMany([['c', 3]], { tags: keyTags });
      const loader = async (missing: string[]) => new Map(missing.map((k) => [k, 4]));
      await service.getOrSetMany(['d'], loader, { tags: keyTags, ttl: 50 });

      expect(set.mock.calls[0]?.[2]).toStrictEqual({ tags: ['s'] });
      expect(getOrSet.mock.calls[0]?.[2]).toStrictEqual({ tags: valueTags });
      expect(setMany.mock.calls[0]?.[2]).toStrictEqual({ tags: keyTags });
      expect(getOrSetMany.mock.calls[0]?.[3]).toStrictEqual({ tags: keyTags, ttl: 50 });
      expect(valueTags).toHaveBeenCalledExactlyOnceWith({ id: 2 });
      expect(keyTags.mock.calls).toEqual([
        [3, 'c'],
        [4, 'd'],
      ]);
      expect(stampOf(store, 'a')).toEqual({ s: token('s') });
      expect(stampOf(store, 'b')).toEqual({ 'u:2': token('u:2') });
      expect(stampOf(store, 'c')).toEqual({ 'k:c': token('k:c'), 'v:3': token('v:3') });
      expect(stampOf(store, 'd')).toEqual({ 'k:d': token('k:d'), 'v:4': token('v:4') });
    });
  });
});

describe('CacheService.invalidateTags', () => {
  it("CacheService.invalidateTags rejects CacheConfigError for [], [''], non-arrays, 33 tags or an unknown store", async () => {
    /* Spec 4: invalid arguments are a programming error, rejected at once with
       CacheConfigError; nothing is read, written or emitted. */
    const { engine, store, emitted } = makeEngine();
    const service = new CacheService(engine);
    const invalid: unknown[] = [
      [],
      [''],
      ['ok', ''],
      'tag',
      undefined,
      null,
      [1],
      Array.from({ length: 33 }, (_, i) => `t${String(i)}`),
    ];
    for (const tags of invalid) {
      await expect(service.invalidateTags(tags as readonly string[])).rejects.toThrow(
        CacheConfigError,
      );
    }
    await expect(service.invalidateTags(['t'], { store: 'nope' })).rejects.toThrow(
      CacheConfigError,
    );
    expect(store.calls).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('invalidateTags bumps the tags in the chosen store, duplicates once', async () => {
    /* The service forwards the tags and the store; 32 tags with duplicates are accepted and
       each tag key is written once. */
    const other = new FakeStore();
    const { engine, store } = makeEngine({ stores: { default: new FakeStore(), other } });
    const service = new CacheService(engine);
    const invalidate = vi.spyOn(engine, 'invalidateTags');
    const tags = Array.from({ length: 32 }, (_, i) => `t${String(i)}`);
    await service.invalidateTags([...tags, ...tags], { store: 'other' });
    await service.invalidateTags(['x']);
    expect(invalidate.mock.calls).toEqual([
      [[...tags, ...tags], 'other'],
      [['x'], undefined],
    ]);
    expect(other.calls.filter((c) => c.op === 'set')).toHaveLength(32);
    expect(other.data.has('__tag__:t31')).toBe(true);
    expect([...store.data.keys()]).toEqual(['__tag__:x']);
  });

  it('invalidateTags tolerates null or undefined options and never throws synchronously', async () => {
    /* 0.7-T5: options null or undefined mean the default store; invalid arguments, even with
       null options, are a rejected promise, never a synchronous throw. */
    const { engine, store } = makeEngine();
    const service = new CacheService(engine);
    await expect(service.invalidateTags(['x'], null as never)).resolves.toBeUndefined();
    await expect(service.invalidateTags(['y'], undefined)).resolves.toBeUndefined();
    expect([...store.data.keys()].sort()).toEqual(['__tag__:x', '__tag__:y']);
    await expect(service.invalidateTags([], null as never)).rejects.toThrow(CacheConfigError);
    await expect(service.invalidateTags(null as never, null as never)).rejects.toThrow(
      CacheConfigError,
    );
  });

  it('rejects with the first token write error', async () => {
    /* Spec 3.4: a failed token write rejects the service call (unlike other cache failures). */
    const { engine, store } = makeEngine();
    const service = new CacheService(engine);
    store.failNext('set', new Error('down'));
    await expect(service.invalidateTags(['a', 'b'])).rejects.toThrow('down');
    expect(store.data.has('__tag__:b')).toBe(true);
  });
});
