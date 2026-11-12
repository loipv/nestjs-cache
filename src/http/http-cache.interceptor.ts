import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants.js';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import { defer, finalize, from, lastValueFrom, type Observable } from 'rxjs';
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

/**
 * Requests an outer run decided not to cache (the key callback returned `undefined` or threw) and
 * is passing through. The nested run passes through too, without calling the key callback again
 * (a throwing callback would report a second `key` error). Cleared once the pass-through settles.
 */
const passing = new WeakSet<object>();

/**
 * Caches GET/HEAD response bodies of routes marked with `@HttpCache`; other requests pass through.
 *
 * Created by Nest; inject it, do not construct it. Constructor parameters are not part of the
 * public API.
 */
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
    if (isObject(req) && (loading.has(req) || passing.has(req))) return next.handle();
    const adapter = this.adapterHost.httpAdapter;
    const method = adapter.getRequestMethod(req) as string;
    if (method !== 'GET' && method !== 'HEAD') return next.handle();
    const url = adapter.getRequestUrl(req) as string;

    let key: string | undefined;
    try {
      key = this.keyOf(metadata, req, method, url);
    } catch (error) {
      this.engine.reportError(metadata.store, 'key', error);
      return passThrough(req, next);
    }
    if (key === undefined) return passThrough(req, next);

    const { store, namespace, strategy, tags } = metadata;
    // A tags callback gets the body and the request, once the body is to be written.
    const options =
      tags === undefined
        ? metadata.loadOptions
        : {
            ...metadata.loadOptions,
            tags: (body: unknown) => tags(body, toHttpCacheRequest(req, method, url)),
          };
    // Lazy: nothing reads the store or runs the handler before the caller subscribes.
    return defer(() =>
      from(
        this.engine.getOrSet({ store, namespace, key }, () => load(req, next), options, strategy),
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

/**
 * Runs the rest of the chain with `req` marked as passing through, so a nested run passes through
 * without calling the key callback again.
 */
function passThrough(req: unknown, next: CallHandler): Observable<unknown> {
  if (!isObject(req)) return next.handle();
  return defer(() => {
    passing.add(req);
    return next.handle().pipe(finalize(() => passing.delete(req)));
  });
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
