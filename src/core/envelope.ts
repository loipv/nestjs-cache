export interface CacheEnvelope {
  v: 1;
  value: unknown;
  storedAt: number;
  expiresAt?: number;
  staleAt?: number;
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
