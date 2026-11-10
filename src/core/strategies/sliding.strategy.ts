import type { CacheEnvelope } from '../envelope.js';
import { classifyEnvelope, type ExpiryStrategy } from './expiry-strategy.js';

export function slidingStrategy(maxTtl?: number): ExpiryStrategy {
  return {
    kind: 'sliding',
    jittered: false,
    wrap: (value, now, ttl) => {
      // No expiresAt: the store TTL slides on every read, so the envelope carries no deadline.
      const envelope: CacheEnvelope = { v: 1, value, storedAt: now };
      return { envelope, storeTtl: ttl };
    },
    read: (ttl) => ({ touch: true, touchTtl: ttl }),
    classify: (envelope, now) =>
      maxTtl !== undefined && now >= envelope.storedAt + maxTtl
        ? 'expired'
        : classifyEnvelope(envelope, now),
  };
}
