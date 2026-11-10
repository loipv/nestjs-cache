# @loipv/nestjs-cache

Multi-store, two-tier cache for NestJS with decorators, stampede protection and null caching.

- `@Cacheable`, `@CachePut` and `@CacheEvict` decorators, plus a `CacheService` for direct calls.
- Named stores: in-memory, Redis (ioredis) and a two-tier L1/L2 store synced over Pub/Sub.
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
`ioredis` (`^5 || ^6`) is an optional peer and is only needed for the Redis store.

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

| Option               | Type                                                  | Default                      | Meaning                                                             |
| -------------------- | ----------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| `prefix`             | `string`                                              | none                         | Prefix for every key                                                |
| `stores`             | `{ default: CacheStore; [name: string]: CacheStore }` | `{ default: memoryStore() }` | Named stores; a `default` store is required if you pass `stores`    |
| `defaults.ttl`       | `number` (ms)                                         | `60_000`                     | TTL when a decorator does not set one                               |
| `defaults.jitter`    | `number` in `[0, 1)`                                  | `0`                          | Effective TTL = `ttl x (1 + r)`, `r` random in `[-jitter, +jitter]` |
| `defaults.cacheNull` | `boolean`                                             | `false`                      | Whether `null`/`undefined` results are stored                       |
| `defaults.nullTtl`   | `number` (ms)                                         | `30_000`                     | TTL for stored empty values                                         |
| `serializer`         | `Serializer`                                          | JSON                         | Envelope serializer                                                 |
| `isGlobal`           | `boolean`                                             | `false`                      | Register the module globally                                        |

`redisStore({ client, channel? })` accepts an ioredis instance (or a `RedisClientAdapter`). The default
Pub/Sub channel is `nestjs-cache:invalidate`. Redis 6.2 or later is required (the store uses `GETEX`).

`memoryStore({ maxEntries? })` is an LRU store (`MemoryStoreOptions`); `maxEntries` defaults to `1_000`.

`tieredStore({ l1, l2, l1Ttl?, invalidation? })` reads L1 first, then L2 (refilling L1 with `l1Ttl`).
Writes go to L2, then L1 with `min(ttl, l1Ttl)`, then an invalidation message is published.
`l1Ttl` defaults to `10_000`.

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
are rejected with `CacheConfigError`. See Error behaviour for the full list.

## Dynamic keys

The full key is `<prefix>:<namespace>:<key>`; missing parts are dropped together with their `:`.

- **Template:** `{N}` is the Nth argument (from 0); `{N.a.b}` reads a nested property. Primitives use `String()`, objects use JSON with sorted keys. Templates are positional because parameter names do not exist at runtime. A malformed template throws at class definition.
- **Callback:** receives the method arguments and returns a string.
- **Default:** `<ClassName>.<methodName>`, followed by `:<hash>` when there are arguments. The hash is the first 16 hex characters of the SHA-1 of the arguments' JSON (sorted keys).
- If a key cannot be built (unserializable argument, a callback that throws, a template or callback that renders an empty string), the cache is skipped, the original method runs and an `error` event with `operation: 'key'` is emitted.

## CacheService

```ts
class CacheService {
  get<T>(key: string, options?: KeyOptions & StrategyOptions): Promise<T | undefined>;
  set<T>(key: string, value: T, options?: WriteOptions): Promise<void>;
  delete(key: string | readonly string[], options?: KeyOptions): Promise<void>;
  clear(namespace: string, options?: { store?: string }): Promise<void>;
  getOrSet<T>(key: string, loader: () => Promise<T>, options?: GetOrSetOptions<T>): Promise<T>;
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
`''` with `CacheConfigError`. `T` is your assertion; the library does not
validate stored data at runtime.

An empty key is a key error (`error` with `operation: 'key'`): `get` returns `undefined`, `getOrSet` runs the loader
without caching, and `set`/`delete` do nothing (one empty key in a `delete` list skips the whole call).

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

Entries written by 0.1 carry only `expiresAt`; read with `swr` they are fresh until then, and then expired.
`CacheService.get` returns a stale entry (with `hit.stale: true`) but never refreshes, as it has no loader.

**Sliding and `CacheService.get`.** `CacheService.get(key, { strategy: 'sliding' })` resets the entry's window to
`defaults.ttl`, not to the `ttl` the entry was written with, because the store needs the new TTL before the entry is
read. Pass the same TTL through `defaults.ttl`, or read with `getOrSet`, which knows the call's `ttl`. Sliding uses the
store's `getAndTouch`, which is atomic in the memory and Redis stores. A tiered store does not touch L2 on an L1 hit, so
the window is refreshed on L1 misses only (about once per `l1Ttl` per instance), and the backfill is capped at
`min(ttl, l1Ttl)`; its atomicity depends on L2, and an L2 without `getAndTouch` is read with a plain `get`, which does
not extend it. A custom store without `getAndTouch` falls back to a `get` followed by a `set`, which is not atomic. `null` values stored with `cacheNull` always use `fixed` and `nullTtl`.

Validation: `staleTtl` and `maxTtl` must be finite numbers greater than 0, `maxTtl` must be `>= ttl` (the call's `ttl`
or `defaults.ttl`), and an unknown `strategy` name or `swr` without `staleTtl` is rejected with `CacheConfigError`.

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
- Lock keys are `lock:<fullKey>`. Without a `prefix`, do not use a namespace literally named `lock`: `clear('lock')` would delete live locks. Setting a `prefix` avoids this.
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
  readonly lock?: LockProvider; // used by the distributed lock
  readonly invalidation?: InvalidationBus;
  bind?(events: CacheEventSink): void;
  close?(): Promise<void>;
}
```

`getAndTouch` should be implemented by stores that can do it atomically: without it, `sliding` falls back to a `get`
followed by a `set`, which is not atomic. `lock` is a `LockProvider` (`acquire(key, ttlMs)` returns a `LockHandle` or
`undefined`; `LockHandle.release()` frees it). Leave both members out when unsupported; do not define them as
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

| Event     | Payload                                                             |
| --------- | ------------------------------------------------------------------- |
| `hit`     | `store`, `namespace`, `key`, `stale` (`true` for `swr` stale reads) |
| `miss`    | `store`, `namespace`, `key`                                         |
| `set`     | `store`, `namespace`, `key`, `ttl`                                  |
| `delete`  | `store`, `namespace`, `keys`                                        |
| `clear`   | `store`, `namespace`                                                |
| `load`    | `store`, `namespace`, `key`, `durationMs`, `success`                |
| `error`   | `store`, `operation`, `error`                                       |
| `lock`    | `store`, `namespace`, `key`, `waitedMs`, `acquired`                 |
| `breaker` | `store`, `state` (`'closed'`, `'open'` or `'half-open'`)            |

Repeated `error` log lines are throttled to one per 30 seconds for each (store, operation) pair; the next line carries a
`(+N similar errors suppressed)` suffix. Events are still emitted for every occurrence.

`operation` of an `error` event is one of `get`, `set`, `delete`, `clear`, `deserialize`, `key`, `publish`, `subscribe`, `refresh`, `lock`.
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

`ioredisAdapter` provides `ping`. A hand-written `IoredisLike` stub must now add `ping()`.

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

| Situation                                                    | Behaviour                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Store read fails                                             | Treated as a miss, the original method runs, `error` is emitted                                        |
| Store write fails                                            | The result is still returned, `error` is emitted                                                       |
| Delete or clear fails                                        | No exception, `error` is emitted, logged at error level                                                |
| Envelope unreadable or unknown `v`                           | Miss, `error` with `operation: 'deserialize'`; key deleted only if it holds an object with a `v` field |
| Key cannot be built or is empty                              | Cache skipped, `error` with `operation: 'key'`                                                         |
| Lock acquire or release fails, or a background refresh fails | Load without the lock / keep the old value; `error` with `operation: 'lock'` or `'refresh'`            |
| The original method throws                                   | The error reaches the caller, nothing is stored                                                        |
| `CircuitOpenError` from a breaker                            | Never reaches callers and never emits `error`; read = miss, write/delete skipped                       |

`CacheConfigError` is thrown only in these cases:

| When                                | Cases                                                                                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class definition (decorators)       | Bad decorator options (`ttl`, `nullTtl`, `staleTtl`, `maxTtl`, key template, `allEntries` without `namespace`); `@Cacheable` together with `@CachePut`; a `static` method; `@CacheEvict({ key: [] })` |
| `circuitBreaker(...)` / store setup | Invalid breaker or store options                                                                                                                                                                      |
| App startup                         | Invalid module options (including `defaults.lock`, a duration <= 0, `jitter` outside `[0, 1)`, a missing `default` store); a decorator naming an unknown store                                        |
| `CacheService` call (rejects)       | Unknown store name; invalid `ttl`, `nullTtl`, `staleTtl` or `maxTtl` (including `maxTtl < ttl`); unknown `strategy` name; `swr` without `staleTtl`; `clear('')`                                       |

Every other failure (store, serializer, key building, `unless`, lock, background refresh) goes through the `error`
event and does not reach the caller.

## Caveats

- **JSON values.** Values pass through JSON: a `Date` becomes a string, and `Map`, `Set`, `BigInt` and class instances lose their type. A miss returns the original object; a hit returns the JSON-roundtripped copy. Provide a custom `Serializer` if you need to preserve types.
- **Default keys use the class name.** Minifiers that rename classes change the default keys. `Map`/`Set` arguments are ignored by the default key, which makes different caches collide; use an explicit `key`.
- **Default keys see only an argument's own enumerable data.** Arguments whose state lives in `#private` fields, getters or `Error` objects (and `-0` vs `0`, a `Date` vs its ISO string) can produce the same default key, so give those methods an explicit `key`. Template keys render strings raw, so `{0}:{1}` with `'a:b','c'` equals `'a','b:c'`. Choose separators that cannot appear in your values.
- **Two-tier staleness.** With a two-tier store, another instance can still serve stale data from L1 for up to `l1Ttl` if an invalidation message is lost, there is no bus, or the L2 circuit breaker is open (publishing is skipped).
- **Decorators need Nest-instantiated classes.** Decorators only work on classes that NestJS instantiates, and the module using them must be able to see `CacheModule` (`isGlobal: true` is recommended).
- **Call `CacheModule.forRoot`/`forRootAsync` once** and use `isGlobal: true`. Each call creates an independent cache, and binds and closes its own stores.
- **Concurrent misses** on one key in one process are coalesced into one load, and options from callers that join an in-flight load are ignored (the first caller's `ttl`/`cacheNull`/`unless` apply). Use the distributed lock to coalesce across instances.
- **Background refresh is not awaited at shutdown.** A `swr` refresh in flight when the app closes may be cut off.
- **Callback arity.** A `key` or `condition` callback that declares more parameters than the method is not reported by TypeScript.
- **Failed eviction.** When `@CacheEvict` fails, stale data stays in the cache until its TTL expires. Watch the `error` event.
- **Redis.** Redis 6.2 or later is required. Redis Cluster is not supported yet (single node and Sentinel are).

## Compatibility

| Component    | Supported                    |
| ------------ | ---------------------------- |
| NestJS       | 11 (CommonJS) and 12 (ESM)   |
| Node.js      | `>=22` (LTS 22, 24, 26)      |
| ioredis      | `^5 \|\| ^6` (optional peer) |
| Redis server | 6.2 or later                 |

The package ships both ESM and CommonJS builds. The injection tokens use `Symbol.for('@loipv/nestjs-cache:...')`,
so they are shared when both builds are loaded in one process, and `instanceof CacheConfigError` matches errors
from either build. Classes are not shared: `CacheService`, `CacheEvents` and the other classes are injected by
class, so import the package from one build only (do not mix `import` and `require` of it in one app).
The library does not rely on `emitDecoratorMetadata`.

## Roadmap

- **0.2 - Resilience (done):** distributed lock (cross-instance stampede protection), per-store circuit breaker, `'swr'` (stale-while-revalidate) and `'sliding'` TTL strategies.
- **0.3 - Observability (done):** Prometheus metrics (`CachePrometheusModule`) with a sample Grafana dashboard, configurable log level with debug logs, circuit breaker logs, and a `@nestjs/terminus` health indicator (`CacheHealthIndicator`). All from the main entry point.

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
4. The "Version Packages" pull request is opened with the workflow's `GITHUB_TOKEN`, so CI does not run on it. If a
   branch ruleset requires CI checks on pull requests, allow the maintainer to bypass it for that pull request (or
   exempt the `changeset-release/main` branch). The pull request only changes versions and the CHANGELOG, and CI runs
   on `main` after it is merged, before anything is published.

## License

MIT
