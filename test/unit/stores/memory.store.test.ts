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
});
