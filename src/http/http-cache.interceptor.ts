import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants.js';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { CacheEngine } from '../core/cache-engine.js';
import { emptyKeyError, isEmptyKey } from '../core/key-builder.js';
import { CACHE_ENGINE } from '../module/tokens.js';
import {
  HTTP_CACHE_METADATA,
  type HttpCacheMetadata,
  type HttpCacheRequest,
} from './http-cache.decorator.js';
import { httpCacheKey, parseHttpUrl } from './http-cache-key.js';

interface RawRequest {
  params?: Record<string, string>;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Requests whose `@HttpCache` load is running. Nest does not de-duplicate interceptors: a class-level
 * and a method-level `@HttpCache`, or an `APP_INTERCEPTOR` plus a route's `@HttpCache`, run this
 * interceptor twice per request. The inner run is invoked from the outer run's load and must pass
 * through, or its `getOrSet` would join the outer flight and wait for itself. Module-level because
 * the global and the route-level interceptors are different instances.
 */
const loading = new WeakSet<object>();

/** Caches GET/HEAD response bodies of routes marked with `@HttpCache`; other requests pass through. */
@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  constructor(
    @Inject(CACHE_ENGINE) private readonly engine: CacheEngine,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const metadata = this.reflector.getAllAndOverride<HttpCacheMetadata | undefined>(
      HTTP_CACHE_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (metadata === undefined) return next.handle();
    // A server-sent event route streams many values; caching would buffer it down to the last one.
    if (this.reflector.get<boolean | undefined>(SSE_METADATA, context.getHandler()) === true) {
      return next.handle();
    }
    const req: unknown = context.switchToHttp().getRequest();
    if (isObject(req) && loading.has(req)) return next.handle();
    const adapter = this.adapterHost.httpAdapter;
    const method = adapter.getRequestMethod(req) as string;
    if (method !== 'GET' && method !== 'HEAD') return next.handle();
    const url = adapter.getRequestUrl(req) as string;

    let key: string | undefined;
    try {
      key = this.keyOf(metadata, req, method, url);
    } catch (error) {
      this.engine.reportError(metadata.store, 'key', error);
      return next.handle();
    }
    if (key === undefined) return next.handle();

    const { store, namespace, strategy } = metadata;
    return from(
      this.engine.getOrSet(
        { store, namespace, key },
        () => load(req, next),
        metadata.loadOptions,
        strategy,
      ),
    );
  }

  /** The cache key per spec 3.2; `undefined` skips the cache, a throw is a key error. */
  private keyOf(
    metadata: HttpCacheMetadata,
    req: unknown,
    method: string,
    url: string,
  ): string | undefined {
    const spec = metadata.key;
    if (spec === undefined) return httpCacheKey(url);
    if (typeof spec === 'string') return spec;
    const key: unknown = spec(toHttpCacheRequest(req, method, url));
    if (key === undefined) return undefined;
    if (typeof key !== 'string') {
      throw new TypeError(`HttpCache key callback returned ${typeof key}, expected a string`);
    }
    if (isEmptyKey(key)) throw emptyKeyError();
    return key;
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** Runs the rest of the chain with `req` marked as loading, so a nested run of this interceptor passes through. */
async function load(req: unknown, next: CallHandler): Promise<unknown> {
  if (!isObject(req)) return lastValueFrom(next.handle(), { defaultValue: undefined });
  loading.add(req);
  try {
    return await lastValueFrom(next.handle(), { defaultValue: undefined });
  } finally {
    loading.delete(req);
  }
}

function toHttpCacheRequest(req: unknown, method: string, url: string): HttpCacheRequest {
  const raw = req as RawRequest;
  const { path, query } = parseHttpUrl(url);
  return {
    method,
    url,
    defaultKey: httpCacheKey(url),
    path,
    query,
    params: raw.params ?? {},
    headers: raw.headers ?? {},
  };
}
