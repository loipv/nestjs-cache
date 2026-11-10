import { isEnvelope, type CacheEnvelope } from '../core/envelope.js';

export interface Serializer {
  serialize(envelope: CacheEnvelope): string;
  deserialize(raw: string): CacheEnvelope;
}

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
