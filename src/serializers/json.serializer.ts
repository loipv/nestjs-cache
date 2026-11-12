import { isEnvelope, type CacheEnvelope } from '../core/envelope.js';

/**
 * Turns an entry's envelope into the string a store holds, and back
 * (`CacheModuleOptions.serializer`).
 * `deserialize` must throw on input it does not recognise: the engine reports that as an `error`
 * event with operation `'deserialize'` and treats the entry as a miss.
 *
 * `deserialize(serialize(e))` must keep every field of `e`, including fields this version does
 * not know.
 */
export interface Serializer {
  serialize(envelope: CacheEnvelope): string;
  deserialize(raw: string): CacheEnvelope;
}

/** The default serializer: `JSON.stringify` and `JSON.parse`, with an envelope shape check. */
export const jsonSerializer: Serializer = {
  serialize(envelope) {
    return JSON.stringify(envelope);
  },
  deserialize(raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid cache payload: not valid JSON');
    }
    if (!isEnvelope(parsed)) throw new Error('Invalid cache payload: not a cache envelope');
    return parsed;
  },
};
