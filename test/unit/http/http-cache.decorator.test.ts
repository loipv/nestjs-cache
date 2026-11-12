import 'reflect-metadata';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { getCacheMetadata } from '../../../src/decorators/metadata.js';
import { CacheConfigError } from '../../../src/errors.js';
import { HTTP_CACHE_METADATA, HttpCache } from '../../../src/http/http-cache.decorator.js';
import type {
  HttpCacheMetadata,
  HttpCacheOptions,
} from '../../../src/http/http-cache.decorator.js';
import { HttpCacheInterceptor } from '../../../src/http/http-cache.interceptor.js';

function onMethod(options: unknown): void {
  class C {
    @HttpCache(options as HttpCacheOptions)
    m(): void {}
  }
  expect(C).toBeDefined();
}
function onClass(options: unknown): void {
  @HttpCache(options as HttpCacheOptions)
  class C {}
  expect(C).toBeDefined();
}

const bad: [string, unknown][] = [
  ['ttl', { ttl: 0 }],
  ['nullTtl', { nullTtl: -1 }],
  ['staleTtl', { strategy: 'swr', staleTtl: 0 }],
  ['softTimeout 0', { strategy: 'swr', staleTtl: 10, softTimeout: 0 }],
  ['softTimeout -1', { strategy: 'swr', staleTtl: 10, softTimeout: -1 }],
  ['softTimeout NaN', { strategy: 'swr', staleTtl: 10, softTimeout: Number.NaN }],
  ['softTimeout Infinity', { strategy: 'swr', staleTtl: 10, softTimeout: Infinity }],
  ["softTimeout '1'", { strategy: 'swr', staleTtl: 10, softTimeout: '1' }],
  ['maxTtl', { ttl: 10, strategy: 'sliding', maxTtl: 5 }],
  ['namespace', { namespace: '__x' }],
  ['lock', { lock: 'yes' }],
  ['cacheNull', { cacheNull: 1 }],
  ['empty key', { key: '' }],
  ['non-string key', { key: 5 }],
  ['unless', { unless: 'x' }],
  ['strategy', { strategy: 'nope' }],
];

describe('@HttpCache', () => {
  it.each(bad)('rejects an invalid %s on a method and a class', (_n, options) => {
    /* each spec 2.1 rule throws CacheConfigError naming C.m, or C on a class */
    expect(() => {
      onMethod(options);
    }).toThrow(CacheConfigError);
    expect(() => {
      onMethod(options);
    }).toThrow(/C\.m/);
    expect(() => {
      onClass(options);
    }).toThrow(CacheConfigError);
    expect(() => {
      onClass(options);
    }).toThrow(/^C: /);
  });

  it('stores metadata with defaults', () => {
    /* no options: namespace 'http', no store */
    class C {
      @HttpCache()
      m(): void {}
    }
    const meta = Reflect.getMetadata(HTTP_CACHE_METADATA, C.prototype.m) as HttpCacheMetadata;
    expect(meta.namespace).toBe('http');
    expect(meta.store).toBeUndefined();
  });

  it('attaches HttpCacheInterceptor', () => {
    /* Nest interceptor metadata holds the interceptor */
    class C {
      @HttpCache()
      m(): void {}
    }
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, C.prototype.m)).toContain(
      HttpCacheInterceptor,
    );
  });

  it('method options replace class options', () => {
    /* no merging between class and method */
    @HttpCache({ ttl: 1000, namespace: 'a' })
    class C {
      @HttpCache({ namespace: 'b' })
      m(): void {}
    }
    const meta = Reflect.getMetadata(HTTP_CACHE_METADATA, C.prototype.m) as HttpCacheMetadata;
    expect(meta.namespace).toBe('b');
    expect(meta.loadOptions.ttl).toBeUndefined();
    const cls = Reflect.getMetadata(HTTP_CACHE_METADATA, C) as HttpCacheMetadata;
    expect(cls.loadOptions.ttl).toBe(1000);
  });

  it('passes softTimeout through to the load options', () => {
    /* Spec 2.2: @HttpCache takes softTimeout with swr; the engine gets it per request. */
    class C {
      @HttpCache({ ttl: 100, strategy: 'swr', staleTtl: 1_000, softTimeout: 50 })
      m(): void {}
    }
    const meta = Reflect.getMetadata(HTTP_CACHE_METADATA, C.prototype.m) as HttpCacheMetadata;
    expect(meta.loadOptions).toMatchObject({ strategy: 'swr', staleTtl: 1_000, softTimeout: 50 });
    expect(meta.strategy?.kind).toBe('swr');
  });

  it('registers a cache-metadata entry of kind http', () => {
    /* method entry and class entry ('*') for startup store validation */
    @HttpCache({ store: 's', lock: true })
    class C {
      @HttpCache()
      m(): void {}
    }
    expect(getCacheMetadata(C)).toEqual([
      { kind: 'http', method: 'm', store: 'default', lock: undefined },
      { kind: 'http', method: '*', store: 's', lock: true },
    ]);
  });

  it.each([
    ['an empty tag', { tags: [''] }],
    ['non-array tags', { tags: 5 }],
    ['a non-string tag', { tags: [1] }],
  ])('rejects %s at definition', (_n, options) => {
    /* Spec 2.5: tags must be an array of non-empty strings or a function. */
    expect(() => {
      onMethod(options);
    }).toThrow(/^C\.m: tags/);
    expect(() => {
      onClass(options);
    }).toThrow(/^C: tags/);
  });

  it('copies a tags array into the load options and keeps a tags callback', () => {
    /* The array is copied into the load options; a callback is kept for the interceptor. */
    class C {
      @HttpCache({ tags: ['a', 'user:0'] })
      m(): void {}
      @HttpCache({ tags: () => ['x'] })
      n(): void {}
    }
    const meta = Reflect.getMetadata(HTTP_CACHE_METADATA, C.prototype.m) as HttpCacheMetadata;
    expect(meta.loadOptions.tags).toEqual(['a', 'user:0']);
    const fn = Reflect.getMetadata(HTTP_CACHE_METADATA, C.prototype.n) as HttpCacheMetadata;
    expect(fn.loadOptions.tags).toBeUndefined();
    expect(typeof fn.tags).toBe('function');
  });
});

describe('@HttpCache softTimeout needs swr (F-3)', () => {
  it.each([
    ['fixed', 'fixed', { strategy: 'fixed', softTimeout: 50 }],
    ['no strategy', 'fixed', { softTimeout: 50 }],
    ['sliding', 'sliding', { strategy: 'sliding', softTimeout: 50 }],
  ] as const)(
    'rejects softTimeout under %s on a method and a class',
    (_title, strategy, options) => {
      /* 0.9 F-3: a cached route loads, but only a stale swr hit waits for the refresh; softTimeout
       under 'fixed' (the default) or 'sliding' was ignored and is now a CacheConfigError. */
      const message = `softTimeout needs strategy 'swr', got '${strategy}'`;
      expect(() => {
        onMethod(options);
      }).toThrow(new CacheConfigError(`C.m: ${message}`));
      expect(() => {
        onClass(options);
      }).toThrow(new CacheConfigError(`C: ${message}`));
    },
  );
});

describe('@HttpCache literal keys and tags', () => {
  it('rejects template-like string keys and tags', () => {
    expect(() => {
      onMethod({ key: 'user:{id}' });
    }).toThrow(/^C\.m: key is not a template; use a key callback/);
    expect(() => {
      onMethod({ tags: ['t:{x}'] });
    }).toThrow(/^C\.m: tags are not templates; use a tags callback/);
  });
  it('rejects a class-level string key', () => {
    expect(() => {
      onClass({ key: 'x' });
    }).toThrow(
      /^C: a class-level key would be shared by every route; put the key on each method or use a callback/,
    );
  });
  it('accepts a class-level key callback with a method-level string key', () => {
    expect(() => {
      @HttpCache({ key: () => 'k' })
      class C {
        @HttpCache({ key: 'plain' })
        m(): void {}
      }
      expect(C).toBeDefined();
    }).not.toThrow();
  });
  it('rejects class-level tags containing braces', () => {
    expect(() => {
      onClass({ tags: ['t:{x}'] });
    }).toThrow(/^C: tags are not templates; use a tags callback/);
  });
  it('allows callbacks and plain method-level keys', () => {
    expect(() => {
      onClass({ key: () => 'k' });
    }).not.toThrow();
    expect(() => {
      onMethod({ key: 'plain' });
    }).not.toThrow();
    expect(() => {
      onMethod({ tags: () => ['t:{x}'] });
    }).not.toThrow();
  });
});
