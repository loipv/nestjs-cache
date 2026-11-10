import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import { memoryStore } from '../../../src/stores/memory.store.js';

describe('MemoryStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns what was set until the TTL passes', async () => {
    const s = memoryStore();
    await s.set('a', 'v', 1_000);
    expect(await s.get('a')).toBe('v');
    vi.advanceTimersByTime(999);
    expect(await s.get('a')).toBe('v');
    vi.advanceTimersByTime(1);
    expect(await s.get('a')).toBeUndefined();
  });
  it('returns undefined for unknown keys', async () => {
    expect(await memoryStore().get('x')).toBeUndefined();
  });
  it('overwrites value and TTL on a second set', async () => {
    const s = memoryStore();
    await s.set('a', 'old', 100);
    await s.set('a', 'new', 1_000);
    vi.advanceTimersByTime(500);
    expect(await s.get('a')).toBe('new');
  });
  it('evicts the least recently used entry at capacity', async () => {
    const s = memoryStore({ maxEntries: 2 });
    await s.set('a', '1', 1e6);
    await s.set('b', '2', 1e6);
    await s.get('a');
    await s.set('c', '3', 1e6);
    expect(await s.get('b')).toBeUndefined();
    expect(await s.get('a')).toBe('1');
    expect(await s.get('c')).toBe('3');
  });
  it('does not evict when overwriting an existing key at capacity', async () => {
    const s = memoryStore({ maxEntries: 2 });
    await s.set('a', '1', 1e6);
    await s.set('b', '2', 1e6);
    await s.set('a', '1b', 1e6);
    expect(await s.get('b')).toBe('2');
    expect(await s.get('a')).toBe('1b');
    await s.set('c', '3', 1e6);
    expect(await s.get('b')).toBeUndefined();
  });
  it('drops expired entries before evicting live ones', async () => {
    const s = memoryStore({ maxEntries: 2 });
    await s.set('old', '1', 10);
    await s.set('live', '2', 1e6);
    vi.advanceTimersByTime(11);
    await s.set('new', '3', 1e6);
    expect(await s.get('live')).toBe('2');
    expect(await s.get('new')).toBe('3');
  });
  describe('at capacity', () => {
    const keysOf = (s: object): string[] => [
      ...(s as { entries: Map<string, unknown> }).entries.keys(),
    ];

    it('sweeps expired entries when a sweep is due and keeps the live LRU head', async () => {
      const s = memoryStore({ maxEntries: 3 });
      await s.set('head', '1', 1e6);
      await s.set('x', '2', 10);
      await s.set('y', '3', 10);
      vi.advanceTimersByTime(11);
      await s.set('new', '4', 1e6);
      expect(keysOf(s)).toEqual(['head', 'new']);
      /* the swept slots are free: the next insert evicts nothing */
      await s.set('more', '5', 1e6);
      expect(keysOf(s)).toEqual(['head', 'new', 'more']);
    });

    it('within 1 s of a sweep evicts the LRU head without scanning for expired entries', async () => {
      /* the scan costs O(n) per insert, so it runs at most once per second */
      const s = memoryStore({ maxEntries: 3 });
      await s.set('p', '1', 1e6);
      await s.set('q', '2', 1e6);
      await s.set('mid', '3', 200);
      await s.set('s', '4', 1e6); // sweep runs: nothing expired yet, so p is evicted
      expect(keysOf(s)).toEqual(['q', 'mid', 's']);
      vi.advanceTimersByTime(500); // mid has expired
      await s.set('u', '5', 1e6); // no sweep due: the head goes, the expired mid survives
      expect(keysOf(s)).toEqual(['mid', 's', 'u']);
      vi.advanceTimersByTime(499);
      await s.set('v', '6', 1e6); // 999 ms after the sweep: still none
      expect(keysOf(s)).toEqual(['s', 'u', 'v']);
      await s.set('mid2', '7', 100);
      expect(keysOf(s)).toEqual(['u', 'v', 'mid2']);
      vi.advanceTimersByTime(101); // 1 100 ms after the sweep, mid2 expired
      await s.set('w', '8', 1e6); // a sweep is due again: mid2 is dropped, u and v stay
      expect(keysOf(s)).toEqual(['u', 'v', 'w']);
    });

    it('never holds more than maxEntries, whatever the TTLs and timing', async () => {
      const s = memoryStore({ maxEntries: 5 });
      for (let i = 0; i < 400; i += 1) {
        await s.set(`k${String(i % 37)}`, 'v', i % 3 === 0 ? 5 : 1e6);
        if (i % 7 === 0) vi.advanceTimersByTime(i % 2 === 0 ? 3 : 400);
        expect(keysOf(s).length).toBeLessThanOrEqual(5);
      }
    });
  });

  it('delete removes the listed keys only', async () => {
    const s = memoryStore();
    await s.set('a', '1', 1e6);
    await s.set('b', '2', 1e6);
    await s.set('c', '3', 1e6);
    await s.delete(['a', 'c']);
    expect(await s.get('a')).toBeUndefined();
    expect(await s.get('b')).toBe('2');
    expect(await s.get('c')).toBeUndefined();
    await expect(s.delete([])).resolves.toBeUndefined();
  });
  it('clear removes keys with the prefix; empty prefix removes all', async () => {
    const s = memoryStore();
    await s.set('u:1', 'x', 1e6);
    await s.set('u:2', 'x', 1e6);
    await s.set('p:1', 'x', 1e6);
    await s.clear('u:');
    expect(await s.get('u:1')).toBeUndefined();
    expect(await s.get('p:1')).toBe('x');
    await s.clear('');
    expect(await s.get('p:1')).toBeUndefined();
  });
  it.each([0, -1, 1.5, Number.NaN])('rejects maxEntries %s', (n) => {
    expect(() => memoryStore({ maxEntries: n })).toThrow(CacheConfigError);
  });
  it('starts no timers', async () => {
    const s = memoryStore();
    await s.set('a', 'v', 1_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('getAndTouch extends a live entry', async () => {
    const s = memoryStore();
    await s.set('a', 'v', 1_000);
    vi.advanceTimersByTime(900);
    expect(await s.getAndTouch('a', 1_000)).toBe('v');
    vi.advanceTimersByTime(900);
    expect(await s.get('a')).toBe('v');
    vi.advanceTimersByTime(100);
    expect(await s.get('a')).toBeUndefined();
  });

  it('getAndTouch on a miss or expired entry returns undefined and drops it', async () => {
    const s = memoryStore({ maxEntries: 1 });
    expect(await s.getAndTouch('nope', 1_000)).toBeUndefined();
    await s.set('a', 'v', 1_000);
    vi.advanceTimersByTime(1_000);
    expect(await s.getAndTouch('a', 5_000)).toBeUndefined();
    // dropped, not revived by a later read
    vi.advanceTimersByTime(1);
    expect(await s.get('a')).toBeUndefined();
    // the freed slot is usable: nothing is evicted by this set
    await s.set('b', 'w', 1_000);
    expect(await s.get('b')).toBe('w');
  });

  it('getAndTouch removes an expired entry from the store', async () => {
    const s = memoryStore({ maxEntries: 2 });
    const size = (): number => (s as unknown as { entries: Map<string, unknown> }).entries.size;
    await s.set('a', 'v', 1_000);
    await s.set('live', 'l', 60_000);
    vi.advanceTimersByTime(1_000);
    expect(await s.getAndTouch('a', 5_000)).toBeUndefined();
    // Removed by the read itself, not left for the capacity sweep of a later set.
    expect(size()).toBe(1);
    // A third insert finds a free slot: the live entry is not evicted.
    await s.set('b', 'w', 1_000);
    expect(size()).toBe(2);
    expect(await s.get('live')).toBe('l');
    expect(await s.get('b')).toBe('w');
  });

  it('getAndTouch moves the entry to most-recently-used', async () => {
    const s = memoryStore({ maxEntries: 2 });
    await s.set('a', '1', 10_000);
    await s.set('b', '2', 10_000);
    expect(await s.getAndTouch('a', 10_000)).toBe('1');
    await s.set('c', '3', 10_000);
    expect(await s.get('b')).toBeUndefined();
    expect(await s.get('a')).toBe('1');
    expect(await s.get('c')).toBe('3');
  });
});

describe('MemoryStore batch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /* getMany returns values in input order, undefined for misses and expired entries. */
  it('getMany keeps the input order and returns undefined for misses and expired entries', async () => {
    const store = memoryStore();
    await store.set('a', '1', 1_000);
    await store.set('b', '2', 100);
    await store.set('c', '3', 1_000);
    vi.advanceTimersByTime(500);
    expect(await store.getMany(['c', 'x', 'b', 'a'])).toEqual(['3', undefined, undefined, '1']);
    expect(await store.getMany([])).toEqual([]);
  });

  /* setMany stores every entry with its TTL and evicts the LRU entry at maxEntries. */
  it('setMany stores entries with their TTL and respects maxEntries', async () => {
    const store = memoryStore({ maxEntries: 2 });
    await store.setMany([
      { key: 'a', value: '1', ttlMs: 1_000 },
      { key: 'b', value: '2', ttlMs: 100 },
      { key: 'c', value: '3', ttlMs: 1_000 },
    ]);
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('c')).toBe('3');
    vi.advanceTimersByTime(200);
    expect(await store.get('b')).toBeUndefined();
    await store.setMany([]);
  });
});
