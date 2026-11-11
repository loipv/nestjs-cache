import type { StrategyOptions } from '../decorators/options.js';
import type { ResolvedCacheOptions } from '../module/cache.options.js';
import { OWN_ENVELOPE } from '../serializers/compressed.serializer.js';
import { jsonSerializer } from '../serializers/json.serializer.js';
import type { Target } from './engine-keys.js';
import {
  hasTags,
  type BatchTagOption,
  type TagCheck,
  type TagOption,
  type TagStamp,
} from './engine-tags.js';
import { hasOwnVersion, isEnvelope, unwrap, type CacheEnvelope } from './envelope.js';
import type { ReportError } from './events.js';
import {
  classifyEnvelope,
  createStrategy,
  type ExpiryStrategy,
} from './strategies/expiry-strategy.js';

/** The write policy a loaded or put value is checked against (`writePlan`). */
export interface WritePolicy<T> {
  ttl?: number;
  cacheNull?: boolean;
  nullTtl?: number;
  unless?: (result: T) => boolean;
}

/** `tags` per D2: an array is known before the load, a function gets the value. */
export type PutOptions<T> = WritePolicy<T> & { tags?: TagOption<T> } & StrategyOptions;

/** `PutOptions` of a batch load: a tag function also gets each entry's key (D2). */
export type BatchPutOptions<T> = WritePolicy<T> & { tags?: BatchTagOption<T> } & StrategyOptions;

/**
 * A read entry. `tags` is set only by a read that defers the tag check (`EngineIO.readMany`):
 * the stamp still to check, and `touched` is then the entry's store key when that read extended
 * its TTL with `getAndTouch` on a store without `getStrict` (deleted if the check finds it
 * invalid). `uncertain` marks a tagged
 * entry whose tag tokens could not be read (spec 3.2 step 4): a miss loaded without writing.
 */
export type Lookup =
  | { found: true; value: unknown; stale: boolean; tags?: TagStamp; touched?: string }
  | { found: false; uncertain?: true };

/** Checks the stamp of a read entry against the current tag tokens (`EngineTags.verify`). */
export type VerifyStamp = (stamp: TagStamp) => Promise<TagCheck>;

/** Whether `lookup` is a miss because its tag tokens could not be read: load, do not write. */
export function uncertain(lookup: Lookup): boolean {
  return !lookup.found && lookup.uncertain === true;
}

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

export function isEmpty(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * Classifies a raw string read from `key`. `touched` tells whether the read reset the
 * entry's TTL; `reSetTtl` is set when a touching read had to use `get` and must re-set.
 * A tagged entry is checked with `verify` before any re-set; without `verify` its stamp is
 * returned in `tags` for the caller to check. An untagged entry adds no await (the 0.6 path).
 */
export async function decode(
  ctx: EnvelopeContext,
  { name, store }: Target,
  key: string,
  raw: string | undefined,
  strategy: ExpiryStrategy,
  touched: boolean,
  reSetTtl: number | undefined,
  verify?: VerifyStamp,
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
  const { tags } = envelope;
  const deferred = hasTags(tags) && verify === undefined ? tags : undefined;
  // `getAndTouch` extended the entry's TTL before its tags could be checked. A store with
  // `getStrict` (tiered) may answer token reads from a local tier that lags, so a mismatch
  // there is never grounds to delete (T4-F): such an entry is a plain miss.
  const extended = touched && reSetTtl === undefined && store.getStrict === undefined;
  if (hasTags(tags) && verify !== undefined) {
    const check = await verify(tags);
    // A tag miss leaves the entry in the store: the next write replaces it (spec 3.2). Only an
    // entry this read just extended, and that a store read confirmed invalid, is deleted (spec
    // 3.3, T4-C); an `unconfirmed` miss may rest on this instance's out-of-date tokens.
    if (check === 'uncertain') return { found: false, uncertain: true };
    if (check !== 'valid') {
      // Not compare-and-delete: an entry rewritten since this read is removed too. That costs
      // one extra miss, never stale data.
      if (check === 'invalid' && extended) await deleteInvalid(ctx, { name, store }, [key]);
      return { found: false };
    }
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
  const lookup: Lookup = { found: true, value: unwrap(envelope), stale: state === 'stale' };
  if (deferred !== undefined) {
    lookup.tags = deferred;
    if (extended) lookup.touched = key;
  }
  return lookup;
}

/**
 * Deletes entries a tag check found invalid after a `getAndTouch` read extended them (spec
 * 3.3). Best effort: a failure is one `delete` error, never the caller's.
 */
export async function deleteInvalid(
  ctx: EnvelopeContext,
  { name, store }: Target,
  keys: readonly string[],
): Promise<void> {
  try {
    await store.delete(keys);
  } catch (error) {
    ctx.reportError(name, 'delete', error);
  }
}

/**
 * Whether an unreadable entry was written by this library: a corrupted envelope or one of
 * another version, i.e. an object with an own `v`. `decoded` is what the serializer returned,
 * or `undefined` when it threw. The built-in JSON serializer validates the envelope itself, so
 * for it the raw JSON is inspected; `compressedSerializer` over it carries an `OWN_ENVELOPE`
 * check that does the same behind the compression prefix (`undefined`, so no delete, when it
 * cannot decompress). A throwing custom serializer never leads to a delete. Never throws: a
 * value that cannot even be inspected (a revoked Proxy) is not ours.
 */
function ownEnvelope(
  ctx: EnvelopeContext,
  raw: string,
  decoded: { value: unknown } | undefined,
): boolean {
  try {
    if (decoded !== undefined) return hasOwnVersion(decoded.value);
    const { serializer } = ctx.options;
    if (serializer === jsonSerializer) return hasOwnVersion(JSON.parse(raw));
    const check: unknown = (serializer as Partial<Record<typeof OWN_ENVELOPE, unknown>>)[
      OWN_ENVELOPE
    ];
    return typeof check === 'function' && (check as (raw: string) => unknown)(raw) === true;
  } catch {
    return false;
  }
}

/** `envelope` with the `tags` field of `stamp`; an absent or empty stamp adds nothing. */
export function stamped(envelope: CacheEnvelope, stamp: TagStamp | undefined): CacheEnvelope {
  return hasTags(stamp) ? { ...envelope, tags: stamp } : envelope;
}

/** The `unless`/`cacheNull` policy of a value; a throwing `unless` is a `set` error. */
export function writePlan<T>(
  ctx: EnvelopeContext,
  target: Target,
  value: T,
  options: WritePolicy<T>,
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
