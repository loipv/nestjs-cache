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
      expect(loader).not.toHaveBeenCalled();
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
});
