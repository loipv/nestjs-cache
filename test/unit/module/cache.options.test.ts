import { describe, expect, it } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import { jsonSerializer } from '../../../src/serializers/json.serializer.js';
import { MemoryStore, memoryStore } from '../../../src/stores/memory.store.js';
import {
  resolveOptions,
  type CacheModuleAsyncOptions,
  type CacheModuleOptions,
} from '../../../src/module/cache.options.js';

describe('resolveOptions', () => {
  it('fills every default', () => {
    const r = resolveOptions();
    expect(r.defaults).toEqual({
      ttl: 60_000,
      jitter: 0,
      cacheNull: false,
      nullTtl: 30_000,
      lock: { enabled: false, ttl: 10_000, waitTimeout: 3_000, retryDelay: 50 },
    });
    expect(r.prefix).toBeUndefined();
    expect(r.serializer).toBe(jsonSerializer);
    expect([...r.stores.keys()]).toEqual(['default']);
    expect(r.stores.get('default')).toBeInstanceOf(MemoryStore);
  });

  it('creates a fresh default store per call', () => {
    expect(resolveOptions().stores.get('default')).not.toBe(resolveOptions().stores.get('default'));
  });

  it('keeps user values and named stores', () => {
    const a = memoryStore();
    const b = memoryStore();
    const r = resolveOptions({
      prefix: 'app',
      defaults: { ttl: 5_000, jitter: 0.1, cacheNull: true, nullTtl: 1_000 },
      stores: { default: a, sessions: b },
    });
    expect(r.prefix).toBe('app');
    expect(r.defaults).toEqual({
      ttl: 5_000,
      jitter: 0.1,
      cacheNull: true,
      nullTtl: 1_000,
      lock: { enabled: false, ttl: 10_000, waitTimeout: 3_000, retryDelay: 50 },
    });
    expect(r.stores.get('default')).toBe(a);
    expect(r.stores.get('sessions')).toBe(b);
  });

  it('treats an empty prefix as absent', () => {
    expect(resolveOptions({ prefix: '' }).prefix).toBeUndefined();
  });

  it.each([
    [{ defaults: { ttl: 0 } }, /defaults\.ttl/],
    [{ defaults: { ttl: -5 } }, /defaults\.ttl/],
    [{ defaults: { ttl: Number.NaN } }, /defaults\.ttl/],
    [{ defaults: { nullTtl: 0 } }, /defaults\.nullTtl/],
    [{ defaults: { jitter: -0.1 } }, /defaults\.jitter/],
    [{ defaults: { jitter: 1 } }, /defaults\.jitter/],
  ])('rejects %j', (options, pattern) => {
    expect(() => resolveOptions(options)).toThrow(pattern);
  });

  it('includes the offending value in the message', () => {
    expect(() => resolveOptions({ defaults: { ttl: 0 } })).toThrow(
      'Invalid cache option defaults.ttl: 0 (must be a finite number > 0)',
    );
  });

  it('rejects stores without "default"', () => {
    const stores = { sessions: memoryStore() } as unknown as NonNullable<
      CacheModuleOptions['stores']
    >;
    expect(() => resolveOptions({ stores })).toThrow(/"default"/);
  });

  it('rejects a store that does not implement CacheStore', () => {
    const stores = { default: memoryStore(), sessions: {} } as unknown as NonNullable<
      CacheModuleOptions['stores']
    >;
    expect(() => resolveOptions({ stores })).toThrow(
      'Cache store "sessions" does not implement CacheStore',
    );
  });

  it('every rejection is a CacheConfigError', () => {
    expect(() => resolveOptions({ defaults: { ttl: 0 } })).toThrow(CacheConfigError);
  });
});

describe('CacheModuleAsyncOptions', () => {
  it('accepts a factory with typed parameters', () => {
    const options: CacheModuleAsyncOptions = {
      useFactory: (config: { prefix: string }) => ({ prefix: config.prefix }),
    };
    expect(typeof options.useFactory).toBe('function');
  });

  it('resolves lock defaults', () => {
    expect(resolveOptions().defaults.lock).toEqual({
      enabled: false,
      ttl: 10_000,
      waitTimeout: 3_000,
      retryDelay: 50,
    });
    expect(
      resolveOptions({ defaults: { lock: { enabled: true, ttl: 500 } } }).defaults.lock,
    ).toEqual({ enabled: true, ttl: 500, waitTimeout: 3_000, retryDelay: 50 });
  });

  it.each([
    ['ttl', 0],
    ['waitTimeout', -1],
    ['retryDelay', Number.NaN],
  ] as const)('rejects defaults.lock.%s = %s', (f, v) => {
    expect(() => resolveOptions({ defaults: { lock: { [f]: v } } })).toThrow(
      `Invalid cache option defaults.lock.${f}`,
    );
  });

  it.each([
    [null, 'null'],
    ['true', 'true'],
    [1, '1'],
    [true, 'true'],
    [[], ''],
  ])('rejects a non-object defaults.lock: %j', (value, shown) => {
    const bad = { defaults: { lock: value } } as unknown as CacheModuleOptions;
    expect(() => resolveOptions(bad)).toThrow(CacheConfigError);
    expect(() => resolveOptions(bad)).toThrow(
      `Invalid cache option defaults.lock: ${shown} (must be an object)`,
    );
  });

  it('treats an undefined defaults.lock as the defaults', () => {
    expect(resolveOptions({ defaults: { lock: undefined } }).defaults.lock).toEqual({
      enabled: false,
      ttl: 10_000,
      waitTimeout: 3_000,
      retryDelay: 50,
    });
  });

  it('rejects a non-boolean enabled', () => {
    const bad = { defaults: { lock: { enabled: 'true' as unknown as boolean } } };
    expect(() => resolveOptions(bad)).toThrow(CacheConfigError);
    expect(() => resolveOptions(bad)).toThrow(
      'Invalid cache option defaults.lock.enabled: true (must be a boolean)',
    );
  });
});
