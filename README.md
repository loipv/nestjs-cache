# @loipv/nestjs-cache

Multi-store, two-tier cache for NestJS with decorators, stampede protection and null caching.

- `@Cacheable`, `@CachePut` and `@CacheEvict` decorators, plus a `CacheService` for direct calls.
- Named stores: in-memory, Redis (ioredis or node-redis, standalone or Cluster) and a two-tier L1/L2 store synced over Pub/Sub.
- Concurrent misses on the same key are coalesced into one load (per process), or across instances with the optional distributed lock.
- Expiry strategies: `fixed`, `swr` (stale-while-revalidate) and `sliding`.
- Per-store circuit breaker for Redis outages.
- Optional null caching and TTL jitter, both off by default.
- No runtime dependencies. Dual ESM and CommonJS build.

## Install

```bash
npm install @loipv/nestjs-cache
```

Peer dependencies: `@nestjs/common`, `@nestjs/core` (`^11 || ^12`) and `reflect-metadata` (`^0.2`).
`ioredis` (`^5 || ^6`) and `redis` (`^5`, node-redis) are optional peers; install the one you use for the Redis store.

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
  On ioredis below 5.6.0, `SSUBSCRIBE` fails with a `MOVED` error, reported as an `error` event with
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

`nodeRedisAdapter` wraps a [`redis`](https://github.com/redis/node-redis) v5 client or cluster. `redis` (`^5.0.0`) is
an optional peer dependency. Pass a client that is already `connect()`ed: the adapter only connects the subscriber
connection it duplicates itself. Cluster mode is detected automatically (the client has `masters`).

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
  off for that instance until restart; the error is reported once. With the default strategies the subscriber keeps
  retrying.

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

| Option                 | Decorator                 | Meaning                                                                           |
| ---------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `key`                  | all three                 | Template or callback (see Dynamic keys). `@CacheEvict` also accepts an array      |
| `namespace`            | all three                 | Key group; the unit for bulk eviction                                             |
| `store`                | all three                 | Store name, defaults to `default`                                                 |
| `ttl`                  | `@Cacheable`, `@CachePut` | Overrides `defaults.ttl`                                                          |
| `strategy`             | `@Cacheable`, `@CachePut` | `'fixed'` (default), `'swr'` or `'sliding'` (see Expiry strategies)               |
| `staleTtl`, `maxTtl`   | `@Cacheable`, `@CachePut` | Strategy parameters (`swr` needs `staleTtl`; `sliding` accepts `maxTtl`)          |
| `lock`                 | `@Cacheable`              | `true`/`false` overrides `defaults.lock.enabled` (see Distributed lock)           |
| `cacheNull`, `nullTtl` | `@Cacheable`, `@CachePut` | Per-method override of the defaults                                               |
| `condition`            | `@Cacheable`, `@CachePut` | Receives the method arguments; `false` skips the cache                            |
| `unless`               | `@Cacheable`, `@CachePut` | Receives the result; `true` prevents storing it                                   |
| `allEntries`           | `@CacheEvict`             | Clear the whole namespace; requires `namespace` and cannot be combined with `key` |
| `beforeInvocation`     | `@CacheEvict`             | `true`: evict before the method runs. Default: evict after it succeeds            |

Behaviour:

- `@Cacheable`: on a hit, returns the cached value (including a stored empty value). On a miss, runs the method and stores the result.
- `@CachePut`: always runs the method. If `condition` is `false` or `unless` is `true` the cache is untouched. An empty result while `cacheNull` is off deletes the key. Otherwise the result is stored.
- `@CacheEvict`: evicts after the method succeeds; a method that throws evicts nothing. With `beforeInvocation: true` it evicts first, regardless of the outcome.
- A method can carry several `@CacheEvict`, or `@CachePut` together with `@CacheEvict`. `@Cacheable` together with `@CachePut` on one method throws at class definition.

Type checking: decorating a method that does not return a `Promise` is a compile error. The `key` and
`condition` callbacks type their own parameters, and the compiler checks that the method accepts them.
Callbacks may declare fewer parameters than the method.

Unknown store names fail at startup. A bad key template, `allEntries` without `namespace`, an empty `key: []` for
`@CacheEvict`, a `static` method, and a `ttl`/`nullTtl`/`staleTtl`/`maxTtl` that is not a finite number greater than 0
are rejected with `CacheConfigError`, as is a `cacheNull` that is not a boolean. See Error behaviour for the full list.

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
- On a `tieredStore`, a failed version read falls back to the last token this process knew, with one `version` error
  per failure; the next call reads the store again. With no known token the loader runs and nothing is cached. A failed
  `clear` (L2 down) reports a `version` error and leaves the token unchanged, so it no longer moves the token in L1
  only. With a plain Redis store the fallback means the data read fails too, so you see the `version` error plus a
  `get` error.
- Remaining risk: an instance that missed another instance's `clear` just before an outage keeps the old token during
  the outage. The stale data comes from L1 only, so it lasts at most `l1Ttl`.

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

`operation` of an `error` event is one of `get`, `set`, `delete`, `clear`, `deserialize`, `key`, `publish`, `subscribe`, `refresh`, `lock`, `version`.
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

| Situation                                                    | Behaviour                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store read fails                                             | Treated as a miss, the original method runs, `error` is emitted                                                                                                                                                                                    |
| Store write fails                                            | The result is still returned, `error` is emitted                                                                                                                                                                                                   |
| Delete or clear fails                                        | No exception, `error` is emitted, logged at error level                                                                                                                                                                                            |
| Envelope unreadable or unknown `v`                           | Miss, `error` with `operation: 'deserialize'`; key deleted only if it holds an object with a `v` field                                                                                                                                             |
| Key cannot be built or is empty                              | Cache skipped, `error` with `operation: 'key'`; in a delete list only the empty key is skipped                                                                                                                                                     |
| Namespace version cannot be read or written                  | `error` with `operation: 'version'`; `get` is a miss without a `miss` event, `getOrSet` loads without writing, `set` and `delete` do nothing; a tiered store uses the last known token instead (see [Versioned namespaces](#versioned-namespaces)) |
| Lock acquire or release fails, or a background refresh fails | Load without the lock / keep the old value; `error` with `operation: 'lock'` or `'refresh'`                                                                                                                                                        |
| The original method throws                                   | The error reaches the caller, nothing is stored                                                                                                                                                                                                    |
| `CircuitOpenError` from a breaker                            | Never reaches callers and never emits `error`; read = miss, write/delete skipped                                                                                                                                                                   |

`CacheConfigError` is thrown only in these cases:

| When                                | Cases                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class definition (decorators)       | Bad decorator options (`ttl`, `nullTtl`, `staleTtl`, `maxTtl`, a non-boolean `cacheNull`, key template, `allEntries` without `namespace`); `@Cacheable` together with `@CachePut`; a `static` method; `@CacheEvict({ key: [] })`; a namespace starting with `__`                                                 |
| `circuitBreaker(...)` / store setup | Invalid breaker or store options                                                                                                                                                                                                                                                                                 |
| App startup                         | Invalid module options (including `defaults.lock`, a non-boolean `defaults.cacheNull`, a duration <= 0, `jitter` outside `[0, 1)`, a missing `default` store, a bad `namespaces`, `versioning.cacheTtl` or `escapeKeyArgs`, a namespace starting with `__` in `namespaces`); a decorator naming an unknown store |
| `CacheService` call (rejects)       | Unknown store name; invalid `ttl`, `nullTtl`, `staleTtl` or `maxTtl` (including `maxTtl < ttl`); a non-boolean `cacheNull`; unknown `strategy` name; `swr` without `staleTtl`; `clear('')`; a namespace starting with `__`; `keys` or `entries` that is not an array; `getOrSetMany` with `lock: true`           |

Every other failure (store, serializer, key building, `unless`, lock, background refresh) goes through the `error`
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
- **Versioned namespaces.** Another instance sees a `clear` within `versioning.cacheTtl` (default 1 s) and can serve pre-clear data until then. A sub-namespace such as `users:admin` does not follow a versioned `users`. Old entries stay in Redis until their TTL expires. On a two-tier store, if an invalidation message is lost or there is no bus, another instance can keep the old token for up to `l1Ttl` (the version key is cached in L1), not only `versioning.cacheTtl`. While L2 is down, a two-tier store falls back to the last known token (one `version` error per failed read); with no known token the loader runs and nothing is cached. A `clear` while L2 is down fails and leaves the token unchanged. An instance that missed another instance's `clear` just before the outage keeps the old token during it, so stale data is limited to L1 and lasts at most `l1Ttl`. Turning `versioned: true` on for a namespace that already has entries starts it cold; the old entries expire by their TTL.
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
| redis (node-redis) | `^5` (optional peer)                                       |
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
- **0.6 - Tags and HTTP caching (planned):** cache tags, `HttpCacheInterceptor`, and a migration guide.

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
