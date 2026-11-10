import { CacheConfigError } from '../../errors.js';
import type { StrategyOptions } from '../../decorators/options.js';
import type { CacheEnvelope } from '../envelope.js';
import { fixedStrategy } from './fixed.strategy.js';
import { slidingStrategy } from './sliding.strategy.js';
import { swrStrategy } from './swr.strategy.js';

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

/**
 * Copies the defined `strategy`/`staleTtl`/`maxTtl` fields, so callers can forward strategy
 * options without carrying undefined-valued keys (`exactOptionalPropertyTypes`).
 */
export function strategyOptionsOf(options: StrategyOptions): StrategyOptions {
  const picked: { strategy?: string; staleTtl?: number; maxTtl?: number } = {};
  if (options.strategy !== undefined) picked.strategy = options.strategy;
  if (options.staleTtl !== undefined) picked.staleTtl = options.staleTtl;
  if (options.maxTtl !== undefined) picked.maxTtl = options.maxTtl;
  // The picked fields come from one StrategyOptions value, so they form one again.
  return picked as StrategyOptions;
}

export function createStrategy(options?: StrategyOptions): ExpiryStrategy {
  const name: unknown = options?.strategy;
  switch (name) {
    case undefined:
    case 'fixed':
      return fixedStrategy();
    case 'swr':
      return swrStrategy((options as { staleTtl: number }).staleTtl);
    case 'sliding':
      return slidingStrategy((options as { maxTtl?: number }).maxTtl);
    default:
      throw new CacheConfigError(
        `Unknown cache strategy: ${String(name)}. Use 'fixed', 'swr' or 'sliding'.`,
      );
  }
}
