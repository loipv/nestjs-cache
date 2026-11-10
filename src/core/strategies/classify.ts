import type { CacheEnvelope } from '../envelope.js';

// Leaf module of the strategies: the factories and `expiry-strategy.ts` import it, and it
// imports none of them, so there is no runtime import cycle.

export type Classification = 'fresh' | 'stale' | 'expired';

export interface ExpiryStrategy {
  readonly kind: 'fixed' | 'swr' | 'sliding';
  /** The engine adds jitter to the ttl before calling `wrap` when true. */
  readonly jittered: boolean;
  /** Only receives non-null/undefined-or-nil values; `ttl` is an integer >= 1. */
  wrap(value: unknown, now: number, ttl: number): { envelope: CacheEnvelope; storeTtl: number };
  read(ttl: number): { touch: false } | { touch: true; touchTtl: number };
  classify(envelope: CacheEnvelope, now: number): Classification;
}

/** Shared by every strategy, so envelopes written by one strategy are readable by any other. */
export function classifyEnvelope(envelope: CacheEnvelope, now: number): Classification {
  if (envelope.expiresAt !== undefined && now >= envelope.expiresAt) return 'expired';
  if (envelope.staleAt !== undefined && now >= envelope.staleAt) return 'stale';
  return 'fresh';
}
