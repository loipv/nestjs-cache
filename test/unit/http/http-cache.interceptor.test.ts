import 'reflect-metadata';
import { Readable } from 'node:stream';
import { Sse, StreamableFile, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  defer,
  from,
  isObservable,
  lastValueFrom,
  of,
  throwError,
  toArray,
  type Observable,
} from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { CacheEngine } from '../../../src/core/cache-engine.js';
import { HttpCache, type HttpCacheOptions } from '../../../src/http/http-cache.decorator.js';
import { HttpCacheInterceptor } from '../../../src/http/http-cache.interceptor.js';
import { CacheModule, HttpCacheInterceptor as Exported } from '../../../src/index.js';
import type { CacheModuleOptions } from '../../../src/module/cache.options.js';
import type { LockHandle } from '../../../src/stores/cache-store.interface.js';
import { makeEngine } from '../helpers/engine.js';
import { FakeLock } from '../helpers/fake-lock.js';
import { FakeStore } from '../helpers/fake-store.js';

interface FakeRequest {
  method: string;
  url: string;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}

type Handler = () => unknown;

interface Route {
  handler: Handler;
  cls: abstract new () => object;
}

function route(options?: HttpCacheOptions): Route {
  class Items {
    @HttpCache(options)
    m(): void {}
  }
  return { handler: Items.prototype.m, cls: Items };
}

function plainRoute(): Route {
  class Plain {
    m(): void {}
  }
  return { handler: Plain.prototype.m, cls: Plain };
}

function setup(options?: CacheModuleOptions) {
  const made = makeEngine(options);
  const adapter = {
    getRequestMethod: vi.fn((req: FakeRequest) => req.method),
    getRequestUrl: vi.fn((req: FakeRequest) => req.url),
  };
  const host = { httpAdapter: adapter } as unknown as HttpAdapterHost;
  const interceptor = new HttpCacheInterceptor(made.engine, new Reflector(), host);
  const errors = () => made.emitted.filter((e) => e.event === 'error');
  const gets = () => made.store.calls.filter((c) => c.op === 'get').length;

  function context(target: Route, req: FakeRequest, type = 'http'): ExecutionContext {
    return {
      getType: () => type,
      getHandler: () => target.handler,
      getClass: () => target.cls,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  /** Mirrors Nest: the handler's sync value, Promise or Observable becomes an Observable. */
  function nextOf(produce: () => unknown): CallHandler & { calls: number } {
    const next = {
      calls: 0,
      handle: (): Observable<unknown> =>
        defer(() => {
          next.calls++;
          const result = produce();
          return isObservable(result) ? result : from(Promise.resolve(result));
        }),
    };
    return next;
  }

  function run(
    target: Route,
    req: FakeRequest,
    next: CallHandler,
    type = 'http',
  ): Promise<unknown> {
    return lastValueFrom(interceptor.intercept(context(target, req, type), next), {
      defaultValue: undefined,
    });
  }

  return { ...made, adapter, interceptor, errors, gets, context, nextOf, run };
}

const get = (url: string, extra: Partial<FakeRequest> = {}): FakeRequest => ({
  method: 'GET',
  url,
  ...extra,
});

describe('HttpCacheInterceptor', () => {
  it('passes through a route without metadata', async () => {
    /* no @HttpCache: the handler runs each time and the store is never read */
    const t = setup();
    const next = t.nextOf(() => ({ a: 1 }));
    await expect(t.run(plainRoute(), get('/items'), next)).resolves.toEqual({ a: 1 });
    await expect(t.run(plainRoute(), get('/items'), next)).resolves.toEqual({ a: 1 });
    expect(next.calls).toBe(2);
    expect(t.gets()).toBe(0);
  });

  it('passes through POST and non-http contexts', async () => {
    /* POST and an rpc context skip the cache entirely */
    const t = setup();
    const target = route();
    const post = t.nextOf(() => 'created');
    await t.run(target, { method: 'POST', url: '/items' }, post);
    await t.run(target, { method: 'POST', url: '/items' }, post);
    expect(post.calls).toBe(2);
    const rpc = t.nextOf(() => 'rpc');
    await t.run(target, get('/items'), rpc, 'rpc');
    await t.run(target, get('/items'), rpc, 'rpc');
    expect(rpc.calls).toBe(2);
    expect(t.gets()).toBe(0);
  });

  it('caches a GET and serves the second call from the cache', async () => {
    /* the first GET loads and writes; the second is a hit */
    const t = setup();
    const target = route({ ttl: 1_000 });
    const next = t.nextOf(() => ({ items: [1, 2] }));
    await expect(t.run(target, get('/items'), next)).resolves.toEqual({ items: [1, 2] });
    await expect(t.run(target, get('/items'), next)).resolves.toEqual({ items: [1, 2] });
    expect(next.calls).toBe(1);
    expect(t.store.data.has('http:/items')).toBe(true);
  });

  it('HEAD shares the GET entry', async () => {
    /* a HEAD after a GET of the same URL is served from the GET entry */
    const t = setup();
    const target = route();
    const next = t.nextOf(() => 'body');
    await t.run(target, get('/items'), next);
    await expect(t.run(target, { method: 'HEAD', url: '/items' }, next)).resolves.toBe('body');
    expect(next.calls).toBe(1);
  });

  it('uses the normalised URL as the default key', async () => {
    /* query order does not matter: both URLs map to /items?a=1&b=2 */
    const t = setup();
    const target = route();
    const next = t.nextOf(() => 'x');
    await t.run(target, get('/items?b=2&a=1'), next);
    await t.run(target, get('/items?a=1&b=2'), next);
    expect(next.calls).toBe(1);
    expect([...t.store.data.keys()]).toEqual(['http:/items?a=1&b=2']);
  });

  it('uses a string key verbatim', async () => {
    /* a fixed key: two different URLs share one entry, under the custom namespace */
    const t = setup();
    const target = route({ key: 'all:items', namespace: 'catalog' });
    const next = t.nextOf(() => 'x');
    await t.run(target, get('/a'), next);
    await t.run(target, get('/b'), next);
    expect(next.calls).toBe(1);
    expect([...t.store.data.keys()]).toEqual(['catalog:all:items']);
  });

  it('passes the key callback an HttpCacheRequest built per spec 3.2', async () => {
    /* method/url from the adapter, path/query parsed from the url, params default {} */
    const t = setup();
    const key = vi.fn(() => 'k');
    const target = route({ key });
    await t.run(
      target,
      get('/items?b=2&a=1&a=0', { headers: { authorization: 'x' } }),
      t.nextOf(() => 1),
    );
    await t.run(
      target,
      get('/users/7', { params: { id: '7' } }),
      t.nextOf(() => 1),
    );
    expect(key).toHaveBeenNthCalledWith(1, {
      method: 'GET',
      url: '/items?b=2&a=1&a=0',
      path: '/items',
      query: { b: '2', a: ['1', '0'] },
      params: {},
      headers: { authorization: 'x' },
    });
    expect(key).toHaveBeenNthCalledWith(2, {
      method: 'GET',
      url: '/users/7',
      path: '/users/7',
      query: {},
      params: { id: '7' },
      headers: {},
    });
  });

  it('a key callback returning undefined skips the cache without an error event', async () => {
    /* undefined means "do not cache this request": no store read, no error */
    const t = setup();
    const target = route({ key: () => undefined });
    const next = t.nextOf(() => 'x');
    await t.run(target, get('/items'), next);
    await t.run(target, get('/items'), next);
    expect(next.calls).toBe(2);
    expect(t.gets()).toBe(0);
    expect(t.errors()).toHaveLength(0);
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('bad key');
      },
    ],
    ['returns an empty string', () => ''],
    ['returns a non-string', () => 5 as unknown as string],
  ])(
    'a key callback that %s reports one key error and still runs the handler',
    async (_name, key) => {
      /* same as @Cacheable: one error event (operation 'key', the route's store), then the handler */
      const t = setup();
      const target = route({ key });
      const next = t.nextOf(() => 'x');
      await expect(t.run(target, get('/items'), next)).resolves.toBe('x');
      expect(next.calls).toBe(1);
      expect(t.gets()).toBe(0);
      expect(t.errors()).toHaveLength(1);
      expect(t.errors()[0]?.payload).toMatchObject({ operation: 'key', store: 'default' });
    },
  );

  it.each([
    ['StreamableFile', () => new StreamableFile(Buffer.from('x'))],
    ['Buffer', () => Buffer.from('x')],
    ['Uint8Array', () => new Uint8Array([1, 2])],
    ['Readable', () => Readable.from(['x'])],
    ['pipe-able object', () => ({ pipe: () => undefined })],
  ])('does not cache a %s', async (_name, produce) => {
    /* the built-in unless keeps files, binary bodies and streams out of the cache */
    const t = setup();
    const target = route();
    const next = t.nextOf(produce);
    await t.run(target, get('/file'), next);
    await t.run(target, get('/file'), next);
    expect(next.calls).toBe(2);
    expect(t.store.data.size).toBe(0);
  });

  it('applies the user unless only after the built-in check', async () => {
    /* a Buffer never reaches the user's unless; other bodies do, and true keeps them out */
    const t = setup();
    const unless = vi.fn((body: unknown) => body === 'skip');
    const target = route({ unless });
    const buffer = t.nextOf(() => Buffer.from('x'));
    await t.run(target, get('/buffer'), buffer);
    expect(unless).not.toHaveBeenCalled();

    const skipped = t.nextOf(() => 'skip');
    await t.run(target, get('/skip'), skipped);
    await t.run(target, get('/skip'), skipped);
    expect(skipped.calls).toBe(2);

    const kept = t.nextOf(() => 'keep');
    await t.run(target, get('/keep'), kept);
    await t.run(target, get('/keep'), kept);
    expect(kept.calls).toBe(1);
    expect(unless).toHaveBeenCalledWith('keep');
    expect(unless).toHaveBeenCalledWith('skip');
  });

  it('caches sync values, Promises and Observables alike; an erroring Observable is not cached and rethrows', async () => {
    /* Review Focus 4: every shape is cached once; a failing Observable reaches the caller each time */
    const t = setup();
    const target = route();
    const shapes: [string, () => unknown][] = [
      ['/sync', () => ({ v: 'sync' })],
      ['/promise', () => Promise.resolve({ v: 'promise' })],
      ['/observable', () => of({ v: 'observable' })],
    ];
    for (const [url, produce] of shapes) {
      const next = t.nextOf(produce);
      const first = await t.run(target, get(url), next);
      await expect(t.run(target, get(url), next)).resolves.toEqual(first);
      expect(next.calls).toBe(1);
    }
    const failing = t.nextOf(() => throwError(() => new Error('boom')));
    await expect(t.run(target, get('/fail'), failing)).rejects.toThrow('boom');
    await expect(t.run(target, get('/fail'), failing)).rejects.toThrow('boom');
    expect(failing.calls).toBe(2);
    expect(t.store.data.has('http:/fail')).toBe(false);
  });

  it('a failing store never fails the request', async () => {
    /* get and set reject: the handler value still reaches the caller, errors go to events */
    const t = setup();
    const target = route();
    t.store.failNext('get');
    t.store.failNext('set');
    await expect(
      t.run(
        target,
        get('/items'),
        t.nextOf(() => 'value'),
      ),
    ).resolves.toBe('value');
    expect(t.errors().map((e) => (e.payload as { operation: string }).operation)).toEqual(
      expect.arrayContaining(['get', 'set']),
    );
  });

  it('reads class-level metadata and lets a method override it', async () => {
    /* handler metadata wins over class metadata; a class-only route uses the class options */
    const t = setup();
    @HttpCache({ namespace: 'cls' })
    class Items {
      a(): void {}
      @HttpCache({ namespace: 'method' })
      b(): void {}
    }
    await t.run(
      { handler: Items.prototype.a, cls: Items },
      get('/a'),
      t.nextOf(() => 1),
    );
    await t.run(
      { handler: Items.prototype.b, cls: Items },
      get('/b'),
      t.nextOf(() => 2),
    );
    expect([...t.store.data.keys()].sort()).toEqual(['cls:/a', 'method:/b']);
  });

  it('a nested run for the same request passes through', { timeout: 2_000 }, async () => {
    /* F-1: the interceptor applied twice (class + method, or APP_INTERCEPTOR + route): the inner run must not join the outer flight */
    const t = setup();
    const target = route();
    const req = get('/items');
    const handler = t.nextOf(() => ({ a: 1 }));
    const outer: CallHandler = {
      handle: () => t.interceptor.intercept(t.context(target, req), handler),
    };
    await expect(t.run(target, req, outer)).resolves.toEqual({ a: 1 });
    expect(handler.calls).toBe(1);
    expect([...t.store.data.keys()]).toEqual(['http:/items']);
    expect(t.gets()).toBe(1);
    // The mark is cleared once the load settled: the same request object is cached normally again.
    await expect(t.run(target, req, outer)).resolves.toEqual({ a: 1 });
    expect(handler.calls).toBe(1);
    expect(t.gets()).toBe(2);
  });

  it(
    'a nested run during a background refresh passes through and stores the fresh body',
    { timeout: 2_000 },
    async () => {
      /* F-1: a locked swr refresh calls the outer loader after the response settled; the inner run must not answer with the stale entry */
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        // A lock that answers after a macrotask, like a Redis round trip: the refresh load starts after the response settled.
        class SlowLock extends FakeLock {
          override async acquire(key: string, ttlMs: number): Promise<LockHandle | undefined> {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return super.acquire(key, ttlMs);
          }
        }
        const t = setup({
          stores: { default: Object.assign(new FakeStore(), { lock: new SlowLock() }) },
        });
        const target = route({ ttl: 1_000, strategy: 'swr', staleTtl: 60_000, lock: true });
        const req = get('/items');
        let n = 0;
        const handler = t.nextOf(() => ({ n: ++n }));
        const outer: CallHandler = {
          handle: () => t.interceptor.intercept(t.context(target, req), handler),
        };
        await expect(t.run(target, req, outer)).resolves.toEqual({ n: 1 });
        vi.setSystemTime(Date.now() + 2_000);
        await expect(t.run(target, req, outer)).resolves.toEqual({ n: 1 });
        await vi.waitFor(() => {
          expect(handler.calls).toBe(2);
        });
        await vi.waitFor(async () => {
          await expect(
            t.run(
              target,
              get('/items'),
              t.nextOf(() => 'unused'),
            ),
          ).resolves.toEqual({
            n: 2,
          });
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('passes an @Sse() route through untouched and stores nothing', async () => {
    /* F-2: a class-level @HttpCache must not buffer a server-sent event stream down to its last event */
    const t = setup();
    @HttpCache()
    class Events {
      @Sse('events')
      stream(): void {}
    }
    const target = { handler: Events.prototype.stream, cls: Events };
    const next = t.nextOf(() => of({ data: 1 }, { data: 2 }, { data: 3 }));
    const events = await lastValueFrom(
      t.interceptor.intercept(t.context(target, get('/events')), next).pipe(toArray()),
    );
    expect(events).toEqual([{ data: 1 }, { data: 2 }, { data: 3 }]);
    expect(next.calls).toBe(1);
    expect(t.gets()).toBe(0);
    expect(t.store.data.size).toBe(0);
  });

  it('is exported and resolves through CacheModule', async () => {
    /* D1: CACHE_ENGINE, Reflector and HttpAdapterHost are injected by Nest */
    expect(Exported).toBe(HttpCacheInterceptor);
    const moduleRef = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ stores: { default: new FakeStore() } })],
      providers: [HttpCacheInterceptor],
    }).compile();
    const interceptor = moduleRef.get(HttpCacheInterceptor);
    expect(interceptor).toBeInstanceOf(HttpCacheInterceptor);
    expect((interceptor as unknown as { engine: CacheEngine }).engine).toBeDefined();
    await moduleRef.close();
  });
});
