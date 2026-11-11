import type { StrategyOptions } from '../decorators/options.js';
import type { ResolvedCacheOptions } from '../module/cache.options.js';
import { jsonSerializer } from '../serializers/json.serializer.js';
import type { ReportError, Target } from './engine-keys.js';
import { isEnvelope, unwrap, type CacheEnvelope } from './envelope.js';
import {
  classifyEnvelope,
  createStrategy,
  type ExpiryStrategy,
} from './strategies/expiry-strategy.js';

export type PutOptions<T> = {
  ttl?: number;
  cacheNull?: boolean;
  nullTtl?: number;
  unless?: (result: T) => boolean;
} & StrategyOptions;

export type Lookup = { found: true; value: unknown; stale: boolean } | { found: false };

/** How a value is written: with a strategy and ttl, or not at all (`empty`: uncached null). */
export type WritePlan = { strategy: ExpiryStrategy; ttl: number } | 'skip' | 'empty';

/** What the envelope functions take from the engine: its options, error reporting and ttl. */
export interface EnvelopeContext {
  readonly options: ResolvedCacheOptions;
  readonly reportError: ReportError;
  /** `EngineIO.ttlFor`. */
  readonly ttlFor: (strategy: ExpiryStrategy, ttl: number) => number;
}

/** Empty values always use `fixed`: it is the strategy that keeps the `nil` marker. */
export const EMPTY_STRATEGY = createStrategy();

export function toIntegerMs(ms: number): number {
  return Math.max(1, Math.round(ms));
}

/** A stale entry is served only under swr; any other reader has a loader and reloads now. */
export function servable(
  lookup: Lookup,
  strategy: ExpiryStrategy,
): lookup is Extract<Lookup, { found: true }> {
  return lookup.found && (!lookup.stale || strategy.kind === 'swr');
}

function hasOwnVersion(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'v')
  );
}

export function isEmpty(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * Classifies a raw string read from `key`. `touched` tells whether the read reset the
 * entry's TTL; `reSetTtl` is set when a touching read had to use `get` and must re-set.
 */
export async function decode(
  ctx: EnvelopeContext,
  { name, store }: Target,
  key: string,
  raw: string | undefined,
  strategy: ExpiryStrategy,
  touched: boolean,
  reSetTtl: number | undefined,
): Promise<Lookup> {
  if (raw === undefined) return { found: false };
  let envelope: CacheEnvelope;
  let decoded: { value: unknown } | undefined;
  try {
    const candidate: unknown = ctx.options.serializer.deserialize(raw);
    decoded = { value: candidate };
    if (!isEnvelope(candidate)) throw new TypeError('Deserialized value is not a cache envelope');
    envelope = candidate;
  } catch (error) {
    ctx.reportError(name, 'deserialize', error);
    // Keys can name entries this library did not write (a lock token, another app's key on
    // a shared Redis): only an entry that looks like one of our envelopes is deleted.
    if (ownEnvelope(ctx, raw, decoded)) {
      try {
        await store.delete([key]);
      } catch {
        // cleanup is best effort; the failure is already reported
      }
    }
    return { found: false };
  }
  const now = Date.now();
  const state = strategy.classify(envelope, now);
  if (state === 'expired') {
    // The store TTL would keep the entry alive when only the strategy expired it (sliding
    // maxTtl), or when this read just touched it. A non-touching read of an entry past its
    // own expiresAt is left for the store to drop, as in 0.1: no delete command is added.
    if (touched || classifyEnvelope(envelope, now) !== 'expired') {
      try {
        await store.delete([key]);
      } catch {
        // cleanup is best effort; the read is a miss either way
      }
    }
    return { found: false };
  }
  // Only a touching reader re-sets, and only a fresh entry: an expired one returned above, so
  // maxTtl still bounds a sliding entry, and a stale one is reloaded (getOrSet) or only read
  // (get) by a reader that is not swr. Not atomic.
  if (reSetTtl !== undefined && state === 'fresh') {
    try {
      await store.set(key, raw, reSetTtl);
    } catch (error) {
      ctx.reportError(name, 'set', error);
    }
  }
  return { found: true, value: unwrap(envelope), stale: state === 'stale' };
}

/**
 * Whether an unreadable entry was written by this library: a corrupted envelope or one of
 * another version, i.e. an object with an own `v`. `decoded` is what the serializer returned,
 * or `undefined` when it threw. The built-in JSON serializer validates the envelope itself, so
 * for it the raw JSON is inspected; a throwing custom serializer never leads to a delete.
 * Never throws: a value that cannot even be inspected (a revoked Proxy) is not ours.
 */
function ownEnvelope(
  ctx: EnvelopeContext,
  raw: string,
  decoded: { value: unknown } | undefined,
): boolean {
  try {
    if (decoded !== undefined) return hasOwnVersion(decoded.value);
    if (ctx.options.serializer !== jsonSerializer) return false;
    return hasOwnVersion(JSON.parse(raw));
  } catch {
    return false;
  }
}

/** The `unless`/`cacheNull` policy of a value; a throwing `unless` is a `set` error. */
export function writePlan<T>(
  ctx: EnvelopeContext,
  target: Target,
  value: T,
  options: PutOptions<T>,
  strategy: ExpiryStrategy,
): WritePlan {
  try {
    if (options.unless?.(value) === true) return 'skip';
  } catch (error) {
    ctx.reportError(target.name, 'set', error);
    return 'skip';
  }
  if (isEmpty(value)) {
    if (!(options.cacheNull ?? ctx.options.defaults.cacheNull)) return 'empty';
    const nullTtl = toIntegerMs(options.nullTtl ?? ctx.options.defaults.nullTtl);
    return { strategy: EMPTY_STRATEGY, ttl: nullTtl };
  }
  return { strategy, ttl: ctx.ttlFor(strategy, options.ttl ?? ctx.options.defaults.ttl) };
}
