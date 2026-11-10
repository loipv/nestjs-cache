import { describe, expect, it } from 'vitest';
import { CacheService } from '../../../src/core/cache.service.js';
import { CacheConfigError } from '../../../src/errors.js';
import { makeEngine } from '../helpers/engine.js';

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
});
