import { describe, expect, it } from 'vitest';
import { MAX_TAGS, normalizeTags } from '../../../src/core/engine-tags.js';

function tags(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `t${String(i)}`);
}

describe('normalizeTags', () => {
  it('normalizeTags de-duplicates and keeps order', () => {
    /* The first occurrence of each tag keeps its place; later repeats are dropped. Tag text is
       kept as is, separators and unicode included. */
    expect(normalizeTags(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c']);
    expect(normalizeTags(['a:b', 'ключ', '%x'])).toEqual(['a:b', 'ключ', '%x']);
    expect(normalizeTags([])).toEqual([]);
  });

  it('returns a new array, never the input', () => {
    /* The caller's array (a decorator's compiled list, a callback's result) is never handed on,
       so mutating it later cannot change a stamp. */
    const input = ['a'];
    const result = normalizeTags(input);
    expect(result).toEqual(['a']);
    expect(result).not.toBe(input);
  });

  it('normalizeTags accepts 32 unique tags and rejects 33', () => {
    /* MAX_TAGS is 32: a list of exactly 32 unique tags passes, one more throws a TypeError
       that names the limit. */
    expect(MAX_TAGS).toBe(32);
    expect(normalizeTags(tags(32))).toHaveLength(32);
    expect(() => normalizeTags(tags(33))).toThrow(TypeError);
    expect(() => normalizeTags(tags(33))).toThrow(/32/);
  });

  it('duplicates do not count toward the limit', () => {
    /* 32 unique tags each repeated (64 entries) are still 32 tags after de-duplication. */
    const unique = tags(32);
    expect(normalizeTags([...unique, ...unique])).toEqual(unique);
  });

  it.each([
    ['a string', 'user:7'],
    ['undefined', undefined],
    ['null', null],
    ['an object', { 0: 'a', length: 1 }],
    ['a number', 5],
  ])('rejects %s: tags must be an array', (_, raw) => {
    /* Anything that is not an array throws a TypeError naming the rule. */
    expect(() => normalizeTags(raw)).toThrow(TypeError);
    expect(() => normalizeTags(raw)).toThrow(/array/);
  });

  it.each([
    ['a number', ['a', 1]],
    ['null', ['a', null]],
    ['a String object', [new String('a')]],
  ])('rejects an entry that is %s', (_, raw) => {
    /* Every entry must be a primitive string. */
    expect(() => normalizeTags(raw)).toThrow(TypeError);
    expect(() => normalizeTags(raw)).toThrow(/string/);
  });

  it('rejects an empty string', () => {
    /* '' is never a tag, even next to valid ones. */
    expect(() => normalizeTags(['a', ''])).toThrow(TypeError);
    expect(() => normalizeTags(['a', ''])).toThrow(/empty/);
  });
});
