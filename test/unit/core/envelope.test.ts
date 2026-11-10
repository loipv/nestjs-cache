import { describe, expect, it } from 'vitest';
import { isEnvelope, isExpired, unwrap, wrap } from '../../../src/core/envelope.js';

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
  it('isExpired compares against expiresAt', () => {
    const e = wrap(1, 0, 100);
    expect(isExpired(e, 99)).toBe(false);
    expect(isExpired(e, 100)).toBe(true);
    expect(isExpired({ v: 1, value: 1, storedAt: 0 }, 1e15)).toBe(false);
  });
  it('isEnvelope requires value and finite numeric timestamps', () => {
    expect(isEnvelope({ v: 1, storedAt: 0 })).toBe(false);
    expect(isEnvelope({ v: 1, value: 1, storedAt: 0, expiresAt: Infinity })).toBe(false);
    expect(isEnvelope({ v: 1, value: 1, storedAt: 0, staleAt: 'x' })).toBe(false);
    expect(isEnvelope({ v: 1, value: 1, storedAt: 0, staleAt: 5, expiresAt: 9 })).toBe(true);
  });
});
