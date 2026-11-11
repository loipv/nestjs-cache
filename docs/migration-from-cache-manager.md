# Migrating from `@nestjs/cache-manager`

This guide moves a NestJS app from `@nestjs/cache-manager` (with `cache-manager` and, usually, Keyv) to
`@loipv/nestjs-cache`. The "before" snippets show `@nestjs/cache-manager` code. The "after" snippets are type-checked
against this library in CI.

TTLs are milliseconds in both libraries, so numbers carry over unchanged.

## API mapping

| `@nestjs/cache-manager`                            | `@loipv/nestjs-cache`                                            |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| `CacheModule.register(options)`                    | `CacheModule.forRoot(options)`                                   |
| `CacheModule.registerAsync(options)`               | `CacheModule.forRootAsync(options)`                              |
| `isGlobal: true`                                   | `isGlobal: true`                                                 |
| `ttl` (module option)                              | `defaults.ttl`                                                   |
| `stores: [new Keyv(...)]`                          | `stores: { default: redisStore({ client }) }` (named stores)     |
| `@Inject(CACHE_MANAGER) cache: Cache`              | `CacheService` (inject by class)                                 |
| `cache.get(key)`                                   | `cache.get(key)`                                                 |
| `cache.set(key, value, ttl)`                       | `cache.set(key, value, { ttl })`                                 |
| `cache.del(key)`                                   | `cache.delete(key)`                                              |
| `cache.clear()` (whole store)                      | `cache.clear(namespace)` (one namespace, or O(1) when versioned) |
| `cache.wrap(key, fn, ttl)`                         | `cache.getOrSet(key, fn, { ttl })`                               |
| `@UseInterceptors(CacheInterceptor)`               | `@HttpCache()`                                                   |
| `@CacheKey('k')`                                   | `@HttpCache({ key: 'k' })`                                       |
| `@CacheTTL(ms)`                                    | `@HttpCache({ ttl: ms })`                                        |
| `APP_INTERCEPTOR` with `CacheInterceptor` (global) | No equivalent. Add `@HttpCache()` to the routes you want cached  |
| `CACHE_MANAGER` token                              | None. Inject `CacheService`                                      |

Things this library adds that have no counterpart in cache-manager: `@Cacheable`, `@CachePut` and `@CacheEvict` for
service methods, single-flight loading, the cross-instance `lock`, `swr` and `sliding` strategies, a two-tier store,
a circuit breaker, events and Prometheus metrics.

## Why `@HttpCache` is opt-in

`@nestjs/cache-manager` caches every `GET` once you register `CacheInterceptor` globally, and its default key is the
request URL. A route whose response depends on who is asking (a profile, a cart, anything behind authentication) is
then served from one user's entry to the next user. This is a common source of data leaks.

`@HttpCache` caches only the routes you decorate, and nothing else. You decide per route, and you can derive the key
from the request (see below) or skip the cache for some requests. For that reason there is no global interceptor mode,
no `CACHE_MANAGER` token and no `@CacheKey` or `@CacheTTL`.

## Keys and stored values are different

Data written by cache-manager is not readable by this library. The key format differs (this library writes
`<prefix>:<namespace>:<key>`) and so does the stored value, which is wrapped in an envelope. Nothing breaks, but the
cache starts cold after the switch.

If cache-manager and this library might share a Redis during a rolling deploy, give this library its own `prefix` so
the two never touch the same keys. You can drop the old keys after the rollout.

## Module registration

Before:

```ts
import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';

@Module({
  imports: [CacheModule.register({ isGlobal: true, ttl: 60_000 })],
})
export class AppModule {}
```

After:

```ts
import { Module } from '@nestjs/common';
import { CacheModule } from '@loipv/nestjs-cache';

@Module({
  imports: [CacheModule.forRoot({ isGlobal: true, defaults: { ttl: 60_000 } })],
})
export class AppModule {}
```

Async registration. Before:

```ts
CacheModule.registerAsync({
  isGlobal: true,
  useFactory: () => ({ ttl: Number(process.env.CACHE_TTL) }),
});
```

After:

```ts
import { CacheModule } from '@loipv/nestjs-cache';

export const asyncCacheModule = CacheModule.forRootAsync({
  isGlobal: true,
  useFactory: () => ({ defaults: { ttl: Number(process.env.CACHE_TTL) } }),
});
```

## The Redis store

Before (Keyv):

```ts
import { CacheModule } from '@nestjs/cache-manager';
import { createKeyv } from '@keyv/redis';

CacheModule.registerAsync({
  isGlobal: true,
  useFactory: () => ({ stores: [createKeyv('redis://localhost:6379')] }),
});
```

After. You create and close the Redis client yourself; the library does not own it.

```ts
import { Redis } from 'ioredis';
import {
  CacheModule,
  ioredisAdapter,
  memoryStore,
  redisStore,
  tieredStore,
} from '@loipv/nestjs-cache';

const redis = new Redis('redis://localhost:6379');

export const redisCacheModule = CacheModule.forRoot({
  isGlobal: true,
  prefix: 'myapp-v2',
  stores: {
    default: redisStore({ client: ioredisAdapter(redis) }),
  },
});

// Optional: an in-memory L1 in front of Redis, kept in sync over Pub/Sub.
export const tieredCacheModule = CacheModule.forRoot({
  isGlobal: true,
  prefix: 'myapp-v2',
  stores: {
    default: tieredStore({
      l1: memoryStore({ maxEntries: 5_000 }),
      l2: redisStore({ client: ioredisAdapter(redis) }),
      l1Ttl: 10_000,
    }),
  },
});
```

`prefix: 'myapp-v2'` is the new prefix suggested above. With node-redis use `nodeRedisAdapter(client)`.

## Using the cache manager directly

Before:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

@Injectable()
export class ProfileService {
  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  async run(id: string): Promise<void> {
    await this.cache.set(`profile:${id}`, { id }, 30_000);
    const hit = await this.cache.get<{ id: string }>(`profile:${id}`);
    await this.cache.del(`profile:${id}`);
    await this.cache.clear();
  }
}
```

After:

```ts
import { Injectable } from '@nestjs/common';
import { CacheService } from '@loipv/nestjs-cache';

@Injectable()
export class ProfileService {
  constructor(private readonly cache: CacheService) {}

  async run(id: string): Promise<{ id: string } | undefined> {
    await this.cache.set(`profile:${id}`, { id }, { namespace: 'profiles', ttl: 30_000 });
    const hit = await this.cache.get<{ id: string }>(`profile:${id}`, { namespace: 'profiles' });
    await this.cache.delete(`profile:${id}`, { namespace: 'profiles' });
    await this.cache.clear('profiles');
    return hit;
  }
}
```

Differences to know about:

- `clear` takes a namespace. cache-manager's `clear()` empties the whole store; here you clear one namespace. Mark it
  `versioned` (module option `namespaces: { profiles: { versioned: true } }`) to make `clear` O(1) on Redis.
- `get` returns `undefined` on a miss. A stored `null` is only kept when `cacheNull` is on.
- `cache.wrap(key, fn, ttl)` becomes `cache.getOrSet(key, fn, { ttl })`, which also coalesces concurrent misses.

## HTTP caching: `CacheInterceptor`, `@CacheKey` and `@CacheTTL`

Before:

```ts
import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { CacheInterceptor, CacheKey, CacheTTL } from '@nestjs/cache-manager';

// Registered per controller here. The alternative is one global registration in the module:
// { provide: APP_INTERCEPTOR, useClass: CacheInterceptor } (then drop @UseInterceptors).
@Controller('articles')
@UseInterceptors(CacheInterceptor)
export class ArticlesController {
  @Get()
  @CacheKey('articles')
  @CacheTTL(30_000)
  list(): string[] {
    return [];
  }
}
```

After:

```ts
import { Controller, Get } from '@nestjs/common';
import { HttpCache } from '@loipv/nestjs-cache';

@Controller('articles')
export class ArticlesController {
  @Get()
  @HttpCache({ ttl: 30_000, key: 'articles' })
  list(): string[] {
    return [];
  }
}
```

`@HttpCache` can also sit on the controller class. Method options replace class options entirely; they are not
merged. `CacheModule` must be global or imported into the module that holds the controller.

A route whose response depends on the caller needs a key that says so, or no caching for that caller:

```ts
import { Controller, Get, Param } from '@nestjs/common';
import { HttpCache } from '@loipv/nestjs-cache';

@Controller('catalog')
export class CatalogController {
  // The default key is the URL with the query sorted: /catalog?b=2&a=1 is stored as /catalog?a=1&b=2.
  @Get()
  @HttpCache({ ttl: 60_000, namespace: 'catalog' })
  list(): string[] {
    return [];
  }

  // Authenticated requests skip the cache; anonymous ones share an entry.
  @Get('featured')
  @HttpCache({ key: (req) => (req.headers.authorization ? undefined : req.defaultKey) })
  featured(): string[] {
    return [];
  }

  // One entry per record, so a write can evict exactly that record.
  @Get(':id')
  @HttpCache({ namespace: 'catalog', key: (req) => `item:${req.params.id}` })
  item(@Param('id') id: string): { id: string } {
    return { id };
  }
}
```

`req.defaultKey` is the key `@HttpCache` uses when `key` is not set (the normalised URL above).

Behaviour to check against what you rely on today:

- Only `GET` and `HEAD` are cached (`HEAD` shares the `GET` entry). Other methods pass through.
- The default key varies only on the path and the query, not on the host (for example `@Controller({ host })`
  multi-tenant routes), headers such as `Accept`, `Accept-Language` or a version header, or cookies. Anything else that
  changes the body must go into a key callback, or the route must not be cached.
- Callback keys are not escaped: with `escapeKeyArgs: true`, `@CacheEvict({ key: 'user:{0}' })` escapes `:` and `%`
  in the id but ``(req) => `user:${req.params.id}` `` does not, so build both keys the same way, for example
  ``@CacheEvict({ key: (id: string) => `user:${id}` })``.
- Only the handler's return value (the body) is cached. `StreamableFile`, `Buffer`, `Uint8Array` and streams are
  never cached, and a handler that returns `undefined` is not cached, so routes that use `@Res()` are not supported.
- Do not put `@HttpCache` on routes that return `StreamableFile` or streams: they are never stored, but concurrent
  requests coalesced by single-flight would share one stream instance.
- `@HttpCode` and `@Header` still apply on a hit. The library adds no response headers and ignores the request
  `Cache-Control`; it is a server-side cache. cache-manager's `X-Cache: HIT` / `MISS` response header is not set, so
  anything that reads it (tests, dashboards) needs another signal, such as the `hit` and `miss` events.
- Errors from the handler, including `HttpException`, reach your exception filters and are not cached. Cache and
  store errors never reach the client: they emit an `error` event and the handler runs.
- Express and Fastify are both supported.

## Invalidating after a write

cache-manager has no decorator for this. Here a mutation evicts with `@CacheEvict`:

```ts
import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { CacheEvict, CacheModule, HttpCache } from '@loipv/nestjs-cache';

export const usersCacheModule = CacheModule.forRoot({
  isGlobal: true,
  namespaces: { users: { versioned: true } },
});

@Controller('users')
export class UsersController {
  @Get()
  @HttpCache({ namespace: 'users', ttl: 60_000 })
  list(): string[] {
    return [];
  }

  @Get(':id')
  @HttpCache({ namespace: 'users', key: (req) => `user:${req.params.id}` })
  find(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @CacheEvict({ namespace: 'users', allEntries: true })
  create(@Body() body: { name: string }): Promise<{ name: string }> {
    return Promise.resolve(body);
  }

  @Delete(':id')
  @CacheEvict({ namespace: 'users', key: 'user:{0}' })
  remove(@Param('id') id: string): Promise<void> {
    return Promise.resolve(id).then(() => undefined);
  }
}
```

List routes live in a namespace, and a mutation clears it (O(1) when the namespace is versioned). Single-record routes
use a key you can name, and the mutation evicts that key; the `{0}` template reads the first parameter, which is why
`@Param('id') id` comes first.

## Rollout checklist

1. Swap `CacheModule.register` for `forRoot`, and `CACHE_MANAGER` for `CacheService`.
2. Set a new `prefix` if the old and new code run side by side on one Redis.
3. Replace the global interceptor with `@HttpCache()` on the routes that are safe to share between users.
4. Expect a cold cache after the deploy.
