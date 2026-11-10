import { describe, expect, it } from 'vitest';
import { CacheConfigError } from '../../src/errors.js';

describe('CacheConfigError identity (F3)', () => {
  it('accepts an error from a structurally identical class, as the other build would create', () => {
    // What `require('@loipv/nestjs-cache').CacheConfigError` looks like from the ESM build.
    class OtherBuildCacheConfigError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CacheConfigError';
      }
    }
    const foreign: unknown = new OtherBuildCacheConfigError('x');
    expect(foreign instanceof CacheConfigError).toBe(true);
    if (foreign instanceof CacheConfigError) {
      // instanceof still narrows for TypeScript
      expect(foreign.message).toBe('x');
    }
  });

  it('rejects other errors and non-errors', () => {
    expect(new Error('x') instanceof CacheConfigError).toBe(false);
    expect(new TypeError('x') instanceof CacheConfigError).toBe(false);
    const plain: unknown = { name: 'CacheConfigError', message: 'x' };
    expect(plain instanceof CacheConfigError).toBe(false);
    expect((null as unknown) instanceof CacheConfigError).toBe(false);
    expect(('CacheConfigError' as unknown) instanceof CacheConfigError).toBe(false);
  });

  it('keeps normal subclass semantics', () => {
    class StricterConfigError extends CacheConfigError {}
    const base = new CacheConfigError('base');
    const sub = new StricterConfigError('sub');
    expect(base instanceof CacheConfigError).toBe(true);
    expect(base instanceof Error).toBe(true);
    expect(sub instanceof CacheConfigError).toBe(true);
    expect(sub instanceof StricterConfigError).toBe(true);
    expect(base instanceof StricterConfigError).toBe(false);
  });
});
