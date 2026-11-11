import {
  Inject,
  Injectable,
  StreamableFile,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { CacheEngine, LoadOptions } from '../core/cache-engine.js';
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

/** The route's load options with the built-in `unless` first, then the user's. */
function withBuiltInUnless(options: LoadOptions<unknown>): LoadOptions<unknown> {
  const user = options.unless;
  return {
    ...options,
    unless: (body) => isUncacheable(body) || user?.(body) === true,
  };
}

/** Caches GET/HEAD response bodies of routes marked with `@HttpCache`; other requests pass through. */
@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  private readonly loadOptions = new WeakMap<HttpCacheMetadata, LoadOptions<unknown>>();

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
    const req: unknown = context.switchToHttp().getRequest();
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
        () => lastValueFrom(next.handle(), { defaultValue: undefined }),
        this.loadOptionsOf(metadata),
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

  private loadOptionsOf(metadata: HttpCacheMetadata): LoadOptions<unknown> {
    let options = this.loadOptions.get(metadata);
    if (options === undefined) {
      options = withBuiltInUnless(metadata.loadOptions);
      this.loadOptions.set(metadata, options);
    }
    return options;
  }
}

function toHttpCacheRequest(req: unknown, method: string, url: string): HttpCacheRequest {
  const raw = req as RawRequest;
  const { path, query } = parseHttpUrl(url);
  return { method, url, path, query, params: raw.params ?? {}, headers: raw.headers ?? {} };
}
