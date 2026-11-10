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

  describe('0.2 definition-time checks', () => {
    it.each([0, -1, Number.NaN])('rejects staleTtl %s', (v) => {
      expect(() => {
        class S {
          @Cacheable({ strategy: 'swr', staleTtl: v }) a(): Promise<number> {
            return Promise.resolve(1);
          }
        }
        return S;
      }).toThrow(CacheConfigError);
      expect(() => {
        class S {
          @Cacheable({ strategy: 'swr', staleTtl: v }) a(): Promise<number> {
            return Promise.resolve(1);
          }
        }
        return S;
      }).toThrow(/S\.a/);
    });

    it.each([0, -1, Number.NaN])('rejects maxTtl %s', (v) => {
      expect(() => {
        class S {
          @CachePut({ strategy: 'sliding', maxTtl: v }) a(): Promise<number> {
            return Promise.resolve(1);
          }
        }
        return S;
      }).toThrow(/S\.a: maxTtl/);
    });

    it('rejects maxTtl below ttl at definition', () => {
      expect(() => {
        class S {
          @Cacheable({ strategy: 'sliding', ttl: 10, maxTtl: 5 }) a(): Promise<number> {
            return Promise.resolve(1);
          }
        }
        return S;
      }).toThrow('S.a: maxTtl (5) must be >= ttl (10)');
    });

    it('accepts maxTtl equal to ttl, or maxTtl without ttl', () => {
      expect(() => {
        class S {
          @Cacheable({ strategy: 'sliding', ttl: 5, maxTtl: 5 }) a(): Promise<number> {
            return Promise.resolve(1);
          }
          @Cacheable({ strategy: 'sliding', maxTtl: 5 }) b(): Promise<number> {
            return Promise.resolve(1);
          }
        }
        return S;
      }).not.toThrow();
    });

    it('rejects static methods', () => {
      expect(() => {
        class S {
          @Cacheable() static a(): Promise<number> {
            return Promise.resolve(1);
          }
        }
        return S;
      }).toThrow('S.a: cache decorators cannot be used on static methods');
    });

    it('rejects an empty evict key list', () => {
      expect(() => {
        class S {
          @CacheEvict({ key: [] }) a(): Promise<void> {
            return Promise.resolve();
          }
        }
        return S;
      }).toThrow('S.a: key must not be an empty array');
    });

    it('records the lock flag', () => {
      class S {
        @Cacheable({ lock: true }) a(): Promise<number> {
          return Promise.resolve(1);
        }
        @Cacheable() b(): Promise<number> {
          return Promise.resolve(1);
        }
        @CachePut() c(): Promise<number> {
          return Promise.resolve(1);
        }
        @CacheEvict() d(): Promise<void> {
          return Promise.resolve();
        }
      }
      const [a, b, c, d] = getCacheMetadata(S);
      expect(a?.lock).toBe(true);
      expect(b?.lock).toBeUndefined();
      expect(c?.lock).toBeUndefined();
      expect(d?.lock).toBeUndefined();
    });
  });
});
