import { describe, expect, it } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import { CacheEvict, CachePut, Cacheable } from '../../../src/index.js';
import type { CacheEvictOptions } from '../../../src/index.js';
import { getCacheMetadata } from '../../../src/decorators/metadata.js';

describe('decorator metadata', () => {
  it('records one entry per decorator with the default store', () => {
    class S {
      @Cacheable() a(): Promise<number> {
        return Promise.resolve(1);
      }
      @CacheEvict({ store: 'sessions' }) b(): Promise<void> {
        return Promise.resolve();
      }
    }
    expect(getCacheMetadata(S)).toEqual([
      { kind: 'cacheable', method: 'a', store: 'default' },
      { kind: 'evict', method: 'b', store: 'sessions' },
    ]);
  });

  it('returns [] for an undecorated class', () => {
    expect(getCacheMetadata(class {})).toEqual([]);
  });

  it('subclass sees parent entries; parent does not see subclass entries', () => {
    class S {
      @Cacheable() a(): Promise<number> {
        return Promise.resolve(1);
      }
    }
    class Child extends S {
      @CachePut() p(): Promise<number> {
        return Promise.resolve(2);
      }
    }
    expect(getCacheMetadata(S)).toEqual([{ kind: 'cacheable', method: 'a', store: 'default' }]);
    expect(getCacheMetadata(Child)).toEqual([
      { kind: 'cacheable', method: 'a', store: 'default' },
      { kind: 'put', method: 'p', store: 'default' },
    ]);
  });

  it('rejects @Cacheable together with @CachePut on one method', () => {
    expect(() => {
      class S {
        @Cacheable() @CachePut() a(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).toThrow(CacheConfigError);
    expect(() => {
      class S {
        @CachePut() @Cacheable() a(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).toThrow(/S\.a/);
  });

  it('allows several @CacheEvict, and @CachePut with @CacheEvict', () => {
    class S {
      @CacheEvict({ key: 'x' })
      @CacheEvict({ key: 'y' })
      a(): Promise<void> {
        return Promise.resolve();
      }
      @CachePut()
      @CacheEvict()
      b(): Promise<number> {
        return Promise.resolve(1);
      }
    }
    const meta = getCacheMetadata(S);
    expect(meta.filter((e) => e.method === 'a')).toHaveLength(2);
    expect(meta.filter((e) => e.method === 'b')).toHaveLength(2);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects ttl %s naming the method',
    (ttl) => {
      expect(() => {
        class S {
          @Cacheable({ ttl }) a(): Promise<number> {
            return Promise.resolve(1);
          }
        }
        return S;
      }).toThrow(/S\.a/);
    },
  );

  it('rejects an invalid nullTtl on @CachePut', () => {
    expect(() => {
      class S {
        @CachePut({ nullTtl: 0 }) a(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).toThrow(/S\.a/);
  });

  it('rejects allEntries without namespace or with key at runtime too', () => {
    const noNamespace = Object.assign({ allEntries: true }) as unknown as CacheEvictOptions<
      never[]
    >;
    const withKey = Object.assign({
      namespace: 'n',
      allEntries: true,
      key: 'x',
    }) as unknown as CacheEvictOptions<never[]>;
    expect(() => {
      class S {
        @CacheEvict(noNamespace) a(): Promise<void> {
          return Promise.resolve();
        }
      }
      return S;
    }).toThrow(/S\.a/);
    expect(() => {
      class S {
        @CacheEvict(withKey) a(): Promise<void> {
          return Promise.resolve();
        }
      }
      return S;
    }).toThrow(CacheConfigError);
  });
});
