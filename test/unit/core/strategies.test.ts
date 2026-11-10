import { describe, expect, it } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import type { CacheEnvelope } from '../../../src/core/envelope.js';
import { classifyEnvelope, createStrategy } from '../../../src/core/strategies/expiry-strategy.js';
import type { StrategyOptions } from '../../../src/decorators/options.js';

describe('expiry strategies', () => {
  it('fixed: expiresAt = now + ttl; fresh until then', () => {
    const s = createStrategy();
    const { envelope, storeTtl } = s.wrap({ a: 1 }, 1_000, 500);
    expect(envelope).toEqual({ v: 1, value: { a: 1 }, storedAt: 1_000, expiresAt: 1_500 });
    expect(storeTtl).toBe(500);
    expect(s.classify(envelope, 1_499)).toBe('fresh');
    expect(s.classify(envelope, 1_500)).toBe('expired');
    expect(s.read(500)).toEqual({ touch: false });
    expect(s.jittered).toBe(true);
    expect(s.kind).toBe('fixed');
    expect(createStrategy({ strategy: 'fixed' }).kind).toBe('fixed');
  });

  it('swr: fresh, stale, expired windows and store TTL', () => {
    const s = createStrategy({ strategy: 'swr', staleTtl: 300 });
    const { envelope, storeTtl } = s.wrap('v', 1_000, 100);
    expect(envelope).toMatchObject({ staleAt: 1_100, expiresAt: 1_400 });
    expect(storeTtl).toBe(400);
    expect(s.classify(envelope, 1_099)).toBe('fresh');
    expect(s.classify(envelope, 1_100)).toBe('stale');
    expect(s.classify(envelope, 1_399)).toBe('stale');
    expect(s.classify(envelope, 1_400)).toBe('expired');
    expect(s.read(100)).toEqual({ touch: false });
    expect(s.jittered).toBe(true);
    expect(s.kind).toBe('swr');
  });

  it('swr rounds staleTtl', () => {
    const s = createStrategy({ strategy: 'swr', staleTtl: 0.4 });
    const { envelope, storeTtl } = s.wrap('v', 0, 100);
    expect(storeTtl).toBe(101);
    expect(envelope).toMatchObject({ staleAt: 100, expiresAt: 101 });
    expect(createStrategy({ strategy: 'swr', staleTtl: 2.6 }).wrap('v', 0, 10).storeTtl).toBe(13);
  });

  it('swr and fixed wrap nil values with the nil marker', () => {
    const s = createStrategy({ strategy: 'swr', staleTtl: 5 });
    expect(s.wrap(null, 0, 10).envelope).toMatchObject({ value: null, nil: 'null' });
    expect(createStrategy().wrap(undefined, 0, 10).envelope).toMatchObject({ nil: 'undefined' });
  });

  it('sliding: no expiresAt, touch on read, maxTtl cap', () => {
    const s = createStrategy({ strategy: 'sliding', maxTtl: 1_000 });
    const { envelope, storeTtl } = s.wrap('v', 0, 100);
    expect(envelope).toEqual({ v: 1, value: 'v', storedAt: 0 });
    expect(storeTtl).toBe(100);
    expect(s.read(100)).toEqual({ touch: true, touchTtl: 100 });
    expect(s.jittered).toBe(false);
    expect(s.kind).toBe('sliding');
    expect(s.classify(envelope, 999)).toBe('fresh');
    expect(s.classify(envelope, 1_000)).toBe('expired');
    expect(createStrategy({ strategy: 'sliding' }).classify(envelope, 1e15)).toBe('fresh');
  });

  it('reads 0.1-format envelopes under every strategy (Review Focus 1)', () => {
    const old = { v: 1 as const, value: 'v', storedAt: 0, expiresAt: 100 };
    for (const o of [
      undefined,
      { strategy: 'swr' as const, staleTtl: 50 },
      { strategy: 'sliding' as const },
    ]) {
      const s = createStrategy(o);
      expect(s.classify(old, 99)).toBe('fresh');
      expect(s.classify(old, 100)).toBe('expired');
    }
  });

  it('a stale-window envelope classifies stale under any reader', () => {
    const swr = createStrategy({ strategy: 'swr', staleTtl: 300 });
    const { envelope } = swr.wrap('v', 1_000, 100);
    for (const o of [
      undefined,
      { strategy: 'swr' as const, staleTtl: 1 },
      { strategy: 'sliding' as const },
    ]) {
      const reader = createStrategy(o);
      expect(reader.classify(envelope, 1_100)).toBe('stale');
      expect(reader.classify(envelope, 1_400)).toBe('expired');
    }
  });

  it('classifyEnvelope: expired wins over stale; no timestamps is fresh', () => {
    const e: CacheEnvelope = { v: 1, value: 1, storedAt: 0, staleAt: 10, expiresAt: 10 };
    expect(classifyEnvelope(e, 10)).toBe('expired');
    expect(classifyEnvelope({ v: 1, value: 1, storedAt: 0 }, 1e15)).toBe('fresh');
  });

  it('throws CacheConfigError for an unknown strategy name', () => {
    const bad = { strategy: 'lru' } as unknown as StrategyOptions;
    expect(() => createStrategy(bad)).toThrow(CacheConfigError);
    expect(() => createStrategy(bad)).toThrow(
      "Unknown cache strategy: lru. Use 'fixed', 'swr' or 'sliding'.",
    );
  });
});
