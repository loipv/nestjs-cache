# @loipv/nestjs-cache

Multi-store, two-tier cache for NestJS with decorators, stampede protection and null caching.

- `@Cacheable`, `@CachePut` and `@CacheEvict` decorators, plus a `CacheService` for direct calls.
- `@HttpCache` for opt-in caching of controller routes (Express and Fastify).
- Named stores: in-memory, Redis (ioredis or node-redis, standalone, Cluster or Sentinel) and a two-tier L1/L2 store synced over Pub/Sub.
- Concurrent misses on the same key are coalesced into one load (per process), or across instances with the optional distributed lock.
- Expiry strategies: `fixed`, `swr` (stale-while-revalidate) and `sliding`.
- Per-store circuit breaker for Redis outages.
- Optional gzip or brotli compression of large payloads (`compressedSerializer`).
- Optional null caching and TTL jitter, both off by default.
- No runtime dependencies. Dual ESM and CommonJS build.

## Install

```bash
npm install @loipv/nestjs-cache
```

Peer dependencies: `@nestjs/common`, `@nestjs/core` (`^11 || ^12`) and `reflect-metadata` (`^0.2`).
`ioredis` (`^5 || ^6`) and `redis` (`^5 || ^6`, node-redis) are optional peers; install the one you use for the Redis store.

## Quick start

With no options the module uses an in-memory store named `default`. No Redis is needed.

```ts
import { Injectable, Module } from '@nestjs/common';
import { CacheModule, Cacheable } from '@loipv/nestjs-cache';

@Injectable()
export class UserService {
  @Cacheable({ namespace: 'users', key: 'user:{0}', ttl: 60_000 })
  async findById(id: string): Promise<{ id: string } | null> {
    return { id }; // for example, a database call
  }
}

@Module({
  imports: [CacheModule.forRoot({ isGlobal: true })],
  providers: [UserService],
})
export class AppModule {}
```

With memory only, the cache is private to each process: it is not shared between instances and is lost on restart.
All durations are in milliseconds and must be finite numbers greater than 0.

## Redis and two-tier setup

You create and close the Redis client yourself. The library only opens one extra connection with
`client.duplicate()` for Pub/Sub and closes it on shutdown.

```ts
import Redis from 'ioredis';
import { CacheModule, memoryStore, redisStore, tieredStore } from '@loipv/nestjs-cache';

CacheModule.forRootAsync({
  isGlobal: true,
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const redis = new Redis(config.getOrThrow<string>('REDIS_URL'));
    return {
      prefix: 'myapp',
      defaults: { ttl: 60_000, jitter: 0.1, cacheNull: false, nullTtl: 30_000 },
      stores: {
        default: tieredStore({
          l1: memoryStore({ maxEntries: 5_000 }),
          l2: redisStore({ client: redis }),
          l1Ttl: 10_000,
        }),
        sessions: redisStore({ client: redis }),
      },
    };
  },
});
```

Module options:

| Option                | Type                                                  | Default                      | Meaning                                                              |
| --------------------- | ----------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `prefix`              | `string`                                              | none                         | Prefix for every key                                                 |
| `stores`              | `{ default: CacheStore; [name: string]: CacheStore }` | `{ default: memoryStore() }` | Named stores; a `default` store is required if you pass `stores`     |
| `defaults.ttl`        | `number` (ms)                                         | `60_000`                     | TTL when a decorator does not set one                                |
| `defaults.jitter`     | `number` in `[0, 1)`                                  | `0`                          | Effective TTL = `ttl x (1 + r)`, `r` random in `[-jitter, +jitter]`  |
| `defaults.cacheNull`  | `boolean`                                             | `false`                      | Whether `null`/`undefined` results are stored                        |
| `defaults.nullTtl`    | `number` (ms)                                         | `30_000`                     | TTL for stored empty values                                          |
| `namespaces`          | `{ [ns]: { versioned?: boolean } }`                   | none                         | Turns on [versioned namespaces](#versioned-namespaces) (exact names) |
| `versioning.cacheTtl` | `number` (ms)                                         | `1_000`                      | How long an instance keeps a namespace version in memory             |
| `escapeKeyArgs`       | `boolean`                                             | `false`                      | Escapes `%` and `:` in string and number template arguments          |
| `serializer`          | `Serializer`                                          | JSON                         | Envelope serializer                                                  |
| `isGlobal`            | `boolean`                                             | `false`                      | Register the module globally                                         |

`redisStore({ client, channel? })` accepts an ioredis instance (or a `RedisClientAdapter`). The default
Pub/Sub channel is `nestjs-cache:invalidate`. Redis 6.2 or later is required (the store uses `GETEX`).

`memoryStore({ maxEntries? })` is an LRU store (`MemoryStoreOptions`); `maxEntries` defaults to `1_000`.

`tieredStore({ l1, l2, l1Ttl?, invalidation? })` reads L1 first, then L2 (refilling L1 with `l1Ttl`).
Writes go to L2, then L1 with `min(ttl, l1Ttl)`, then an invalidation message is published.
`l1Ttl` defaults to `10_000`. A received invalidation message longer than 1 MiB (1_048_576 characters) is not parsed:
it clears the whole L1.

## Redis Cluster

Pass an ioredis `Cluster` to `redisStore` as you would a single client:

```ts
import { Cluster } from 'ioredis';
import { CacheModule, memoryStore, redisStore, tieredStore } from '@loipv/nestjs-cache';

const cluster = new Cluster([{ host: 'redis-1', port: 6379 }]);

CacheModule.forRoot({
  prefix: 'myapp',
  stores: {
    default: tieredStore({ l1: memoryStore(), l2: redisStore({ client: cluster }) }),
  },
});
```

- **Versions.** Cluster mode needs ioredis 5.6.0 or later (sharded Pub/Sub) and Redis 7 or later. The adapter creates
  its subscriber with `duplicate([], { shardedSubscribers: true })`, so you do not set `shardedSubscribers` yourself.
  On ioredis below 5.6.0, `SSUBSCRIBE` fails with a `MOVED` redirection error or, on versions whose
  `Cluster` lacks `ssubscribe`, a `TypeError`; either way it is reported as an `error` event with
  `operation: 'subscribe'`. The peer range stays `^5.0.0 || ^6.0.0`.
- **Batches.** `getMany`/`setMany` (`MGET`) and `delete` (`UNLINK`) split their keys per hash slot, so keys in
  different slots work, at one command per slot.
- **`clear`.** It scans every master and deletes the matches. It rejects (a store error and an `error` event) when the
  cluster client does not know a master yet, for example a `lazyConnect` client before its first command. It can miss
  keys that move between nodes during resharding. Versioned namespaces are not affected: their `clear` only writes a
  new token.
- **No automatic hash tags.** Keys are not wrapped in `{...}`, so related keys can live on different nodes.
- Calling `scan` directly on a cluster-mode adapter rejects with `CacheConfigError` pointing to `scanIterator`.
- **Sync.** The invalidation bus uses sharded Pub/Sub (`SPUBLISH`/`SSUBSCRIBE`).

## node-redis

`nodeRedisAdapter` wraps a [`redis`](https://github.com/redis/node-redis) client, cluster or Sentinel (v5 or v6).
`redis` (`^5.0.0 || ^6.0.0`) is an optional peer dependency. Pass a client that is already `connect()`ed: the
adapter only connects the subscriber connection it duplicates itself. Cluster mode is detected automatically (the
client has `masters`).

```ts
import { createClient, createCluster } from 'redis';
import { nodeRedisAdapter, redisStore } from '@loipv/nestjs-cache';

// standalone
const client = createClient({ url: process.env.REDIS_URL });
await client.connect();
const standalone = redisStore({ client: nodeRedisAdapter(client) });

// cluster
const cluster = createCluster({ rootNodes: [{ url: 'redis://redis-1:6379' }] });
await cluster.connect();
const clustered = redisStore({ client: nodeRedisAdapter(cluster) });
```

The same cluster rules apply (Redis 7+, per-slot batches, `clear` scans every master). The types are
`NodeRedisLike` and `NodeRedisClusterLike`.

- A standalone node-redis client signals reconnects, so L1 is cleared after one, as with ioredis.
- A node-redis cluster gives no reliable post-reconnect signal, so after a reconnect the tiered store is not told to
  clear L1: L1 can serve stale entries for up to `l1Ttl`. Node errors (`'node-error'`, `'error'`) are reported as
  `error` events with `operation: 'subscribe'`.
- If the client's reconnect strategy gives up (ioredis `retryStrategy` returning `null`, node-redis
  `reconnectStrategy` returning `false` or an `Error`), the invalidation subscription is not retried and L1 sync stays
  off for that instance until restart; the failure is reported (possibly twice: once from the client's error event and
  once from the failed subscribe). With the default strategies the subscriber keeps retrying.

## Redis Sentinel

Redis Sentinel works with both clients. Every command goes to the current master; the sentinels are used for
discovery and failover only (replica reads are planned for 0.9).

**ioredis.** Pass a client built with `sentinels` and `name` to `redisStore`, as you would a single client:

```ts
import Redis from 'ioredis';
import { CacheModule, memoryStore, redisStore, tieredStore } from '@loipv/nestjs-cache';

const redis = new Redis({
  sentinels: [
    { host: 'sentinel-1', port: 26379 },
    { host: 'sentinel-2', port: 26379 },
    { host: 'sentinel-3', port: 26379 },
  ],
  name: 'mymaster',
});

CacheModule.forRoot({
  stores: { default: tieredStore({ l1: memoryStore(), l2: redisStore({ client: redis }) }) },
});
```

The Pub/Sub connection comes from `duplicate()` and re-subscribes after a failover. After a failover an ioredis
subscriber can miss invalidation messages for about 10 s (the old master drops it late); like any lost message this is
bounded by `l1Ttl`.

**node-redis (v5 or v6).** Pass a `createSentinel(...)` object that is already `connect()`ed to `nodeRedisAdapter`. It is
detected automatically (the type is `NodeRedisSentinelLike`):

```ts
import { createSentinel } from 'redis';
import { nodeRedisAdapter, redisStore } from '@loipv/nestjs-cache';

const sentinel = createSentinel({
  name: 'mymaster',
  sentinelRootNodes: [{ host: 'sentinel-1', port: 26379 }],
});
sentinel.on('error', (err) => console.error(err));
await sentinel.connect();
const store = redisStore({ client: nodeRedisAdapter(sentinel) });
```

- The invalidation subscriber subscribes on the sentinel object itself (it does not duplicate it). Closing the store
  only unsubscribes its channels and never closes your client.
- A Sentinel `MASTER_CHANGE` clears L1, because messages published during a failover are lost. node-redis emits it
  before its pub/sub connection has moved to the new master, so an L1 backfill in that gap can still miss an
  invalidation; like any lost message this is bounded by `l1Ttl`.
- While a tiered store is open over it, the sentinel's `'error'` events are also reported as `error` events with
  `operation: 'subscribe'`. Still attach your own `'error'` listener.
- **`nodeAddressMap` and a tiered store (`redis` before 6.3.1).** node-redis 5.x and 6.0.0 to 6.3.0 apply
  `nodeAddressMap` to their data connections but not to their Sentinel pub/sub connection, which connects to the
  address the sentinel announces. If that address cannot be reached from your app (NAT, Docker port mapping,
  Kubernetes without routable pod IPs), the tiered store's invalidation subscription never connects. After a failover
  node-redis then waits for that connection before it uses the new master, so every command on that client hangs, and
  `close()` hangs too. Any SUBSCRIBE on the client triggers it, not only this library's. It is fixed upstream in
  node-redis 6.3.1, so `redis` 6.3.1 or later is not affected. On earlier versions, if the master and replica
  addresses the sentinels announce are reachable from your app, you are not affected either. Otherwise upgrade to
  `redis` 6.3.1 or later, use ioredis (`natMap` covers its subscriber too), make the announced addresses reachable
  (`replica-announce-ip` / `sentinel announce-ip`), or do not put a tiered store over it.

## Decorators

```ts
@Injectable()
export class UserService {
  @Cacheable({ namespace: 'users', key: 'user:{0}', ttl: 60_000 })
  findById(id: string): Promise<User | null> {
    /* ... */
  }

  @Cacheable({
    namespace: 'users',
    key: (query: SearchQuery, page: number) => `search:${query.term}:${page}`,
    condition: (query: SearchQuery) => query.term.length > 2,
  })
  search(query: SearchQuery, page: number): Promise<User[]> {
    /* ... */
  }

  @CachePut({ namespace: 'users', key: 'user:{0}' })
  update(id: string, dto: UpdateUserDto): Promise<User> {
    /* ... */
  }

  @CacheEvict({ namespace: 'users', key: 'user:{0}' })
  remove(id: string): Promise<void> {
    /* ... */
  }

  @CacheEvict({ namespace: 'users', allEntries: true })
  importAll(): Promise<void> {
    /* ... */
  }
}
```

| Option                 | Decorator                 | Meaning                                                                                         |
| ---------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `key`                  | all three                 | Template or callback (see Dynamic keys). `@CacheEvict` also accepts an array                    |
| `namespace`            | all three                 | Key group; the unit for bulk eviction                                                           |
| `store`                | all three                 | Store name, defaults to `default`                                                               |
| `ttl`                  | `@Cacheable`, `@CachePut` | Overrides `defaults.ttl`                                                                        |
| `strategy`             | `@Cacheable`, `@CachePut` | `'fixed'` (default), `'swr'` or `'sliding'` (see Expiry strategies)                             |
| `staleTtl`, `maxTtl`   | `@Cacheable`, `@CachePut` | Strategy parameters (`swr` needs `staleTtl`; `sliding` accepts `maxTtl`)                        |
| `softTimeout`          | `@Cacheable`              | `swr` only: wait up to this many ms for the refresh of a stale entry (see Expiry strategies)    |
| `lock`                 | `@Cacheable`              | `true`/`false` overrides `defaults.lock.enabled` (see Distributed lock)                         |
| `cacheNull`, `nullTtl` | `@Cacheable`, `@CachePut` | Per-method override of the defaults                                                             |
| `condition`            | `@Cacheable`, `@CachePut` | Receives the method arguments; `false` skips the cache                                          |
| `unless`               | `@Cacheable`, `@CachePut` | Receives the result; `true` prevents storing it                                                 |
| `allEntries`           | `@CacheEvict`             | Clear the whole namespace; requires `namespace` and cannot be combined with `key`               |
| `beforeInvocation`     | `@CacheEvict`             | `true`: evict before the method runs. Default: evict after it succeeds                          |
| `tags`                 | all three, `@HttpCache`   | Tags to stamp (`@Cacheable`, `@CachePut`, `@HttpCache`) or invalidate (`@CacheEvict`); see Tags |

Behaviour:

- `@Cacheable`: on a hit, returns the cached value (including a stored empty value). On a miss, runs the method and stores the result.
- `@CachePut`: always runs the method. If `condition` is `false` or `unless` is `true` the cache is untouched. An empty result while `cacheNull` is off deletes the key. Otherwise the result is stored.
- `@CacheEvict`: evicts after the method succeeds; a method that throws evicts nothing. With `beforeInvocation: true` it evicts first, regardless of the outcome.
- A method can carry several `@CacheEvict`, or `@CachePut` together with `@CacheEvict`. `@Cacheable` together with `@CachePut` on one method throws at class definition.

Type checking: decorating a method that does not return a `Promise` is a compile error. The `key` and
`condition` callbacks type their own parameters, and the compiler checks that the method accepts them.
Callbacks may declare fewer parameters than the method.

Unknown store names fail at startup. A bad key template, `allEntries` without `namespace`, an empty `key: []` for
`@CacheEvict`, invalid `tags` (see Tags), a `static` method, and a `ttl`/`nullTtl`/`staleTtl`/`maxTtl`/`softTimeout` that is not a finite number greater than 0
are rejected with `CacheConfigError`, as is a `cacheNull` that is not a boolean. See Error behaviour for the full list.

## HTTP caching

`@HttpCache` caches a controller route's response body. It is opt-in: a route without the decorator is never cached.

```ts
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CacheEvict, HttpCache } from '@loipv/nestjs-cache';

@Controller('users')
export class UsersController {
  @Get()
  @HttpCache({ namespace: 'users', ttl: 60_000 })
  list(): Promise<User[]> {
    /* ... */
  }

  @Get(':id')
  @HttpCache({ namespace: 'users', key: (req) => `user:${req.params.id}` })
  find(@Param('id') id: string): Promise<User> {
    /* ... */
  }

  @Post()
  @CacheEvict({ namespace: 'users', allEntries: true })
  create(@Body() dto: CreateUserDto): Promise<User> {
    /* ... */
  }
}
```

`CacheModule` must be global or imported into the controller's module. It works on Express and Fastify.

- **Where:** on a method or on a class. A method's options replace the class's options entirely (no merge). Only `GET`
  and `HEAD` are cached (`HEAD` shares the `GET` entry); other methods and non-HTTP contexts pass through.
- **Options:** `ttl`, `namespace` (default `'http'`), `store`, `lock`, `cacheNull`, `nullTtl`, `key`, `unless`
  (`(body) => boolean`; return `true` to keep that body out of the cache) and the strategy options (`strategy: 'swr'`
  with `staleTtl`/`softTimeout`, or `'sliding'` with `maxTtl`). Invalid options throw `CacheConfigError` when the decorator runs; an
  unknown `store` fails at startup (`app.init()`) with a message that names `@HttpCache`.
- **Default key:** the request URL with the query sorted by name, then value, and `%` and `:` percent-encoded:
  `/users?b=2&a=1` and `/users?a=1&b=2` share the entry `/users?a=1&b=2`. It varies only on the path and the query,
  not on the host (for example `@Controller({ host })` multi-tenant routes), headers such as `Accept`,
  `Accept-Language` or a version header, or cookies: anything else that changes the body must go into a key callback,
  or the route must not be cached.
- **Key callback:** `key` is a fixed string, or `(req) => string | undefined` where `req` is
  `{ method, url, defaultKey, path, query, params, headers }` and `defaultKey` is the default key above. Returning
  `undefined` skips the cache for that request, for example
  `key: (req) => (req.headers.authorization ? undefined : req.defaultKey)` caches only anonymous requests. A callback
  that throws, or returns something other than a non-empty string, emits one `error` event with `operation: 'key'` and
  the handler runs uncached. Callback keys are not escaped: with `escapeKeyArgs: true`,
  `@CacheEvict({ key: 'user:{0}' })` escapes `:` and `%` in the id but ``(req) => `user:${req.params.id}` `` does not,
  so build both keys the same way, for example ``@CacheEvict({ key: (id: string) => `user:${id}` })``.
- **What is cached:** the handler's return value (the body) only. `StreamableFile`, `Buffer`, `Uint8Array` and streams
  are never cached, but do not put `@HttpCache` on routes that return them: concurrent requests coalesced by
  single-flight would share one stream instance. `undefined` is never cached, so routes that use `@Res()` are not
  supported. `null` is cached only with `cacheNull`. `@HttpCode` and `@Header` still apply on a hit.
- **Server-side cache:** the library adds no response headers and ignores the request `Cache-Control`.
- **Errors:** an error from the handler, including `HttpException`, reaches your exception filters and is not cached.
  A cache or store error never reaches the client: it emits an `error` event and the handler runs.
- **Engine features** apply unchanged: single-flight per process, `lock` across instances, `swr` and `sliding`, the
  circuit breaker, events and Prometheus metrics.

Invalidation: put list routes in a namespace and clear it from the mutations with
`@CacheEvict({ namespace: 'users', allEntries: true })`. Declare the namespace with
`namespaces: { users: { versioned: true } }` so that clear is O(1) (see Versioned namespaces). For single-record
routes, build the key from the request (``key: (req) => `user:${req.params.id}` ``) and evict it with
`@CacheEvict({ namespace: 'users', key: 'user:{0}' })`, with `@Param('id') id` as the method's first parameter.

Coming from `@nestjs/cache-manager`? See the
[migration guide](docs/migration-from-cache-manager.md).

## Dynamic keys

The full key is `<prefix>:<namespace>:<key>`; missing parts are dropped together with their `:`.

- **Template:** `{N}` is the Nth argument (from 0); `{N.a.b}` reads a nested property. Primitives use `String()`, objects use JSON with sorted keys. Templates are positional because parameter names do not exist at runtime. A malformed template throws at class definition.
- **`escapeKeyArgs: true`** (module option) rewrites `%` as `%25` and `:` as `%3A` in the string and number arguments rendered into a template, so an argument cannot address another namespace. Callback keys and keys you pass to `CacheService` are never escaped. Turning it on changes the keys of arguments that contain `:` or `%`, so those entries start cold.
- **Callback:** receives the method arguments and returns a string.
- **Default:** `<ClassName>.<methodName>`, followed by `:<hash>` when there are arguments. The hash is the first 16 hex characters of the SHA-1 of the arguments' JSON (sorted keys).
- If a key cannot be built (unserializable argument, a callback that throws, a template or callback that renders an empty string), the cache is skipped, the original method runs and an `error` event with `operation: 'key'` is emitted. In a `@CacheEvict` key list, a key that renders empty is dropped (one `error` event) and the other keys are still evicted; a key builder that throws skips the whole eviction.

## CacheService

```ts
class CacheService {
  get<T>(key: string, options?: KeyOptions & StrategyOptions): Promise<T | undefined>;
  set<T>(key: string, value: T, options?: WriteOptions): Promise<void>;
  delete(key: string | readonly string[], options?: KeyOptions): Promise<void>;
  clear(namespace: string, options?: { store?: string }): Promise<void>;
  invalidateTags(tags: readonly string[], options?: { store?: string }): Promise<void>;
  getOrSet<T>(key: string, loader: () => Promise<T>, options?: GetOrSetOptions<T>): Promise<T>;
  getMany<T>(
    keys: readonly string[],
    options?: KeyOptions & StrategyOptions,
  ): Promise<(T | undefined)[]>;
  setMany<T>(
    entries: readonly (readonly [key: string, value: T])[],
    options?: WriteOptions,
  ): Promise<void>;
  getOrSetMany<T>(
    keys: readonly string[],
    loader: (missing: string[]) => Promise<ReadonlyMap<string, T>>,
    options?: GetOrSetOptions<T>,
  ): Promise<(T | undefined)[]>;
}
```

```ts
const user = await cache.getOrSet('user:1', () => repo.find('1'), {
  namespace: 'users',
  ttl: 30_000,
  cacheNull: true,
});
```

`KeyOptions` is `{ namespace?, store? }`, `WriteOptions` adds `ttl` and the strategy options, and `GetOrSetOptions`
adds `cacheNull`, `nullTtl`, `unless` and `lock`. `get` returns `undefined` on a miss. `clear` needs a non-empty namespace and rejects
`''` with `CacheConfigError`. A `namespace` that starts with `__` is reserved and also rejects with `CacheConfigError`. `T` is your assertion; the library does not
validate stored data at runtime.

An empty key is a key error (`error` with `operation: 'key'`): `get` returns `undefined`, `getOrSet` runs the loader
without caching, and `set` does nothing. `delete` drops the empty keys, emits one `error` event and still deletes
the others; `delete('')` alone does nothing.

## Versioned namespaces

By default `clear(namespace)` and `@CacheEvict({ allEntries: true })` walk the store (`SCAN` and delete on Redis),
which is slow for a large namespace. A versioned namespace clears with one write instead.

```ts
CacheModule.forRoot({
  prefix: 'myapp',
  stores: { default: tieredStore({ l1: memoryStore(), l2: redisStore({ client: redis }) }) },
  namespaces: { users: { versioned: true } },
  versioning: { cacheTtl: 1_000 },
});

await cache.set('user:1', user, { namespace: 'users' }); // key: myapp:users@<token>:user:1
await cache.clear('users'); // one SET of a new token; no SCAN
```

- A versioned namespace keeps a token in the key `<prefix>:__version__:<namespace>` and writes data under
  `<prefix>:<namespace>@<token>:<key>`. The token key has a 30-day TTL that every `clear` refreshes.
- `clear` and `@CacheEvict({ allEntries: true })` write a new token. Old entries are never deleted; they become
  unreachable and expire by their own TTL.
- Each instance caches the token in memory for `versioning.cacheTtl` ms (default `1_000`), so another instance sees a
  clear within that time. The instance that clears sees it at once.
- `delete`, `@CacheEvict` with keys and a `put` of an empty value read the token fresh from the store and delete under
  both the fresh and the cached token: one extra `GET` per delete. On a `tieredStore` the "fresh" read is served from
  L1, so a delete that races a `clear` on another instance, before that instance's invalidation message arrives, can
  still use the previous token.
- Turning `versioned: true` on for a namespace that already has entries changes its keys: the existing
  `<prefix>:<namespace>:*` entries are no longer read, `clear` no longer reaches them, and they expire by their own TTL.
  The namespace starts cold.
- Names must match exactly. A sub-namespace such as `users:admin` is not versioned by `users: { versioned: true }`;
  list it on its own.
- Namespaces starting with `__` are reserved and rejected (see [Error behaviour](#error-behaviour)).
- If the token cannot be read or written, an `error` event with `operation: 'version'` is emitted. On a plain store
  (not tiered) a `get` is then a miss without a `miss` event, `getOrSet` runs the loader without writing the result,
  and `set` and `delete` do nothing.
- On a `tieredStore` (and on any store implementing `getStrict`), a failed version read falls back to the last token
  this process knew, with one `version` error per failure; the next call reads the store again. With no known token the
  loader runs and nothing is cached. A plain store keeps the 0.4 behaviour: one `version` error, the loader runs, and
  nothing is cached. A failed `clear` (L2 down) reports a `version` error and leaves the token unchanged, so it no
  longer moves the token in L1 only.
- Remaining risk: an instance that missed another instance's `clear` just before an outage keeps the old token during
  the outage. The stale data comes from L1 only, so it lasts at most `l1Ttl`.

## Tags

A tag groups entries across keys and namespaces so that one call invalidates all of them. Tag an entry when you write
it, then call `invalidateTags` (or use `@CacheEvict({ tags })`); every entry carrying that tag becomes a miss.

```ts
import { Cacheable, CacheEvict, CacheService } from '@loipv/nestjs-cache';

// Illustrative: `repo`, `Product` and `UpdateProductDto` are your own.
@Injectable()
export class ProductsService {
  constructor(
    private readonly cache: CacheService,
    private readonly repo: ProductsRepository,
  ) {}

  // Templates use the key syntax and honour escapeKeyArgs.
  @Cacheable({ namespace: 'products', key: 'product:{0}', tags: ['product:{0}', 'catalog'] })
  find(id: string) {
    return this.repo.find(id);
  }

  // Tag a list by category, not by every item in it: one entry carries at most 32 tags.
  @Cacheable({ namespace: 'products', key: 'list:{0}', tags: ['category:{0}'] })
  list(category: string) {
    return this.repo.list(category);
  }

  // A callback of the arguments (or, for @Cacheable/@CachePut, also the result); annotate its parameters.
  @CacheEvict({
    tags: (id: string, dto: UpdateProductDto) => [`product:${id}`, `category:${dto.category}`],
  })
  update(id: string, dto: UpdateProductDto) {
    return this.repo.update(id, dto);
  }

  // Or invalidate directly.
  async clearCatalog() {
    await this.cache.invalidateTags(['catalog']);
  }
}
```

Entries written without a tag stamp are not affected by `invalidateTags` until their own TTL. When you add `tags` to
an existing method or call, clear the affected namespaces after the rollout (or wait one TTL).

Declaring tags:

- `@Cacheable` and `@CachePut`: `tags` is an array of templates (same syntax as `key`, honours `escapeKeyArgs`) or a
  callback `(result, ...args) => string[]`. `tags: []` means no tags. Callbacks are checked against the decorated
  method, not inferred from it, so annotate their parameters.
- `@HttpCache`: `tags` is an array of fixed strings (not templates) or `(body, req: HttpCacheRequest) => string[]`.
- `CacheService.set` and `getOrSet`: fixed strings or `(value) => string[]`. `setMany` and `getOrSetMany`: fixed
  strings or `(value, key) => string[]` (the types `WriteManyOptions<T>` and `GetOrSetManyOptions<T>` are exported).

```ts
await cache.set('user:1', user, { namespace: 'users', tags: ['tenant:7'] });
await cache.invalidateTags(['tenant:7']);
```

Invalidating:

- `CacheService.invalidateTags(tags, { store? })` works per store. It rejects with `CacheConfigError` for an empty
  list, an empty string, a non-array, more than 32 tags or an unknown store. If writing a tag token fails it still
  tries every tag, then rejects with the first error.
- `@CacheEvict({ tags })` takes templates over the arguments or `(...args) => string[]`. Use it alone or with
  `key`/`allEntries` (the keys or namespace are evicted first, then the tags), and with `beforeInvocation`. It never
  rejects the call: token-write failures are `error` events only, and a key error and a tag error do not block each
  other. `@CacheEvict()` with no options keeps its 0.6 meaning (evicts the default key); `@CacheEvict({ tags: [] })`
  is a `CacheConfigError`.

Limits and errors:

- At most 32 tags per entry after de-duplication, and tag strings must be non-empty.
- With `escapeKeyArgs: true` a template tag renders escaped (`product:a%3Ab` for id `a:b`), so `invalidateTags` must
  use the same escaped form.
- A tag callback receives `null` or `undefined` when `cacheNull` caches an empty result. A callback that dereferences
  it produces a `tag` error, and the null is not cached.
- A custom `Serializer` must round-trip the envelope's `tags` field, or invalidation is silently disabled.
- An invalid runtime tag list (for example a callback that returns an empty string) emits one `error` event with
  `operation: 'tag'`; the entry is not written and the caller still gets the value.
- A token read or write failure emits an `error` event with `operation: 'version'`.

Consistency and cost:

- Tags are scoped per store; one tag can span several namespaces in the same store.
- The instance that invalidates sees it immediately. When an entry's stamp differs from an instance's cached tag
  token, that instance re-reads the token from the store (at most once per tag per `versioning.cacheTtl`, default
  1000 ms) and a confirmed match is a hit. So instances do not keep rewriting each other's entries after an
  invalidation, and other instances usually see it on the next read; the worst case is still bounded by
  `versioning.cacheTtl`, the same setting that governs versioned namespaces.
- Each tag has a version key `<prefix>:__tag__:<tag>` with a 30-day TTL. Reads cost no extra round-trip while the tag
  tokens are cached in the process; up to 10 000 tag tokens are kept per process (the least recently refreshed is
  evicted first).
- Tag token keys live 30 days in the same store, count toward `memoryStore` `maxEntries`, and one key per distinct tag
  accumulates in Redis. Bound tags built from untrusted input.
- On a two-tier store, if an invalidation message is lost or there is no bus, another instance can keep the old tag
  token for up to `l1Ttl` plus `versioning.cacheTtl` (the tag token key is cached in L1), not only
  `versioning.cacheTtl`.
- Invalidated entries are not deleted. They become misses and leave the store when their TTL expires. The one
  exception is the sliding path: an entry whose tag mismatch is confirmed against the store is deleted (not on tiered
  stores or stores with `getStrict`, where it is just a miss).

Write timing:

- Tags known before the load (arrays and templates, and `@CachePut` arrays) take their tokens before the loader or
  method runs, so an invalidation during the load is never missed.
- Tags from a callback on the result are computed after the load. An invalidation that happens during that load can
  be missed until the entry's TTL; prefer argument tags when you need strictness.
- `@CachePut` and `@CacheEvict({ tags })` sharing a tag on one method: with template (array) tags, `@CachePut` takes
  its tokens before the method runs, so an evict of that tag that runs afterwards makes the freshly put entry a miss.
  Only `@CacheEvict({ beforeInvocation: true })` placed outermost, with `@CachePut` inside, keeps the entry.
  Result-callback tags are stamped at write time, so any evict of that tag that finishes before `@CachePut` writes
  keeps the entry.

Outages and upgrades:

- If tag tokens cannot be read, a store with `getStrict` (such as `tieredStore`) uses the last known tokens. Any other
  store treats a tagged entry as a miss, and `getOrSet` loads without writing and without the distributed lock.
- With `strategy: 'swr'`, an entry invalidated by a tag is a hard miss; it is never served stale.
- Rolling deploy: instances still on 0.6 ignore the `tags` field, so entries they write carry no tag stamp and
  `invalidateTags` does not affect them until their own TTL (the same holds for entries written before `tags` was
  added to a method or call). Only entries written with tags are affected by an invalidation; clear the affected
  namespaces after the rollout, or wait one TTL.

## Batch operations

`getMany`, `setMany` and `getOrSetMany` read and write many keys of one namespace in a call.

```ts
const [a, b] = await cache.getMany<User>(['user:1', 'user:2'], { namespace: 'users' });

await cache.setMany(
  [
    ['user:1', userOne],
    ['user:2', userTwo],
  ],
  { namespace: 'users', ttl: 30_000 },
);

const users = await cache.getOrSetMany<User>(
  ['user:1', 'user:2', 'user:3'],
  async (missing) => {
    const rows = await repo.findByKeys(missing); // only the keys not in the cache
    return new Map(rows.map((row) => [row.key, row.user]));
  },
  { namespace: 'users', ttl: 30_000, cacheNull: true },
);
```

- Results are in input order. A key read twice in one call is read and loaded once. An empty key gives `undefined`
  and one `error` event with `operation: 'key'`. `[]` makes no store call.
- The loader receives only the misses and returns a `Map`. A requested key missing from the `Map` is treated as a
  `null` result and follows `cacheNull`. Keys in the `Map` that were not requested are ignored: not cached, not
  returned. An error from the loader, or a return value that is not a `Map`, reaches the caller.
- Loading is single-flight per key and shared with `getOrSet` in the same process: concurrent `getOrSetMany(['a', 'b'])`
  and `getOrSetMany(['b', 'c'])` call their loaders with `['a', 'b']` and `['c']`.
- `swr` serves stale values and refreshes them with one loader call for the stale keys; with `softTimeout` the whole
  call shares one wait window (see [Expiry strategies](#expiry-strategies)). `sliding` makes `getMany`
  call `getAndTouch` for each key (per key, not one batch call).
- `getOrSetMany` with `lock: true` throws `CacheConfigError`, and `defaults.lock.enabled` is ignored for batches.
  Coalescing is per process.
- The `load` event fires once per loader call and carries `keys` (all the keys passed to the loader); `key` is the
  first of them.
- `CacheStore` has the optional `getMany` and `setMany`. `redisStore` uses one `MGET` when the client has `mget`;
  other stores are called key by key.
- `setMany` with a duplicated key keeps the last value.
- `setMany` entries must be `[key, value]` pairs. An element that cannot be destructured (`null`, a number) throws a
  `TypeError`; one that can is not checked, so a 2-character string such as `'ab'` silently becomes key `a`, value `b`.
- With a versioned namespace the batch methods read the token once for the call.

## Null caching and TTL jitter

Both are off by default.

- **Null caching** (`cacheNull: true`) stores `null`/`undefined` results for `nullTtl` (default `30_000` ms), which protects the backend from repeated lookups of missing data. Set it globally in `defaults` or per method. `null` and `undefined` are kept distinct.
- **TTL jitter** (`defaults.jitter`, a number in `[0, 1)`) spreads expirations: the effective TTL is `ttl x (1 + r)` with `r` random in `[-jitter, +jitter]`, which avoids many keys expiring at the same moment.

## Expiry strategies

`strategy` is available on `@Cacheable`, `@CachePut`, `CacheService.getOrSet` and `CacheService.set`, and is chosen per
call. `CacheService.get` accepts it too, only to pick the read command.

| Strategy    | Options                       | What it does                                                                                                                                     |
| ----------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `'fixed'`   | none (default)                | The entry lives `ttl` (with jitter if configured) and is then a miss.                                                                            |
| `'swr'`     | `staleTtl` (required)         | Fresh for `ttl`, then stale for another `staleTtl`. A stale read returns the old value at once and refreshes it in the background.               |
| `'sliding'` | `maxTtl` (optional, `>= ttl`) | Each read resets the expiry to `ttl` (no jitter). With `maxTtl`, the entry still expires `maxTtl` after it was stored, however often it is read. |

```ts
@Injectable()
export class ProductService {
  @Cacheable({
    namespace: 'products',
    key: 'p:{0}',
    ttl: 60_000,
    strategy: 'swr',
    staleTtl: 5 * 60_000,
  })
  findById(id: string): Promise<Product | null> {
    /* ... */
  }

  @Cacheable({
    namespace: 'sessions',
    key: 's:{0}',
    ttl: 30 * 60_000,
    strategy: 'sliding',
    maxTtl: 8 * 3_600_000,
  })
  loadSession(id: string): Promise<Session | null> {
    /* ... */
  }
}

const price = await cache.getOrSet('price:1', () => fetchPrice('1'), {
  namespace: 'prices',
  ttl: 10_000,
  strategy: 'swr',
  staleTtl: 60_000,
});
```

**Stale-while-revalidate.** A `hit` event with `stale: true` is emitted for a stale read. The background refresh is
joined with concurrent misses on the same key (one load), and a refresh that fails emits `error` with
`operation: 'refresh'` while the old value stays until it expires. Two warnings for decorated methods:

- The refresh calls your method again in the background, with the same `this` and the same arguments, after the
  original request has ended. The method must not depend on request context (request-scoped providers,
  `AsyncLocalStorage`, a request object passed in the arguments).
- The synchronous part of the method (everything before its first `await`) runs before the stale value is returned
  to the caller, because the refresh is started first. Keep that part cheap.

**`softTimeout`.** With `strategy: 'swr'` a stale hit normally returns the old value at once. Add `softTimeout` (ms)
to wait up to that long for the refresh instead (joining one already in flight): the fresh value is returned if it
arrives in time, the stale one otherwise (timeout or loader error). The refresh keeps running and writes its result
either way. Fresh hits never wait.

```ts
const price = await cache.getOrSet('price:1', () => fetchPrice('1'), {
  namespace: 'prices',
  ttl: 10_000,
  strategy: 'swr',
  staleTtl: 60_000,
  softTimeout: 200,
});
```

`softTimeout` is accepted by `@Cacheable`, `@HttpCache`, `getOrSet` and `getOrSetMany`. A refresh counts only once its
result is written: if the loader resolves `undefined` or `null` (or, in a batch, omits a key) without `cacheNull`,
nothing is written and the stale entry stays, so the call returns the stale value, as on a timeout. With `cacheNull`
the empty value is written and returned. A batch shares one window per call. The calls that never load (`@CachePut`,
`set`, `setMany`, `get` and `getMany`) do not accept it: their option types (`StrategyOptions`) reject it at compile
time, and a JavaScript caller gets `CacheConfigError`. The load calls take `LoadStrategyOptions`, which adds it.

Entries written by 0.1 carry only `expiresAt`; read with `swr` they are fresh until then, and then expired.
`CacheService.get` returns a stale entry (with `hit.stale: true`) but never refreshes, as it has no loader.

**Sliding and `CacheService.get`.** `CacheService.get(key, { strategy: 'sliding' })` resets the entry's window to
`defaults.ttl`, not to the `ttl` the entry was written with, because the store needs the new TTL before the entry is
read. Pass the same TTL through `defaults.ttl`, or read with `getOrSet`, which knows the call's `ttl`. Sliding uses the
store's `getAndTouch`, which is atomic in the memory and Redis stores. A tiered store does not touch L2 on an L1 hit, so
the window is refreshed on L1 misses only (about once per `l1Ttl` per instance), and the backfill is capped at
`min(ttl, l1Ttl)`; its atomicity depends on L2, and an L2 without `getAndTouch` is read with a plain `get`, which does
not extend it. A custom store without `getAndTouch` falls back to a `get` followed by a `set`, which is not atomic. `null` values stored with `cacheNull` always use `fixed` and `nullTtl`.

Validation: `staleTtl`, `maxTtl` and `softTimeout` must be finite numbers greater than 0, `maxTtl` must be `>= ttl` (the call's `ttl`
or `defaults.ttl`), and an unknown `strategy` name or `swr` without `staleTtl` is rejected with `CacheConfigError`.

## Compression

`compressedSerializer` wraps a serializer and compresses large payloads with gzip or brotli. Pass it as the module
`serializer`:

```ts
import { CacheModule, compressedSerializer } from '@loipv/nestjs-cache';

CacheModule.forRoot({
  serializer: compressedSerializer({ algorithm: 'gzip', threshold: 1024 }),
});
```

| Option                 | Default          | Meaning                                                                 |
| ---------------------- | ---------------- | ----------------------------------------------------------------------- |
| `inner`                | `jsonSerializer` | Serializer that produces and reads the string that gets compressed      |
| `algorithm`            | `'gzip'`         | `'gzip'` or `'brotli'`, used for writes                                 |
| `threshold`            | `1024`           | Payloads whose UTF-8 byte length is above it are tried for compression  |
| `maxDecompressedBytes` | 16 MiB           | Upper bound of a decompressed payload; larger ones are rejected on read |

- It compresses only above `threshold` and only when the result is shorter. Smaller payloads are stored as `inner`
  writes them, and uncompressed payloads are always readable, so a rolling deploy from an uncompressed serializer is
  safe.
- Payloads above `maxDecompressedBytes` are stored uncompressed, so every value it writes can be read back.
- The algorithm is taken from the prefix of the stored value, not from the configuration, so switching between `gzip`
  and `brotli` is safe: old entries stay readable.
- Switching back from `compressedSerializer` to an uncompressed serializer makes the compressed entries unreadable:
  they produce `deserialize` errors and are misses until they expire.
- Compression is synchronous (`node:zlib`) and costs event-loop CPU on large payloads; `brotli` compresses smaller
  and slower than `gzip`.
- A corrupt or oversized payload is a `deserialize` error and a miss, like any unreadable entry.
- Invalid options throw `CacheConfigError` when the serializer is created.
- `inner` must not produce strings that start with `"\u0000nc1:"`, the prefix the compressed values use.

## Distributed lock

Off by default. Without it, concurrent misses are coalesced per process only. With it, one instance loads while the
others wait and then read the stored value, so a miss costs one load across the whole cluster.

```ts
CacheModule.forRoot({
  stores: { default: tieredStore({ l1: memoryStore(), l2: redisStore({ client: redis }) }) },
  defaults: {
    lock: { enabled: true, ttl: 10_000, waitTimeout: 3_000, retryDelay: 50 },
  },
});

@Cacheable({ namespace: 'reports', key: 'r:{0}', lock: true }) // per method, overrides defaults.lock.enabled
build(id: string): Promise<Report> { /* ... */ }

await cache.getOrSet('report:1', () => build('1'), { namespace: 'reports', lock: true });
```

| Option                      | Default  | Meaning                                                             |
| --------------------------- | -------- | ------------------------------------------------------------------- |
| `defaults.lock.enabled`     | `false`  | Turn the lock on for every `@Cacheable` and `getOrSet`              |
| `defaults.lock.ttl`         | `10_000` | How long the lock is held before it expires on its own (ms)         |
| `defaults.lock.waitTimeout` | `3_000`  | How long a waiter polls for the value before loading it itself (ms) |
| `defaults.lock.retryDelay`  | `50`     | Pause between polls (ms)                                            |

`defaults.lock` is typed `CacheLockDefaults`. Any value other than an object or `undefined` throws `CacheConfigError`.

- It needs a `redisStore`, or a `tieredStore` whose L2 is Redis (the lock is the L2's). The memory store has no lock.
  With any other store the engine falls back to in-process coalescing, and a warning is logged once at startup. For `lock: true` on a method whose store has no lock, `CacheExplorer` logs the
  warning once per class, method and store.
- A request answered from the cache after waiting for the lock emits `miss` and then `hit` for the same request; do not double-count it in metrics.
- Lock keys are `<prefix>:__lock__:<namespace>:<key>` (`__lock__:<namespace>:<key>` without a `prefix`; for a versioned namespace the namespace part is `<namespace>@<token>`). They live under your prefix, so a `clear` of a namespace never deletes them. Namespaces starting with `__` are reserved for this reason. A custom `LockProvider` receives this complete key.
- **Rolling deploy from 0.3:** 0.3 used `lock:<fullKey>`. While 0.3 and 0.4 nodes run together they do not exclude each other, so a loader can run twice during the deploy.
- The lock is **not auto-extended.** If a load runs longer than `lock.ttl`, the lock expires and another instance
  may load the same key too (a duplicated load, never a wrong value). Set `lock.ttl` above your slowest load.
- A waiter that finds the value returns it, and coalesced waiters in one process produce one `hit` per flight. If
  `waitTimeout` passes, the waiter loads the value without the lock.
- `lock` events report each acquire (`acquired`, `waitedMs`). Lock errors are reported as `error` events with
  `operation: 'lock'` and the load proceeds without the lock.
- `@CachePut` and `@CacheEvict` have no `lock` option.

## Circuit breaker

Wrap a store so that a slow or failing backend stops being called, instead of adding its timeout to every request.

```ts
import { circuitBreaker, memoryStore, redisStore, tieredStore } from '@loipv/nestjs-cache';

const store = tieredStore({
  l1: memoryStore(),
  l2: circuitBreaker(redisStore({ client: redis }), {
    failureThreshold: 5, // default
    openDuration: 10_000, // default, ms
    timeout: 500, // default, ms
  }),
});
```

| State       | Behaviour                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `closed`    | Commands go to the store. A failure or a `timeout` counts as one; a success resets the count. `failureThreshold` consecutive failures open the circuit. |
| `open`      | Commands are rejected at once with `CircuitOpenError`. The first command after `openDuration` becomes a probe and moves the circuit to `half-open`.     |
| `half-open` | Only the probe goes through; other commands are rejected. A successful probe closes the circuit, a failed one reopens it and restarts `openDuration`.   |

- Defaults: `failureThreshold` 5 (an integer `>= 1`), `openDuration` 10_000, `timeout` 500. `timeout` and
  `openDuration` must be finite numbers greater than 0 and `<= 2_147_483_647` (the largest `setTimeout` delay);
  otherwise `circuitBreaker` throws `CacheConfigError`. `circuitBreaker(...)` returns a `CircuitBreakerStore`, its options are
  typed `CircuitBreakerOptions`, and `breaker` events carry a `BreakerState`.
- Guarded: `get`, `set`, `delete`, `clear`, `getAndTouch`, `lock.acquire` and `lock.release`. `invalidation`, `bind`
  and `close` are passed through. The breaker has `getAndTouch` and `lock` only if the wrapped store does.
- `clear` is guarded by the breaker `timeout`. For big namespaces (Redis `SCAN`/`UNLINK` loops) use a larger `timeout`, otherwise `@CacheEvict({ allEntries: true })` can trip the breaker.
- A result that arrives after its command timed out is ignored: it does not reset the failure count or change the
  state. If an `acquire` times out but the lock is granted late, the late lock is released best-effort.
- `CircuitOpenError` never reaches your code and never emits `error`: reads count as a miss, writes are skipped, and
  loads run without the lock. Every state change emits a `breaker` event.
- In a tiered store, an open L2 circuit means L1 keeps serving and L1 writes still happen, but invalidation messages
  are not published. L1 entries on other instances can therefore stay stale for up to `l1Ttl` while the circuit is
  open.

## Custom stores and invalidation buses

Implement the `CacheStore` interface (see the TSDoc in `src/stores/cache-store.interface.ts`):

```ts
interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  clear(prefix: string): Promise<void>;
  getAndTouch?(key: string, ttlMs: number): Promise<string | undefined>; // used by 'sliding'
  getMany?(keys: readonly string[]): Promise<(string | undefined)[]>; // used by getMany / getOrSetMany
  setMany?(entries: readonly { key: string; value: string; ttlMs: number }[]): Promise<void>; // used by setMany
  readonly lock?: LockProvider; // used by the distributed lock
  readonly invalidation?: InvalidationBus;
  bind?(events: CacheEventSink): void;
  close?(): Promise<void>;
}
```

`getStrict` and `setStrict` are only needed by stores whose `get`/`set` degrade instead of rejecting, as a
`tieredStore` does. They reject when the durable tier cannot be read or written, and the engine uses them for version
tokens. Stores whose `get`/`set` already reject (memory, Redis) can leave them out.

`getAndTouch` should be implemented by stores that can do it atomically: without it, `sliding` falls back to a `get`
followed by a `set`, which is not atomic. `lock` is a `LockProvider` (`acquire(key, ttlMs)` returns a `LockHandle` or
`undefined`; `LockHandle.release()` frees it). `getMany` and `setMany` are optional: without them the engine calls `get` and `set` for each key. Leave these members out when unsupported; do not define them as
`undefined`.

A custom store can be the L2 of a `tieredStore`. L1 synchronisation is separate from storage: `tieredStore`
uses `options.invalidation` if given, otherwise `l2.invalidation`.

| Configuration                                                                                                                                   | L1 sync between instances                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| L2 is a `redisStore`                                                                                                                            | Automatic, over Redis Pub/Sub on that client                                                    |
| Custom L2 with an `invalidation` property                                                                                                       | Automatic, through that store's bus                                                             |
| Custom L2 plus an explicit `invalidation` option (for example `redisInvalidationBus({ client, channel? })`, or your own bus over NATS or Kafka) | Through the bus you pass                                                                        |
| No bus at all                                                                                                                                   | No sync. After a write or delete on another instance, L1 may serve stale data for up to `l1Ttl` |

The bus only affects L1 freshness. Data in L2 is always correct, and a single-instance app is not affected by a missing bus.
Without a bus, `tieredStore` still works and logs a warning at startup. When the Pub/Sub connection is
re-established, L1 is cleared because messages may have been missed. If Redis is unreachable when the app starts,
the subscription is retried once the connection is ready. This automatic re-subscribe after a failure happens only with
ioredis clients (through `ioredisAdapter`); custom adapters and buses must retry themselves. A bus may implement the optional `onError(handler)`;
`tieredStore` reports those errors as `error` events with `operation: 'subscribe'` (the Redis bus reports
errors of its subscriber connection this way).

### Custom Redis adapters

`redisStore({ client })` also accepts a `RedisClientAdapter` (see the TSDoc in `src/stores/redis-client.adapter.ts`).
Two rules matter for Cluster:

- `mget` and `unlink` receive keys that may belong to several hash slots. A Cluster adapter must split the command per
  slot.
- `scanIterator?(match, count)` is optional. When present, `clear` uses it instead of the `scan` cursor loop; it must
  yield the matching keys of every node that holds data (each master of a cluster), in pages.

## Events

```ts
import { Inject, Injectable } from '@nestjs/common';
import { CacheEvents } from '@loipv/nestjs-cache';

@Injectable()
export class CacheMonitor {
  constructor(@Inject(CacheEvents) events: CacheEvents) {
    const off = events.on('error', ({ store, operation, error }) => {
      // report to your monitoring
    });
  }
}
```

`on` returns an unsubscribe function. A listener that throws is swallowed and logged. `@Inject(CacheEvents)`
works without `emitDecoratorMetadata`; plain constructor injection (`constructor(events: CacheEvents)`) needs it.

| Event     | Payload                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `hit`     | `store`, `namespace`, `key`, `stale` (`true` for `swr` stale reads)       |
| `miss`    | `store`, `namespace`, `key`                                               |
| `set`     | `store`, `namespace`, `key`, `ttl`                                        |
| `delete`  | `store`, `namespace`, `keys`                                              |
| `clear`   | `store`, `namespace`                                                      |
| `load`    | `store`, `namespace`, `key`, `durationMs`, `success`, `keys` (batch only) |
| `error`   | `store`, `operation`, `error`                                             |
| `lock`    | `store`, `namespace`, `key`, `waitedMs`, `acquired`                       |
| `breaker` | `store`, `state` (`'closed'`, `'open'` or `'half-open'`)                  |

Repeated `error` log lines are throttled to one per 30 seconds for each (store, operation) pair; the next line carries a
`(+N similar errors suppressed)` suffix. Events are still emitted for every occurrence.

`operation` of an `error` event is one of `get`, `set`, `delete`, `clear`, `deserialize`, `key`, `publish`, `subscribe`, `refresh`, `lock`, `version`, `tag`.
The value `'metrics'` exists in the `CacheOperation` type but is used for logs only and is never emitted as an event.

## Observability

Three optional features: Prometheus metrics, a health check for `@nestjs/terminus`, and a configurable log level.
They ship from the main entry point and add no runtime or peer dependencies.

### Prometheus

`CachePrometheusModule` records metrics through a Prometheus client that you pass in. Use
[`@prometheus-io/client`](https://www.npmjs.com/package/@prometheus-io/client), the maintained successor of `prom-client`:

```bash
npm install @prometheus-io/client
```

`CachePrometheusModule` reads cache events, so it needs a global `CacheModule`: call
`CacheModule.forRoot({ isGlobal: true })`. Without it, Nest fails at startup with a missing dependency error.

```ts
import { Module } from '@nestjs/common';
import { CacheModule, CachePrometheusModule } from '@loipv/nestjs-cache';
import * as client from '@prometheus-io/client';

@Module({
  imports: [
    CacheModule.forRoot({ isGlobal: true }),
    CachePrometheusModule.forRoot({
      client, // the module itself: `import * as client from '...'`
      registry: client.register, // optional, defaults to client.register
      prefix: 'cache_', // optional, defaults to 'cache_'
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5], // optional, for both histograms
    }),
  ],
})
export class AppModule {}
```

`prom-client` works the same way, because the library only relies on structural types. Note that the `prom-client` package is
marked deprecated on npm in favour of `@prometheus-io/client`:

```ts
import { Module } from '@nestjs/common';
import { CacheModule, CachePrometheusModule } from '@loipv/nestjs-cache';
import * as client from 'prom-client';

@Module({
  imports: [CacheModule.forRoot({ isGlobal: true }), CachePrometheusModule.forRoot({ client })],
})
export class MetricsAppModule {}
```

There is also `forRootAsync({ imports, inject, useFactory })`, where `useFactory` returns the same options.

The module does not open an endpoint. Expose the registry yourself, for example with a controller:

```ts
import { Controller, Get, Header } from '@nestjs/common';
import * as client from '@prometheus-io/client';

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', client.register.contentType)
  metrics(): Promise<string> {
    return client.register.metrics();
  }
}
```

Metric names below use the default prefix `cache_`:

| Metric                  | Type      | Labels                                                  |
| ----------------------- | --------- | ------------------------------------------------------- |
| `requests_total`        | counter   | `store`, `namespace`, `result` (`hit`, `miss`, `stale`) |
| `errors_total`          | counter   | `store`, `operation`                                    |
| `load_duration_seconds` | histogram | `store`, `namespace`, `success` (`true`, `false`)       |
| `lock_wait_seconds`     | histogram | `store`, `acquired` (`true`, `false`)                   |
| `circuit_breaker_state` | gauge     | `store` (0 = closed, 1 = half-open, 2 = open)           |

- The key is never a label, so cardinality stays bounded. A missing `namespace` is recorded as `""`.
- There are no metrics for `set`, `delete` or `clear`.
- A miss that waits on a lock and is then served from the cache emits `miss` first and `hit` after, so it is counted as
  both a miss and a hit.
- Registering a name that already exists in the registry throws `CacheConfigError` at startup
  (`Metric "cache_requests_total" is already registered; use a different prefix or registry`). This happens when two
  apps in one process share `client.register`; give one of them another `prefix` or `registry`.
- The metrics are removed from the registry when the app closes, so a second app can start afterwards.
- A failure while updating a metric is logged as a warning, `Cache metrics failed on store "<store>": <message>`, at
  most once per 30 s per store (the same throttle as other store errors). Nothing is logged at `logging.level: 'off'`.
  It is never emitted as an `error` event, so `errors_total` is not affected.

Custom or fake clients: `PrometheusClientLike` and `RegistryLike` are structural types. A registry needs
`getSingleMetric`, `removeSingleMetric` and `registerMetric`, and the constructors are typed `new (config: never) => ...`.
See the TSDoc example on `PrometheusClientLike` for a minimal fake to use in tests.

### Health check

`CacheModule` provides `CacheHealthIndicator`. It does not import `@nestjs/terminus`; `check` returns the shape that
Terminus expects, and Terminus treats `down` as a failure (HTTP 503).

```ts
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { CacheHealthIndicator } from '@loipv/nestjs-cache';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly cache: CacheHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.cache.check('cache', { store: 'default', timeout: 500 })]);
  }
}
```

`check(key, { store, timeout })`: `store` defaults to `'default'` and `timeout` to `1000` ms. The call resolves to one of:

- `{ [key]: { status: 'up' } }`
- `{ [key]: { status: 'up', ping: 'unsupported' } }` when the store has no `ping`
- `{ [key]: { status: 'down', message } }`, where `message` is the error message, `'circuit open'` for an open breaker,
  or `'timed out after <timeout> ms'`

It never rejects, except with `CacheConfigError` for an unknown store name or a `timeout` that is not a finite number
from 1 to 2147483647. It does not emit `error` events, and a `ping` that rejects after the timeout is handled.

| Store                 | `ping`                                                                     |
| --------------------- | -------------------------------------------------------------------------- |
| `memoryStore`         | Always resolves                                                            |
| `redisStore`          | Redis `PING`. Present only when the Redis client adapter has `ping`        |
| `tieredStore`         | Calls the L2 store's `ping`. Present only when L2 has it                   |
| `circuitBreaker(...)` | Goes through the breaker: rejects with `CircuitOpenError` while it is open |
| Store without `ping`  | Reported as `up` with `ping: 'unsupported'`                                |

`ioredisAdapter` provides `ping` and `mget` only when the client has them; both are optional members of `IoredisLike`, so a hand-written stub can leave them out (health then reports `ping: 'unsupported'`).

With ioredis's default offline queue, a `ping` that timed out stays queued until ioredis gives up
(`maxRetriesPerRequest`, default 20), so frequent checks while Redis is down queue PINGs until then. Set
`maxRetriesPerRequest` low or `enableOfflineQueue: false` on the client if that matters. On a store wrapped with
`circuitBreaker(...)`, a failed `ping` counts toward `failureThreshold` like any other operation. Once `openDuration`
has passed, the next call, which may be a `ping`, becomes the single probe; while that probe is in flight (half-open),
other calls including `ping` are rejected with `CircuitOpenError`.

### Logging

```ts
CacheModule.forRoot({ logging: { level: 'error' } }); // 'off' | 'error' | 'debug'
```

Any other value throws `CacheConfigError`.

| Level               | What is logged                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'error'` (default) | The 0.2 logs: throttled store errors, startup and decorator warnings, plus circuit breaker logs (opened at `warn`, closed at `log`, never throttled) |
| `'debug'`           | Everything in `'error'`, plus one debug line per `hit`, `miss`, `set`, `delete`, `clear`, `load` and `lock` event                                    |
| `'off'`             | Nothing from the library, with one exception (below)                                                                                                 |

`'off'` silences store error logs, breaker logs, startup lock warnings, explorer and decorator warnings, the tiered
store's missing-bus warning, and metrics collector failures. Events are still emitted, so your own listeners and the
metrics keep working. The exception is the decorator warning
`<Class>.<method> was called on an instance not created by Nest; caching is skipped.`: it is logged at every level,
once per method, because no cache configuration exists at that point.

Debug lines have the form `Cache <event> <store> <key or namespace>[ <detail>]`. Keys appear in debug logs only:

```text
[Nest] DEBUG [CacheModule] Cache hit default users:user:1 stale
[Nest] DEBUG [CacheModule] Cache load default users:user:1 12ms ok
[Nest] DEBUG [CacheModule] Cache lock default users:user:1 waited 50ms acquired
```

### Grafana

`grafana/dashboard.json` in the repository is a sample dashboard (it is not part of the npm package). In Grafana,
open Dashboards, New, Import, upload the file and pick your Prometheus datasource for `DS_PROMETHEUS`. It assumes the
default `cache_` prefix and has a `store` variable. Panels: hit ratio, requests by result, errors by operation, load
p95, lock wait p95 and breaker state.

## Error behaviour

Cache failures never reach the caller. The only exception is `CacheConfigError`.

| Situation                                                                  | Behaviour                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store read fails                                                           | Treated as a miss, the original method runs, `error` is emitted                                                                                                                                                                                                                                           |
| Store write fails                                                          | The result is still returned, `error` is emitted                                                                                                                                                                                                                                                          |
| Delete or clear fails                                                      | No exception, `error` is emitted, logged at error level                                                                                                                                                                                                                                                   |
| Envelope unreadable or unknown `v`                                         | Miss, `error` with `operation: 'deserialize'`; key deleted only if it holds an object with a `v` field                                                                                                                                                                                                    |
| Key cannot be built or is empty                                            | Cache skipped, `error` with `operation: 'key'`; in a delete list only the empty key is skipped                                                                                                                                                                                                            |
| Namespace version cannot be read or written                                | `error` with `operation: 'version'`; `get` is a miss without a `miss` event, `getOrSet` loads without writing, `set` and `delete` do nothing; a tiered store (or any store with `getStrict`) uses the last known token instead (see [Versioned namespaces](#versioned-namespaces))                        |
| Tag list is invalid (empty tag, more than 32 tags, a callback that throws) | `error` with `operation: 'tag'`; the entry is not written and the caller still gets the value; `@CacheEvict` invalidates nothing and never rejects (see [Tags](#tags))                                                                                                                                    |
| Tag tokens cannot be read or written                                       | `error` with `operation: 'version'`; a tiered store (or any store with `getStrict`) uses the last known tokens, otherwise the tagged entry is a miss and `getOrSet` loads without writing; `invalidateTags` rejects with the first token-write error, `@CacheEvict` only emits events (see [Tags](#tags)) |
| Lock acquire or release fails, or a background refresh fails               | Load without the lock / keep the old value; `error` with `operation: 'lock'` or `'refresh'`                                                                                                                                                                                                               |
| The original method throws                                                 | The error reaches the caller, nothing is stored                                                                                                                                                                                                                                                           |
| `CircuitOpenError` from a breaker                                          | Never reaches callers and never emits `error`; read = miss, write/delete skipped                                                                                                                                                                                                                          |

`CacheConfigError` is thrown only in these cases:

| When                                | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class definition (decorators)       | Bad decorator options (`ttl`, `nullTtl`, `staleTtl`, `maxTtl`, `softTimeout`, a non-boolean `cacheNull`, key template, `allEntries` without `namespace`); `softTimeout` on `@CachePut`; `@Cacheable` together with `@CachePut`; a `static` method; `@CacheEvict({ key: [] })`; invalid decorator `tags` (not an array or function, an empty string, a malformed template, `@CacheEvict({ tags: [] })`); a namespace starting with `__`                                                 |
| `circuitBreaker(...)` / store setup | Invalid breaker or store options                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| App startup                         | Invalid module options (including `defaults.lock`, a non-boolean `defaults.cacheNull`, a duration <= 0, `jitter` outside `[0, 1)`, a missing `default` store, a bad `namespaces`, `versioning.cacheTtl` or `escapeKeyArgs`, a namespace starting with `__` in `namespaces`); a decorator naming an unknown store                                                                                                                                                                       |
| `CacheService` call (rejects)       | Unknown store name; invalid `ttl`, `nullTtl`, `staleTtl`, `maxTtl` or `softTimeout` (including `maxTtl < ttl`); `softTimeout` on `get`, `getMany`, `set` or `setMany`; a non-boolean `cacheNull`; unknown `strategy` name; `swr` without `staleTtl`; `clear('')`; a namespace starting with `__`; `keys` or `entries` that is not an array; `getOrSetMany` with `lock: true`; `invalidateTags` with an empty list, an empty string, a non-array, more than 32 tags or an unknown store |

`compressedSerializer(...)` with invalid options also throws `CacheConfigError`. Every other failure (store, serializer, key building, `unless`, lock, background refresh) goes through the `error`
event and does not reach the caller.

## Security

- **Redis is a trust boundary.** Anyone who can write to it can forge cached values, expiry timestamps and
  invalidation messages; the library checks their shape, not their authenticity. Use a dedicated Redis, or an ACL user
  limited to your keys and the channel (for `prefix: 'myapp'`: `~myapp:*` and `&<your channel>`). Lock keys live under
  the prefix since 0.4, so they need no separate pattern.
- **Set `prefix` when the Redis is shared**, and give each app its own invalidation `channel`. The default channel,
  `nestjs-cache:invalidate`, is shared by every app on that Redis.
- **Template keys render string arguments verbatim.** An argument containing `:` can address a key in another
  (sub-)namespace. Do not put untrusted input with `:` into template keys; use the default hashed key or a key callback
  that encodes it, or set `escapeKeyArgs: true`, which escapes `%` and `:` in template arguments.
- **Keys appear in debug logs and in invalidation messages.** Do not put secrets or personal data in keys; hash them.
- **The health check result includes the store's error message**, which can contain host names. Expose the health
  route internally only.
- **Use static namespaces.** A per-tenant or per-user namespace makes the Prometheus `namespace` label cardinality
  unbounded.
- **The lock is advisory.** A load that runs longer than `lock.ttl` lets another instance load too, and a waiter that
  does not get the lock or see the value within `waitTimeout` loads without the lock.
- **`memoryStore` is bounded by entry count, not bytes.** Size `maxEntries` for your largest values.
- **`strategy: 'sliding'` refreshes the key's TTL before the value is checked.** Keep untrusted input out of keys that
  could name foreign keys on a shared Redis; a `prefix` prevents this.
- **Cached values are replayed verbatim** to every reader until they expire. Validate data before it is cached.

## Caveats

- **JSON values.** Values pass through JSON: a `Date` becomes a string, and `Map`, `Set`, `BigInt` and class instances lose their type. A miss returns the original object; a hit returns the JSON-roundtripped copy. Provide a custom `Serializer` if you need to preserve types.
- **Default keys use the class name.** Minifiers that rename classes change the default keys. `Map`/`Set` arguments are ignored by the default key, which makes different caches collide; use an explicit `key`.
- **Default keys see only an argument's own enumerable data.** Arguments whose state lives in `#private` fields, getters or `Error` objects (and `-0` vs `0`, a `Date` vs its ISO string) can produce the same default key, so give those methods an explicit `key`. Template keys render strings raw, so `{0}:{1}` with `'a:b','c'` equals `'a','b:c'`. Choose separators that cannot appear in your values.
- **Two-tier staleness.** With a two-tier store, another instance can still serve stale data from L1 for up to `l1Ttl` if an invalidation message is lost, there is no bus, or the L2 circuit breaker is open (publishing is skipped).
- **Versioned namespaces.** Another instance sees a `clear` within `versioning.cacheTtl` (default 1 s) and can serve pre-clear data until then. A sub-namespace such as `users:admin` does not follow a versioned `users`. Old entries stay in Redis until their TTL expires. On a two-tier store, if an invalidation message is lost or there is no bus, another instance can keep the old token for up to `l1Ttl` (the version key is cached in L1), not only `versioning.cacheTtl`. While L2 is down, a two-tier store (or any store with `getStrict`) falls back to the last known token (one `version` error per failed read); with no known token the loader runs and nothing is cached. A `clear` while L2 is down fails and leaves the token unchanged. An instance that missed another instance's `clear` just before the outage keeps the old token during it, so stale data is limited to L1 and lasts at most `l1Ttl`. Turning `versioned: true` on for a namespace that already has entries starts it cold; the old entries expire by their TTL.
- **Tag invalidation windows.** An instance whose cached tag token is out of date re-reads it from the store when it sees a differing stamp (at most once per tag per `versioning.cacheTtl`), so after an invalidation other instances usually see it on their next read; when the re-read budget is used up they treat the entry as a miss until the next window. A sliding read whose tag mismatch is confirmed against the store deletes the entry (on tiered stores and stores with `getStrict` it is only a miss). A `getOrSet` issued after `invalidateTags` can join a load that started before it and receive that load's value once (with template tags the written entry is stale-stamped, so the next read misses), like the concurrent-misses caveat below.
- **`sliding` in `getMany`.** It calls `getAndTouch` for every key, one command per key, so it does not use `MGET`.
- **Decorators need Nest-instantiated classes.** Decorators only work on classes that NestJS instantiates, and the module using them must be able to see `CacheModule` (`isGlobal: true` is recommended).
- **Call `CacheModule.forRoot`/`forRootAsync` once** and use `isGlobal: true`. Each call creates an independent cache, and binds and closes its own stores.
- **Concurrent misses** on one key in one process are coalesced into one load, and options from callers that join an in-flight load are ignored (the first caller's `ttl`/`cacheNull`/`unless` apply). Use the distributed lock to coalesce across instances.
- **Background refresh is not awaited at shutdown.** A `swr` refresh in flight when the app closes may be cut off.
- **Callback arity.** A `key` or `condition` callback that declares more parameters than the method is not reported by TypeScript.
- **Failed eviction.** When `@CacheEvict` fails, stale data stays in the cache until its TTL expires. Watch the `error` event.
- **Redis.** Redis 6.2 or later is required; Cluster mode needs Redis 7 or later. See [Redis Cluster](#redis-cluster) for its limits (`clear` during resharding, no automatic hash tags).

## Compatibility

| Component          | Supported                                                  |
| ------------------ | ---------------------------------------------------------- |
| NestJS             | 11 (CommonJS) and 12 (ESM)                                 |
| Node.js            | `>=22` (LTS 22, 24, 26)                                    |
| ioredis            | `^5 \|\| ^6` (optional peer; Cluster needs 5.6.0 or later) |
| redis (node-redis) | `^5 \|\| ^6` (optional peer; Sentinel supported)           |
| Redis server       | 6.2 or later (Cluster: 7 or later)                         |

The package ships both ESM and CommonJS builds. The injection tokens use `Symbol.for('@loipv/nestjs-cache:...')`,
so they are shared when both builds are loaded in one process, and `instanceof CacheConfigError` matches errors
from either build. Classes are not shared: `CacheService`, `CacheEvents` and the other classes are injected by
class, so import the package from one build only (do not mix `import` and `require` of it in one app).
The library does not rely on `emitDecoratorMetadata`.

## Roadmap

- **0.2 - Resilience (done):** distributed lock (cross-instance stampede protection), per-store circuit breaker, `'swr'` (stale-while-revalidate) and `'sliding'` TTL strategies.
- **0.3 - Observability (done):** Prometheus metrics (`CachePrometheusModule`) with a sample Grafana dashboard, configurable log level with debug logs, circuit breaker logs, and a `@nestjs/terminus` health indicator (`CacheHealthIndicator`). All from the main entry point.
- **0.4 - Versioned namespaces and batches (done):** O(1) `clear` for opt-in versioned namespaces, `getMany`/`setMany`/`getOrSetMany`, `escapeKeyArgs`, lock keys under the prefix, and an optional `ping`.
- **0.5 - Redis Cluster and node-redis (done):** Redis Cluster through ioredis, `nodeRedisAdapter` for `redis` v5 (standalone and cluster), `CacheStore.getStrict`/`setStrict`, `RedisClientAdapter.scanIterator`, and the tiered-store fix for versioned namespaces while L2 is down.
- **0.6 - HTTP caching (done):** `@HttpCache` and `HttpCacheInterceptor` for opt-in route caching on Express and Fastify, and a [migration guide](docs/migration-from-cache-manager.md) from `@nestjs/cache-manager`.
- **0.7 - Tags (done):** `tags` on `@Cacheable`, `@CachePut`, `@HttpCache` and the `CacheService` writes, `CacheService.invalidateTags` and `@CacheEvict({ tags })`.
- **0.8 - Compression, Sentinel and `softTimeout` (done):** `compressedSerializer` (gzip and brotli), swr `softTimeout`, Redis Sentinel (ioredis and node-redis), and the tag token re-read.
- **0.9 - Planned:** replica reads and `redis` v6 support.

## Releasing

Versions and the CHANGELOG are managed with [Changesets](https://changesets.dev).

1. A pull request that changes the published package runs `npx changeset`, picks `patch`, `minor` or `major`, and
   commits the generated `.changeset/*.md` file. Tests, CI and docs-only changes need none.
2. When CI passes on `main`, the `Release` workflow opens or updates a "Version Packages" pull request that bumps
   `package.json` and `package-lock.json` and writes the CHANGELOG entry.
3. Merging that pull request runs CI again. When it passes and the version in `package.json` is not on npm yet, the
   workflow publishes it with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, with provenance,
   no npm token) and creates the `v<version>` git tag and GitHub Release.

The workflow only releases the commit that CI tested: if `main` has moved on by the time CI finishes, that run does
nothing and the newer commit's run takes over. Nothing is released while CI on `main` is red.

One-time setup for maintainers, in this order:

1. Publish the current version by hand and push its tag. npm only allows a trusted publisher once the package
   exists. Do this before the release workflow first runs on `main`, or that run will try to publish the unpublished
   version and fail.

   ```bash
   npm run build && npm publish
   git tag v0.3.0 && git push origin v0.3.0
   ```

2. On npmjs.com, add a trusted publisher to `@loipv/nestjs-cache`: GitHub Actions, repository `loipv/nestjs-cache`,
   workflow `release.yml` (exact file name), no environment.
3. In the GitHub repository, enable Settings > Actions > General > "Allow GitHub Actions to create and approve pull
   requests".
4. Protect `main` with a branch ruleset that requires pull requests and the `ci-ok` status check. `ci-ok` is an
   aggregate job in `ci.yml` that fails unless every other CI job and matrix cell succeeded, so it is the only check
   to require. It always runs, so a failed, skipped or cancelled job fails it instead of being counted as passing.
5. The "Version Packages" pull request is opened with the workflow's `GITHUB_TOKEN`, so CI does not run on it. Allow
   the maintainer to bypass the `ci-ok` requirement for that pull request (or exempt the `changeset-release/main`
   branch). The pull request only changes versions and the CHANGELOG, and CI runs on `main` after it is merged, before
   anything is published.

Workflow rules, enforced by `npm run check:workflows` in CI:

- Every action is pinned by full commit SHA with a `# vX.Y.Z` comment, because tags can be moved and the release jobs
  hold write permissions and the OIDC token. Dependabot (`.github/dependabot.yml`) proposes new pins weekly; read the
  upstream release notes before merging one.
- Every install runs with `--ignore-scripts`, so no dependency lifecycle script runs in CI or next to the release
  permissions. If a new dependency only works after its install script, CI fails first; run that package's script
  alone (`npm rebuild <package>`) in the job that needs it instead of dropping the flag.
- Every job has `timeout-minutes`. When you add a job to `ci.yml`, add it to `ci-ok`'s `needs`.

`npm run check:pack` (tarball contents) and `npm run check:pkg` (`publint` and `attw`) also run in CI and in
`prepublishOnly`.

## License

MIT
