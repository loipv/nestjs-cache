import { describe, expect, it } from 'vitest';
import { keySlot } from '../../../src/stores/key-slot.js';

describe('keySlot', () => {
  /* The CRC16 reference value from the Redis cluster spec. */
  it('hashes 123456789 to 12739', () => {
    expect(keySlot('123456789')).toBe(12739);
  });

  /* Keys sharing a hash tag land in the same slot (value matches CLUSTER KEYSLOT). */
  it('hashes only the tag between braces', () => {
    expect(keySlot('{user1000}.following')).toBe(3443);
    expect(keySlot('{user1000}.following')).toBe(keySlot('{user1000}.followers'));
  });

  /* An empty first tag means the whole key is hashed (CLUSTER KEYSLOT: 8363). */
  it('hashes the whole key when the first tag is empty', () => {
    expect(keySlot('foo{}{bar}')).toBe(8363);
  });

  /* The tag runs from the first { to the first } after it. */
  it('uses the first { and the first } after it', () => {
    expect(keySlot('foo{{bar}}zap')).toBe(keySlot('{bar'));
    expect(keySlot('foo{{bar}}zap')).toBe(4015);
    expect(keySlot('a{b}')).toBe(keySlot('b'));
  });

  /* UTF-8 bytes are hashed (CLUSTER KEYSLOT values recorded in Task 1). */
  it('hashes unicode keys and tags by their UTF-8 bytes', () => {
    expect(keySlot('ключ')).toBe(10303);
    expect(keySlot('{用户}:1')).toBe(5340);
  });
});
