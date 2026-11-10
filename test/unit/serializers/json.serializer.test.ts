import { describe, expect, it } from 'vitest';
import { unwrap, wrap } from '../../../src/core/envelope.js';
import { jsonSerializer } from '../../../src/serializers/json.serializer.js';

describe('jsonSerializer', () => {
  it.each([0, '', false, [], {}])('round-trips falsy value %j without a nil marker', (value) => {
    const e = jsonSerializer.deserialize(jsonSerializer.serialize(wrap(value, 0, 10)));
    expect(e.nil).toBeUndefined();
    expect(unwrap(e)).toEqual(value);
  });
  it('round-trips undefined through JSON', () => {
    expect(
      unwrap(jsonSerializer.deserialize(jsonSerializer.serialize(wrap(undefined, 0, 10)))),
    ).toBeUndefined();
  });
  it.each([
    'not json',
    '42',
    'null',
    '{"v":2,"value":1,"storedAt":0}',
    '{"v":1,"value":1}',
    '{"v":1,"value":1,"storedAt":"x"}',
    '{"v":1,"value":1,"storedAt":0,"nil":"other"}',
  ])('deserialize rejects %s', (raw) => {
    expect(() => jsonSerializer.deserialize(raw)).toThrow();
  });
});
