import { CacheConfigError } from '../../errors.js';
import type { LoadStrategyOptions } from '../../decorators/options.js';
import type { ExpiryStrategy } from './classify.js';
import { fixedStrategy } from './fixed.strategy.js';
import { slidingStrategy } from './sliding.strategy.js';
import { swrStrategy } from './swr.strategy.js';

export { classifyEnvelope, type Classification, type ExpiryStrategy } from './classify.js';

/**
 * Copies the defined `strategy`/`staleTtl`/`maxTtl`/`softTimeout` fields, so callers can forward
 * strategy options without carrying undefined-valued keys (`exactOptionalPropertyTypes`).
 */
export function strategyOptionsOf(options: LoadStrategyOptions): LoadStrategyOptions {
  const picked: { strategy?: string; staleTtl?: number; maxTtl?: number; softTimeout?: number } =
    {};
  if (options.strategy !== undefined) picked.strategy = options.strategy;
  if (options.staleTtl !== undefined) picked.staleTtl = options.staleTtl;
  if (options.maxTtl !== undefined) picked.maxTtl = options.maxTtl;
  if (options.softTimeout !== undefined) picked.softTimeout = options.softTimeout;
  // The picked fields come from one LoadStrategyOptions value, so they form one again.
  return picked as LoadStrategyOptions;
}

export function createStrategy(options?: LoadStrategyOptions): ExpiryStrategy {
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
