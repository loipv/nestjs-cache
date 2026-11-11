import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import type { LoadOptions } from '../core/cache-engine.js';
import { createStrategy, type ExpiryStrategy } from '../core/strategies/expiry-strategy.js';
import {
  addCacheMetadata,
  assertBoolean,
  assertNamespace,
  assertPositiveFinite,
  assertStrategyTtls,
  describeMethod,
} from '../decorators/metadata.js';
import { presetStrategy, putOptionsOf } from '../decorators/method-wrapper.js';
import type { StrategyOptions } from '../decorators/options.js';
import { CacheConfigError } from '../errors.js';
import { HttpCacheInterceptor } from './http-cache.interceptor.js';

export interface HttpCacheRequest {
  method: string;
  url: string;
  path: string;
  query: Readonly<Record<string, string | readonly string[]>>;
  params: Readonly<Record<string, string>>;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export type HttpCacheOptions = StrategyOptions & {
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
};

export const HTTP_CACHE_METADATA: unique symbol = Symbol('nestjs-cache:http-cache');

export interface HttpCacheMetadata {
  namespace: string;
  store: string | undefined;
  key: HttpCacheOptions['key'];
  loadOptions: LoadOptions<unknown>;
  strategy: ExpiryStrategy | undefined;
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
  const unless: unknown = options?.unless;
  if (unless !== undefined && typeof unless !== 'function') {
    throw new CacheConfigError(
      `${describeMethod(target, method)}: unless must be a function, got ${typeof unless}`,
    );
  }
}

/** Caches the HTTP response body of a route (method) or of every route of a controller (class). */
export function HttpCache(options?: HttpCacheOptions): MethodDecorator & ClassDecorator {
  return (target: object, propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => {
    const isClass = propertyKey === undefined;
    const holder = isClass ? (target as { prototype: object }).prototype : target;
    const method = isClass ? '*' : propertyKey;
    validate(holder, method, options);
    const loadOptions: LoadOptions<unknown> = putOptionsOf(options);
    if (options?.lock !== undefined) loadOptions.lock = options.lock;
    const metadata: HttpCacheMetadata = {
      namespace: options?.namespace ?? 'http',
      store: options?.store,
      key: options?.key,
      loadOptions,
      strategy: presetStrategy(loadOptions),
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
