import { CacheConfigError } from '../../errors.js';
import type { StrategyOptions } from '../../decorators/options.js';
import type { ExpiryStrategy } from './classify.js';
import { fixedStrategy } from './fixed.strategy.js';
import { slidingStrategy } from './sliding.strategy.js';
import { swrStrategy } from './swr.strategy.js';

export { classifyEnvelope, type Classification, type ExpiryStrategy } from './classify.js';

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
