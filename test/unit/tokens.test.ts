import { describe, expect, it } from 'vitest';
import { CacheConfigError } from '../../src/errors.js';
import {
  CACHE_ENGINE,
  CACHE_ENGINE_PROPERTY,
  CACHE_LOGGER,
  CACHE_METADATA,
  CACHE_OPTIONS,
} from '../../src/module/tokens.js';

describe('tokens and errors', () => {
  it('tokens are global-registry symbols', () => {
    expect(CACHE_ENGINE).toBe(Symbol.for('@loipv/nestjs-cache:engine'));
    expect(CACHE_OPTIONS).toBe(Symbol.for('@loipv/nestjs-cache:options'));
    expect(CACHE_ENGINE_PROPERTY).toBe(Symbol.for('@loipv/nestjs-cache:engine-property'));
    expect(CACHE_METADATA).toBe(Symbol.for('@loipv/nestjs-cache:metadata'));
  });

  it('the package index does not export the internal tokens (A-02..A-05)', async () => {
    /* 0.9: CACHE_ENGINE, CACHE_OPTIONS, CACHE_ENGINE_PROPERTY and CACHE_METADATA are internal;
       an application injects CacheService instead, so none of them is on the package index. */
    const index: Record<string, unknown> = await import('../../src/index.js');
    for (const name of [
      'CACHE_ENGINE',
      'CACHE_OPTIONS',
      'CACHE_ENGINE_PROPERTY',
      'CACHE_METADATA',
    ]) {
      expect(index).not.toHaveProperty(name);
    }
  });

  it('CACHE_LOGGER is a global-registry symbol', () => {
    expect(CACHE_LOGGER).toBe(Symbol.for('@loipv/nestjs-cache:logger'));
  });

  it('CacheConfigError is a named Error', () => {
    const e = new CacheConfigError('boom');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('CacheConfigError');
    expect(e.message).toBe('boom');
  });
});
