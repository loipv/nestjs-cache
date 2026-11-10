import { wrap } from '../envelope.js';
import { classifyEnvelope, type ExpiryStrategy } from './expiry-strategy.js';

export function fixedStrategy(): ExpiryStrategy {
  return {
    kind: 'fixed',
    jittered: true,
    wrap: (value, now, ttl) => ({ envelope: wrap(value, now, ttl), storeTtl: ttl }),
    read: () => ({ touch: false }),
    classify: classifyEnvelope,
  };
}
