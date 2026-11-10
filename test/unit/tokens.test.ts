import { describe, expect, it } from 'vitest';
import { CacheConfigError } from '../../src/errors.js';
import {
  CACHE_ENGINE,
  CACHE_ENGINE_PROPERTY,
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

  it('CacheConfigError is a named Error', () => {
    const e = new CacheConfigError('boom');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('CacheConfigError');
    expect(e.message).toBe('boom');
  });
});
