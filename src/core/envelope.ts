/** What the engine stores per entry; a `Serializer` turns it into the stored string. */
export interface CacheEnvelope {
  /** The envelope format version. */
  v: 1;
  /** The cached value; `null` when `nil` is set. */
  value: unknown;
  /** When the entry was written, in ms since the epoch. */
  storedAt: number;
  /** When the entry expires (ms since the epoch); under `swr`, when its stale window ends. */
  expiresAt?: number;
  /** `swr` only: when the entry turns stale (ms since the epoch); it is fresh before. */
  staleAt?: number;
  /** Set on a stored empty value (`cacheNull`): which one it was, as `value` is `null`. */
  nil?: 'null' | 'undefined';
  /** The tag versions the entry was written with, tag to token; absent on an untagged entry. */
  tags?: Readonly<Record<string, string>>;
}

export function wrap(value: unknown, storedAt: number, ttlMs: number): CacheEnvelope {
  const expiresAt = storedAt + ttlMs;
  if (value === null || value === undefined) {
    return { v: 1, value: null, storedAt, expiresAt, nil: value === null ? 'null' : 'undefined' };
  }
  return { v: 1, value, storedAt, expiresAt };
}

export function unwrap(envelope: CacheEnvelope): unknown {
  if (envelope.nil === 'undefined') return undefined;
  if (envelope.nil === 'null') return null;
  return envelope.value;
}

/**
 * Whether `value` looks like an envelope this library wrote, of any version: a plain object with
 * an own `v`. Used with `isNewerEnvelope` to decide whether an unreadable entry may be deleted.
 */
export function hasOwnVersion(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'v')
  );
}

/**
 * Whether `candidate` is an envelope written by a newer version of this library: an own `v` that
 * is a finite number greater than 1. Such an entry is a miss but is never deleted, so a rolling
 * deploy or a rollback does not destroy what the newer instances wrote.
 */
export function isNewerEnvelope(candidate: unknown): boolean {
  if (!hasOwnVersion(candidate)) return false;
  const v = (candidate as Record<string, unknown>)['v'];
  return typeof v === 'number' && Number.isFinite(v) && v > 1;
}

export function isEnvelope(candidate: unknown): candidate is CacheEnvelope {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const c = candidate as Record<string, unknown>;
  if (c['v'] !== 1 || !('value' in c)) return false;
  if (typeof c['storedAt'] !== 'number' || !Number.isFinite(c['storedAt'])) return false;
  for (const key of ['expiresAt', 'staleAt']) {
    const t = c[key];
    if (t !== undefined && (typeof t !== 'number' || !Number.isFinite(t))) return false;
  }
  const nil = c['nil'];
  if (nil !== undefined && nil !== 'null' && nil !== 'undefined') return false;
  return c['tags'] === undefined || isTagStamp(c['tags']);
}

/** A plain object whose own values are all strings; `{}` included. */
function isTagStamp(tags: unknown): boolean {
  if (typeof tags !== 'object' || tags === null || Array.isArray(tags)) return false;
  return Object.values(tags).every((token) => typeof token === 'string');
}
