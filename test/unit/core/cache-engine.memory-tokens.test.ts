import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { CacheEvents } from '../../../src/core/events.js';
import { resolveOptions } from '../../../src/module/cache.options.js';
import { memoryStore } from '../../../src/stores/memory.store.js';
import { tieredStore } from '../../../src/stores/tiered.store.js';

function engineOver(store: ReturnType<typeof memoryStore>, prefix?: string): CacheEngine {
  return new CacheEngine(
    resolveOptions({
      ...(prefix === undefined ? {} : { prefix }),
      namespaces: { users: { versioned: true } },
      logging: { level: 'off' },
      stores: { default: store },
    }),
    new CacheEvents(),
  );
}

describe('CacheEngine over memoryStore: version tokens survive data eviction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([['app'], [undefined]])(
    'a versioned namespace keeps its entries when data fills the store (prefix %s)',
    async (prefix) => {
      const engine = engineOver(memoryStore({ maxEntries: 10 }), prefix);
      for (let i = 0; i < 5; i++) await engine.set({ namespace: 'users', key: `u${String(i)}` }, i);
      // 10 data entries fill the store; with the token among them, its LRU head was the token.
      for (let i = 0; i < 5; i++) await engine.set({ key: `other${String(i)}` }, i);
      vi.advanceTimersByTime(2_000); // past versioning.cacheTtl: the token is read from the store
      const hits: unknown[] = [];
      for (let i = 0; i < 5; i++)
        hits.push(await engine.get({ namespace: 'users', key: `u${String(i)}` }));
      expect(hits).toEqual([0, 1, 2, 3, 4]);
    },
  );

  it('one distinct tag per entry keeps every entry that fits', async () => {
    const engine = engineOver(memoryStore({ maxEntries: 10 }), 'app');
    for (let i = 0; i < 10; i++) {
      await engine.set({ key: `t${String(i)}` }, i, { tags: [`tag${String(i)}`] });
    }
    vi.advanceTimersByTime(2_000);
    const hits: unknown[] = [];
    for (let i = 0; i < 10; i++) hits.push(await engine.get({ key: `t${String(i)}` }));
    expect(hits).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('only stores the engine is configured with are told; a tiered L1 is left alone', () => {
    const l1 = memoryStore();
    const spy = vi.spyOn(l1, 'reserveKeyPrefixes');
    const direct = memoryStore();
    const directSpy = vi.spyOn(direct, 'reserveKeyPrefixes');
    new CacheEngine(
      resolveOptions({
        prefix: 'app',
        logging: { level: 'off' },
        stores: { default: direct, tiered: tieredStore({ l1, l2: memoryStore() }) },
      }),
      new CacheEvents(),
    );
    expect(directSpy).toHaveBeenCalledWith(['app:__version__:', 'app:__tag__:']);
    expect(spy).not.toHaveBeenCalled();
  });
});
