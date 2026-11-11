import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Put,
  type INestApplication,
} from '@nestjs/common';
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CacheConfigError,
  CacheEvict,
  CacheModule,
  CacheService,
  HttpCache,
  HttpCacheInterceptor,
  type HttpCacheRequest,
} from '../../../src/index.js';

@Injectable()
class Counter {
  calls = 0;
  next(): number {
    this.calls += 1;
    return this.calls;
  }
}

@Controller()
class ItemsController {
  constructor(@Inject(Counter) private readonly counter: Counter) {}

  @Get('items')
  @HttpCache({ namespace: 'users', ttl: 60_000 })
  list(): { n: number } {
    return { n: this.counter.next() };
  }

  @Get('slow')
  @HttpCache({ ttl: 60_000 })
  async slow(): Promise<{ n: number }> {
    const n = this.counter.next();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { n };
  }

  @Get('users/:id')
  @HttpCache({
    namespace: 'users',
    ttl: 60_000,
    key: (req: HttpCacheRequest) => `user:${req.params.id ?? ''}`,
  })
  user(@Param('id') id: string): { id: string; n: number } {
    return { id, n: this.counter.next() };
  }

  @Get('path/:id')
  @HttpCache({ ttl: 60_000 })
  byPath(@Param('id') id: string): { id: string; n: number } {
    return { id, n: this.counter.next() };
  }

  @Put('items')
  @CacheEvict({ namespace: 'users', allEntries: true })
  async replace(): Promise<{ ok: true }> {
    return Promise.resolve({ ok: true });
  }

  @Put('users/:id')
  @CacheEvict({ namespace: 'users', key: 'user:{0}' })
  async updateUser(@Param('id') id: string): Promise<{ id: string }> {
    return Promise.resolve({ id });
  }

  @Post('items')
  @HttpCache({ ttl: 60_000 })
  create(@Body() body: unknown): { n: number; body: unknown } {
    return { n: this.counter.next(), body };
  }

  @Get('status')
  @HttpCache({ ttl: 60_000 })
  @HttpCode(203)
  @Header('x-a', '1')
  status(): { n: number } {
    return { n: this.counter.next() };
  }

  @Get('plain')
  plain(): { n: number } {
    return { n: this.counter.next() };
  }

  @Get('private')
  @HttpCache({
    ttl: 60_000,
    key: (req: HttpCacheRequest) => (req.headers.authorization ? undefined : req.url),
  })
  privateRoute(): { n: number } {
    return { n: this.counter.next() };
  }
}

@HttpCache({ ttl: 60_000 })
@Controller('klass')
class ClassController {
  constructor(@Inject(Counter) private readonly counter: Counter) {}

  @Get('a')
  a(): { n: number } {
    return { n: this.counter.next() };
  }

  @Get('b')
  b(): { n: number } {
    return { n: this.counter.next() };
  }

  @Post('c')
  c(): { n: number } {
    return { n: this.counter.next() };
  }
}

/** Class-level and method-level @HttpCache: Nest applies the interceptor twice to `both`. */
@HttpCache({ namespace: 'klass', ttl: 60_000 })
@Controller('twice')
class TwiceController {
  constructor(@Inject(Counter) private readonly counter: Counter) {}

  @Get('both')
  @HttpCache({ namespace: 'method', ttl: 60_000 })
  both(): { n: number } {
    return { n: this.counter.next() };
  }
}

@Controller('global')
class GlobalController {
  constructor(@Inject(Counter) private readonly counter: Counter) {}

  @Get('route')
  @HttpCache({ ttl: 60_000 })
  route(): { n: number } {
    return { n: this.counter.next() };
  }
}

/** A fresh module per app: forRoot builds its memory store once, so a shared one would leak entries. */
function makeAppModule(): new () => object {
  @Module({
    imports: [CacheModule.forRoot({ isGlobal: true, namespaces: { users: { versioned: true } } })],
    controllers: [ItemsController, ClassController, TwiceController],
    providers: [Counter],
  })
  class AppModule {}
  return AppModule;
}

/** HttpCacheInterceptor registered globally as well as by the route's @HttpCache. */
function makeGlobalInterceptorModule(): new () => object {
  @Module({
    imports: [CacheModule.forRoot({ isGlobal: true })],
    controllers: [GlobalController],
    providers: [Counter, { provide: APP_INTERCEPTOR, useClass: HttpCacheInterceptor }],
  })
  class GlobalInterceptorModule {}
  return GlobalInterceptorModule;
}

describe.each(['express', 'fastify'] as const)('HttpCache end to end on %s', (kind) => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function adapter(): ExpressAdapter | FastifyAdapter {
    return kind === 'express' ? new ExpressAdapter() : new FastifyAdapter();
  }

  async function start(
    module: new () => object = makeAppModule(),
  ): Promise<{ base: string; counter: Counter; cache: CacheService }> {
    const created = await NestFactory.create(module, adapter(), { logger: false });
    app = created;
    await created.init();
    await created.listen(0, '127.0.0.1');
    const base = (await created.getUrl()).replace('[::1]', '127.0.0.1');
    return { base, counter: created.get(Counter), cache: created.get(CacheService) };
  }

  async function json(url: string, init?: RequestInit): Promise<{ n: number; id?: string }> {
    const res = await fetch(url, init);
    return (await res.json()) as { n: number; id?: string };
  }

  it('hit and miss', async () => {
    /* the second GET is served from the cache; the handler ran once */
    const { base, counter } = await start();
    const first = await json(`${base}/items`);
    const second = await json(`${base}/items`);
    expect(second).toEqual(first);
    expect(counter.calls).toBe(1);
  });

  it('query order shares one entry', async () => {
    /* ?a=1&b=2 and ?b=2&a=1 normalize to one key */
    const { base, counter } = await start();
    await json(`${base}/path/x?a=1&b=2`);
    await json(`${base}/path/x?b=2&a=1`);
    expect(counter.calls).toBe(1);
    await json(`${base}/path/x?a=1&b=3`);
    expect(counter.calls).toBe(2);
  });

  it('path params make distinct entries', async () => {
    /* /path/1 and /path/2 do not collide; repeating one hits */
    const { base, counter } = await start();
    const one = await json(`${base}/path/1`);
    const two = await json(`${base}/path/2`);
    expect(one.id).toBe('1');
    expect(two.id).toBe('2');
    await json(`${base}/path/1`);
    expect(counter.calls).toBe(2);
  });

  it('POST is not cached', async () => {
    /* two identical POSTs both run the handler */
    const { base, counter } = await start();
    const post = (): Promise<{ n: number }> =>
      json(`${base}/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a: 1 }),
      });
    const first = await post();
    const second = await post();
    expect(second.n).not.toBe(first.n);
    expect(counter.calls).toBe(2);
  });

  it("@CacheEvict({ namespace: 'users', allEntries: true }) on a PUT clears the list route", async () => {
    /* a PUT that evicts the namespace makes the next GET /items run the handler again */
    const { base, counter } = await start();
    await json(`${base}/items`);
    await json(`${base}/items`);
    expect(counter.calls).toBe(1);
    expect((await fetch(`${base}/items`, { method: 'PUT' })).status).toBe(200);
    await json(`${base}/items`);
    expect(counter.calls).toBe(2);
  });

  it("@CacheEvict({ namespace: 'users', key: 'user:{0}' }) clears the entry keyed by a callback", async () => {
    /* only user 1's entry is evicted; user 2 stays cached */
    const { base, counter } = await start();
    await json(`${base}/users/1`);
    await json(`${base}/users/2`);
    await json(`${base}/users/1`);
    await json(`${base}/users/2`);
    expect(counter.calls).toBe(2);
    await fetch(`${base}/users/1`, { method: 'PUT' });
    await json(`${base}/users/1`);
    expect(counter.calls).toBe(3);
    await json(`${base}/users/2`);
    expect(counter.calls).toBe(3);
  });

  it("@HttpCode(203) and @Header('x-a', '1') survive a cache hit", async () => {
    /* the cached response keeps the decorated status and header */
    const { base, counter } = await start();
    const first = await fetch(`${base}/status`);
    await first.text();
    const second = await fetch(`${base}/status`);
    await second.text();
    expect(counter.calls).toBe(1);
    for (const res of [first, second]) {
      expect(res.status).toBe(203);
      expect(res.headers.get('x-a')).toBe('1');
    }
  });

  it('a route without @HttpCache is never cached', async () => {
    /* the interceptor is opt-in per route */
    const { base, counter } = await start();
    await json(`${base}/plain`);
    await json(`${base}/plain`);
    expect(counter.calls).toBe(2);
  });

  it('ten concurrent cold GETs run the handler once', async () => {
    /* single-flight: ten simultaneous misses share one load and one body */
    const { base, counter } = await start();
    const bodies = await Promise.all(Array.from({ length: 10 }, () => json(`${base}/slow`)));
    expect(counter.calls).toBe(1);
    expect(new Set(bodies.map((b) => b.n))).toEqual(new Set([1]));
  });

  it('class-level @HttpCache caches GET routes and never POST', async () => {
    /* GET a and b are cached, POST c runs every time */
    const { base, counter } = await start();
    await json(`${base}/klass/a`);
    await json(`${base}/klass/a`);
    await json(`${base}/klass/b`);
    await json(`${base}/klass/b`);
    expect(counter.calls).toBe(2);
    await json(`${base}/klass/c`, { method: 'POST' });
    await json(`${base}/klass/c`, { method: 'POST' });
    expect(counter.calls).toBe(4);
  });

  it('a key callback skips requests with authorization', async () => {
    /* authorized requests run the handler each time; anonymous ones are cached */
    const { base, counter } = await start();
    await json(`${base}/private`, { headers: { authorization: 'Bearer a' } });
    await json(`${base}/private`, { headers: { authorization: 'Bearer b' } });
    expect(counter.calls).toBe(2);
    await json(`${base}/private`);
    await json(`${base}/private`);
    expect(counter.calls).toBe(3);
  });

  it('class-level and method-level @HttpCache on one route run the cache once', async () => {
    /* F-1: the interceptor runs twice; the nested run passes through instead of joining its own flight (no hang) */
    const { base, counter, cache } = await start();
    const first = await json(`${base}/twice/both`, { signal: AbortSignal.timeout(2_000) });
    const second = await json(`${base}/twice/both`, { signal: AbortSignal.timeout(2_000) });
    expect(first).toEqual({ n: 1 });
    expect(second).toEqual(first);
    expect(counter.calls).toBe(1);
    await expect(cache.get('/twice/both', { namespace: 'method' })).resolves.toEqual({ n: 1 });
    await expect(cache.get('/twice/both', { namespace: 'klass' })).resolves.toBeUndefined();
  });

  it('APP_INTERCEPTOR HttpCacheInterceptor plus @HttpCache on a route run the cache once', async () => {
    /* F-1: the global and the route-level instances both run; only the outer one caches */
    const { base, counter } = await start(makeGlobalInterceptorModule());
    const first = await json(`${base}/global/route`, { signal: AbortSignal.timeout(2_000) });
    const second = await json(`${base}/global/route`, { signal: AbortSignal.timeout(2_000) });
    expect(first).toEqual({ n: 1 });
    expect(second).toEqual(first);
    expect(counter.calls).toBe(1);
  });

  it('an unknown store fails app.init() with CacheConfigError naming @HttpCache', async () => {
    /* startup validation rejects a store that is not registered */
    @Controller()
    class BadController {
      @Get('bad')
      @HttpCache({ store: 'nope' })
      bad(): string {
        return 'x';
      }
    }
    @Module({
      imports: [CacheModule.forRoot({ isGlobal: true })],
      controllers: [BadController],
    })
    class BadModule {}

    const created = await NestFactory.create(BadModule, adapter(), {
      logger: false,
      abortOnError: false,
    });
    app = created;
    const failure: unknown = await created.init().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CacheConfigError);
    expect((failure as Error).message).toContain('@HttpCache');
  });
});
