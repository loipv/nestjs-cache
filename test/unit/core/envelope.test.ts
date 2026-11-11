import { describe, expect, it } from 'vitest';
import { isEnvelope, unwrap, wrap } from '../../../src/core/envelope.js';

describe('envelope', () => {
  it('wrap stamps storedAt and expiresAt', () => {
    expect(wrap({ a: 1 }, 1_000, 500)).toEqual({
      v: 1,
      value: { a: 1 },
      storedAt: 1_000,
      expiresAt: 1_500,
    });
  });
  it.each([
    [null, 'null'],
    [undefined, 'undefined'],
  ] as const)('wrap marks %s', (value, nil) => {
    const e = wrap(value, 0, 10);
    expect(e).toMatchObject({ value: null, nil });
    expect(unwrap(e)).toBe(value);
  });
  it('isEnvelope requires value and finite numeric timestamps', () => {
    expect(isEnvelope({ v: 1, storedAt: 0 })).toBe(false);
    expect(isEnvelope({ v: 1, value: 1, storedAt: 0, expiresAt: Infinity })).toBe(false);
    expect(isEnvelope({ v: 1, value: 1, storedAt: 0, staleAt: 'x' })).toBe(false);
    expect(isEnvelope({ v: 1, value: 1, storedAt: 0, staleAt: 5, expiresAt: 9 })).toBe(true);
  });
  it('isEnvelope accepts a string-to-string tags object and rejects any other shape', () => {
    /* `tags` is optional; when present it maps each tag to its token. An empty object is still
       an envelope (read as untagged); an array, null, a primitive or a non-string token is not. */
    const base = { v: 1, value: 1, storedAt: 0 };
    expect(isEnvelope({ ...base, tags: { 'user:7': 'abc12345', ключ: 'x' } })).toBe(true);
    expect(isEnvelope({ ...base, tags: {} })).toBe(true);
    expect(isEnvelope(JSON.parse('{"v":1,"value":1,"storedAt":0,"tags":{"__proto__":"t"}}'))).toBe(
      true,
    );
    for (const tags of [null, [], ['a'], 'a', 5, true, { a: 1 }, { a: 'x', b: null }, { a: {} }]) {
      expect(isEnvelope({ ...base, tags })).toBe(false);
    }
  });
});
