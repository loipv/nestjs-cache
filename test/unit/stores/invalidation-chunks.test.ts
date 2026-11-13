import { describe, expect, it } from 'vitest';
import { chunkKeys, MAX_PUBLISH_CHARS } from '../../../src/stores/invalidation-chunks.js';

describe('chunkKeys', () => {
  it('splits 30 000 keys into bounded chunks that keep every key in order', () => {
    const keys = Array.from(
      { length: 30_000 },
      (_, i) => `user:profile:${String(i).padStart(36, '0')}`,
    );
    const chunks = chunkKeys('origin-1', keys, MAX_PUBLISH_CHARS);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.origin).toBe('origin-1');
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(MAX_PUBLISH_CHARS);
    }
    expect(chunks.flatMap((c) => c.keys)).toEqual(keys);
  });

  it('puts a key longer than the limit alone in its own chunk', () => {
    const big = 'x'.repeat(300_000);
    const chunks = chunkKeys('o', ['a', big, 'b'], MAX_PUBLISH_CHARS);
    expect(chunks.map((c) => c.keys)).toEqual([['a'], [big], ['b']]);
  });

  it('measures keys by their escaped JSON length', () => {
    /* Each key is 100 characters but 202 once escaped: 4 fit in 1 000 characters, where its
       raw length would fit 9 (20 keys: 5 chunks escaped, 3 raw). */
    const keys = Array.from({ length: 20 }, () => '"\\'.repeat(50));
    const max = 1_000;
    const chunks = chunkKeys('o', keys, max);
    expect(chunks.map((c) => c.keys.length)).toEqual([4, 4, 4, 4, 4]);
    for (const chunk of chunks) expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(max);
    expect(chunks.flatMap((c) => c.keys)).toEqual(keys);
  });

  it('gives no chunk for no keys', () => {
    expect(chunkKeys('o', [], MAX_PUBLISH_CHARS)).toEqual([]);
  });
});
