export interface CacheEnvelope {
  v: 1;
  value: unknown;
  storedAt: number;
  expiresAt?: number;
  staleAt?: number;
  nil?: 'null' | 'undefined';
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
  return nil === undefined || nil === 'null' || nil === 'undefined';
}

export function isExpired(envelope: CacheEnvelope, now: number): boolean {
  return envelope.expiresAt !== undefined && envelope.expiresAt <= now;
}
