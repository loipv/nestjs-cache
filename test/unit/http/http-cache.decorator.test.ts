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
});
