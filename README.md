# @loipv/nestjs-cache

Multi-store, two-tier cache for NestJS with decorators, stampede protection and null caching.

- `@Cacheable`, `@CachePut` and `@CacheEvict` decorators, plus a `CacheService` for direct calls.
- Named stores: in-memory, Redis (ioredis) and a two-tier L1/L2 store synced over Pub/Sub.
- Concurrent misses on the same key are coalesced into one load (per process).
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

`memoryStore({ maxEntries? })` is an LRU store; `maxEntries` defaults to `1_000`.

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
| `strategy`             | `@Cacheable`              | `'fixed'` (the only strategy in 0.1)                                              |
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

Unknown store names fail at startup. A bad key template, `allEntries` without `namespace`, and a `ttl`/`nullTtl`
that is not a finite number greater than 0 are rejected with `CacheConfigError`.

## Dynamic keys

The full key is `<prefix>:<namespace>:<key>`; missing parts are dropped together with their `:`.

- **Template:** `{N}` is the Nth argument (from 0); `{N.a.b}` reads a nested property. Primitives use `String()`, objects use JSON with sorted keys. Templates are positional because parameter names do not exist at runtime. A malformed template throws at class definition.
- **Callback:** receives the method arguments and returns a string.
- **Default:** `<ClassName>.<methodName>`, followed by `:<hash>` when there are arguments. The hash is the first 16 hex characters of the SHA-1 of the arguments' JSON (sorted keys).
- If a key cannot be built (unserializable argument, a callback that throws), the cache is skipped, the original method runs and an `error` event with `operation: 'key'` is emitted.

## CacheService

```ts
class CacheService {
  get<T>(key: string, options?: KeyOptions): Promise<T | undefined>;
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

`KeyOptions` is `{ namespace?, store? }`, `WriteOptions` adds `ttl`, and `GetOrSetOptions` adds `cacheNull`,
`nullTtl` and `unless`. `get` returns `undefined` on a miss. `clear` needs a non-empty namespace and rejects
`''` with `CacheConfigError`. `T` is your assertion; the library does not
validate stored data at runtime.

## Null caching and TTL jitter

Both are off by default.

- **Null caching** (`cacheNull: true`) stores `null`/`undefined` results for `nullTtl` (default `30_000` ms), which protects the backend from repeated lookups of missing data. Set it globally in `defaults` or per method. `null` and `undefined` are kept distinct.
- **TTL jitter** (`defaults.jitter`, a number in `[0, 1)`) spreads expirations: the effective TTL is `ttl x (1 + r)` with `r` random in `[-jitter, +jitter]`, which avoids many keys expiring at the same moment.

## Custom stores and invalidation buses

Implement the `CacheStore` interface (see the TSDoc in `src/stores/cache-store.interface.ts`):

```ts
interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  clear(prefix: string): Promise<void>;
  getAndTouch?(key: string, ttlMs: number): Promise<string | undefined>; // used from 0.2
  readonly invalidation?: InvalidationBus;
  bind?(events: CacheEventSink): void;
  close?(): Promise<void>;
}
```

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
re-established, L1 is cleared because messages may have been missed.

## Events

```ts
import { CacheEvents } from '@loipv/nestjs-cache';

constructor(events: CacheEvents) {
  const off = events.on('error', ({ store, operation, error }) => {
    // report to your monitoring
  });
}
```

`on` returns an unsubscribe function. A listener that throws is swallowed and logged.

| Event    | Payload                                                      |
| -------- | ------------------------------------------------------------ |
| `hit`    | `store`, `namespace`, `key`, `stale` (always `false` in 0.1) |
| `miss`   | `store`, `namespace`, `key`                                  |
| `set`    | `store`, `namespace`, `key`, `ttl`                           |
| `delete` | `store`, `namespace`, `keys`                                 |
| `clear`  | `store`, `namespace`                                         |
| `load`   | `store`, `namespace`, `key`, `durationMs`, `success`         |
| `error`  | `store`, `operation`, `error`                                |

`operation` is one of `get`, `set`, `delete`, `clear`, `deserialize`, `key`, `publish`, `subscribe`, `refresh`, `lock`.

## Error behaviour

Cache failures never reach the caller. The only exception is `CacheConfigError`.

| Situation                                                                             | Behaviour                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Store read fails                                                                      | Treated as a miss, the original method runs, `error` is emitted                       |
| Store write fails                                                                     | The result is still returned, `error` is emitted                                      |
| Delete or clear fails                                                                 | No exception, `error` is emitted, logged at error level                               |
| Envelope unreadable or unknown `v`                                                    | Treated as a miss, key deleted, `error` with `operation: 'deserialize'`               |
| Key cannot be built                                                                   | Cache skipped, `error` with `operation: 'key'`                                        |
| The original method throws                                                            | The error reaches the caller, nothing is stored                                       |
| Unknown store name, missing `default` store, duration <= 0, `jitter` outside `[0, 1)` | The app fails at startup (or the `CacheService` call rejects with `CacheConfigError`) |
| `CacheService.clear('')` (empty namespace)                                            | The call rejects with `CacheConfigError` and nothing is cleared                       |
| Bad key template, `@Cacheable` with `@CachePut`, `allEntries` without `namespace`     | Throws at class definition                                                            |

## Caveats

- **JSON values.** Values pass through JSON: a `Date` becomes a string, and `Map`, `Set`, `BigInt` and class instances lose their type. A miss returns the original object; a hit returns the JSON-roundtripped copy. Provide a custom `Serializer` if you need to preserve types.
- **Default keys use the class name.** Minifiers that rename classes change the default keys. `Map`/`Set` arguments are ignored by the default key, which makes different caches collide; use an explicit `key`.
- **Default keys see only an argument's own enumerable data.** Arguments whose state lives in `#private` fields, getters or `Error` objects (and `-0` vs `0`, a `Date` vs its ISO string) can produce the same default key, so give those methods an explicit `key`. Template keys render strings raw, so `{0}:{1}` with `'a:b','c'` equals `'a','b:c'`. Choose separators that cannot appear in your values.
- **Two-tier staleness.** With a two-tier store, another instance can still serve stale data from L1 for up to `l1Ttl` if an invalidation message is lost or there is no bus.
- **Decorators need Nest-instantiated classes.** Decorators only work on classes that NestJS instantiates, and the module using them must be able to see `CacheModule` (`isGlobal: true` is recommended).
- **Call `CacheModule.forRoot`/`forRootAsync` once** and use `isGlobal: true`. Each call creates an independent cache, and binds and closes its own stores.
- **Concurrent misses** on one key in one process are coalesced into one load, and options from callers that join an in-flight load are ignored (the first caller's `ttl`/`cacheNull`/`unless` apply).
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

- **0.2 - Resilience:** distributed lock (cross-instance stampede protection), per-store circuit breaker, `'swr'` (stale-while-revalidate) and `'sliding'` TTL strategies.
- **0.3 - Observability:** Prometheus metrics (`@loipv/nestjs-cache/prometheus`) with a sample Grafana dashboard, configurable log level with debug hit/miss logs, and a `@nestjs/terminus` health indicator (`@loipv/nestjs-cache/terminus`).

## License

MIT
