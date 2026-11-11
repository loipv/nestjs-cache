import { applyDecorators, SetMetadata, StreamableFile, UseInterceptors } from '@nestjs/common';
import type { LoadOptions } from '../core/cache-engine.js';
import { createStrategy, type ExpiryStrategy } from '../core/strategies/expiry-strategy.js';
import {
  addCacheMetadata,
  assertBoolean,
  assertFunction,
  assertNamespace,
  assertPositiveFinite,
  assertStrategyTtls,
  assertTags,
  CLASS_LEVEL,
  describeMethod,
} from '../decorators/metadata.js';
import { presetStrategy, putOptionsOf } from '../decorators/method-wrapper.js';
import type { LoadStrategyOptions } from '../decorators/options.js';
import { CacheConfigError } from '../errors.js';
import { HttpCacheInterceptor } from './http-cache.interceptor.js';

/** What a `key` callback receives about the request. */
export interface HttpCacheRequest {
  method: string;
  /** The raw request URL, as received (query unsorted, nothing escaped). */
  url: string;
  /**
   * The key used when `key` is not set: the path plus the query sorted by name then value, with
   * `%` and `:` percent-encoded. It varies on path and query only.
   */
  defaultKey: string;
  path: string;
  query: Readonly<Record<string, string | readonly string[]>>;
  params: Readonly<Record<string, string>>;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export type HttpCacheOptions = LoadStrategyOptions & {
  ttl?: number;
  /** Defaults to 'http'. */
  namespace?: string;
  store?: string;
  lock?: boolean;
  cacheNull?: boolean;
  nullTtl?: number;
  /** A string is a fixed key. A callback derives the key per request; `undefined` skips caching that request. */
  key?: string | ((req: HttpCacheRequest) => string | undefined);
  /** Returns `true` to keep the body out of the cache. */
  unless?: (body: unknown) => boolean;
  /**
   * Tags the cached body (spec 2.1): fixed strings (not templates), or a callback of the body
   * and the request, called once the body is to be written.
   */
  tags?: readonly string[] | HttpCacheTags;
};

/** An `@HttpCache` tags callback. */
export type HttpCacheTags = (body: unknown, req: HttpCacheRequest) => readonly string[];

export const HTTP_CACHE_METADATA: unique symbol = Symbol('nestjs-cache:http-cache');

export interface HttpCacheMetadata {
  namespace: string;
  store: string | undefined;
  key: HttpCacheOptions['key'];
  loadOptions: LoadOptions<unknown>;
  strategy: ExpiryStrategy | undefined;
  /** A tags callback, called per request; a tags array is in `loadOptions` already. */
  tags: HttpCacheTags | undefined;
}

/** Bodies that are never cached: files, binary data and streams. */
function isUncacheable(body: unknown): boolean {
  return (
    body instanceof StreamableFile ||
    body instanceof Uint8Array ||
    (typeof body === 'object' &&
      body !== null &&
      typeof (body as { pipe?: unknown }).pipe === 'function')
  );
}

function validate(
  target: object,
  method: string | symbol,
  options: HttpCacheOptions | undefined,
): void {
  assertNamespace(target, method, options?.namespace);
  assertPositiveFinite(target, method, 'ttl', options?.ttl);
  assertPositiveFinite(target, method, 'nullTtl', options?.nullTtl);
  assertBoolean(target, method, 'cacheNull', options?.cacheNull);
  assertBoolean(target, method, 'lock', options?.lock);
  assertStrategyTtls(target, method, options);
  try {
    createStrategy(options);
  } catch (error) {
    throw new CacheConfigError(
      `${describeMethod(target, method)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const key: unknown = options?.key;
  if (key !== undefined && typeof key !== 'function' && (typeof key !== 'string' || key === '')) {
    throw new CacheConfigError(
      `${describeMethod(target, method)}: key must be a non-empty string or a function, got ${typeof key}`,
    );
  }
  assertTags(target, method, options?.tags);
  assertFunction(target, method, 'unless', options?.unless);
}

/** Caches the HTTP response body of a route (method) or of every route of a controller (class). */
export function HttpCache(options?: HttpCacheOptions): MethodDecorator & ClassDecorator {
  return (target: object, propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => {
    const isClass = propertyKey === undefined;
    const holder = isClass ? (target as { prototype: object }).prototype : target;
    const method = isClass ? CLASS_LEVEL : propertyKey;
    validate(holder, method, options);
    const loadOptions: LoadOptions<unknown> = putOptionsOf(options);
    if (options?.lock !== undefined) loadOptions.lock = options.lock;
    // The built-in check first, then the user's: a file or stream never reaches the user's `unless`.
    const unless = options?.unless;
    loadOptions.unless = (body) => isUncacheable(body) || unless?.(body) === true;
    const tags = options?.tags;
    // Fixed tags are the same for every request: their tokens are taken before the handler runs.
    if (Array.isArray(tags) && tags.length > 0) loadOptions.tags = [...(tags as readonly string[])];
    const metadata: HttpCacheMetadata = {
      namespace: options?.namespace ?? 'http',
      store: options?.store,
      key: options?.key,
      loadOptions,
      strategy: presetStrategy(loadOptions),
      tags: typeof tags === 'function' ? tags : undefined,
    };
    addCacheMetadata(holder, {
      kind: 'http',
      method,
      store: options?.store ?? 'default',
      lock: options?.lock,
    });
    const decorate = applyDecorators(
      UseInterceptors(HttpCacheInterceptor),
      SetMetadata(HTTP_CACHE_METADATA, metadata),
    );
    if (isClass) (decorate as ClassDecorator)(target as never);
    else (decorate as MethodDecorator)(target, propertyKey, descriptor as PropertyDescriptor);
  };
}
