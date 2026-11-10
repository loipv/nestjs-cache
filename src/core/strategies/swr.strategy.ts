import { wrap } from '../envelope.js';
import { classifyEnvelope, type ExpiryStrategy } from './classify.js';

export function swrStrategy(staleTtl: number): ExpiryStrategy {
  const window = Math.max(1, Math.round(staleTtl));
  return {
    kind: 'swr',
    jittered: true,
    wrap: (value, now, ttl) => {
      const staleAt = now + ttl;
      const envelope = { ...wrap(value, now, ttl), staleAt, expiresAt: staleAt + window };
      return { envelope, storeTtl: ttl + window };
    },
    read: () => ({ touch: false }),
    classify: classifyEnvelope,
  };
}
