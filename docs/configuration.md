# Configuration

This page lists the `CacheModule` options and their defaults, and explains null caching, TTL jitter and the expiry
strategies (`fixed`, `swr`, `sliding`).

[Back to the README](../README.md) · See also: [stores](stores.md), [decorators](decorators.md),
[`CacheService`](cache-service.md), [serializers](serializers.md)

## Module options

Pass the options to `CacheModule.forRoot(options)`, or return them from the `useFactory` of
`CacheModule.forRootAsync({ isGlobal, imports, inject, useFactory })`. A full `forRootAsync` example with Redis is in
[Stores](stores.md#redis-and-two-tier-setup).

| Option                | Type                                                  | Default                      | Meaning                                                                                    |
| --------------------- | ----------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| `prefix`              | `string`                                              | none                         | Prefix for every key                                                                       |
| `stores`              | `{ default: CacheStore; [name: string]: CacheStore }` | `{ default: memoryStore() }` | Named stores; a `default` store is required if you pass `stores`                           |
| `defaults.ttl`        | `number` (ms)                                         | `60_000`                     | TTL when a decorator does not set one                                                      |
| `defaults.jitter`     | `number` in `[0, 1)`                                  | `0`                          | Effective TTL = `ttl x (1 + r)`, `r` random in `[-jitter, +jitter]`                        |
| `defaults.cacheNull`  | `boolean`                                             | `false`                      | Whether `null`/`undefined` results are stored                                              |
| `defaults.nullTtl`    | `number` (ms)                                         | `30_000`                     | TTL for stored empty values                                                                |
| `namespaces`          | `{ [ns]: { versioned?: boolean } }`                   | none                         | Turns on [versioned namespaces](namespaces-and-tags.md#versioned-namespaces) (exact names) |
| `versioning.cacheTtl` | `number` (ms)                                         | `1_000`                      | How long an instance keeps a namespace version in memory                                   |
| `escapeKeyArgs`       | `boolean`                                             | `false`                      | Escapes `%` and `:` in string and number template arguments                                |
| `serializer`          | `Serializer`                                          | JSON                         | Envelope serializer                                                                        |
| `isGlobal`            | `boolean`                                             | `false`                      | Register the module globally                                                               |
| `defaults.lock`       | `CacheLockDefaults`                                   | lock off                     | The distributed lock; see [Distributed lock](resilience.md#distributed-lock)               |
| `logging.level`       | `'off' \| 'error' \| 'debug'`                         | `'error'`                    | What the library logs; see [Logging](observability.md#logging)                             |

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
import { Injectable } from '@nestjs/common';
import { Cacheable, type CacheService } from '@loipv/nestjs-cache';

// Your own code: the entity types, the injected service and a price lookup.
interface Product {
  id: string;
}
interface Session {
  userId: string;
}
declare const cache: CacheService;
declare function fetchPrice(id: string): Promise<number>;

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
import type { CacheService } from '@loipv/nestjs-cache';

declare const cache: CacheService;
declare function fetchPrice(id: string): Promise<number>;

const price = await cache.getOrSet('price:1', () => fetchPrice('1'), {
  namespace: 'prices',
  ttl: 10_000,
  strategy: 'swr',
  staleTtl: 60_000,
  softTimeout: 200,
});
```

`softTimeout` is accepted by `@Cacheable`, `@HttpCache`, `getOrSet` and `getOrSetMany`. A non-empty refreshed value is
returned when it arrives in time. An empty one (`null`, `undefined`, or a key a batch loader omits) is returned only if
it was actually written: `cacheNull` is on, and the write was not vetoed by `unless`, a rejected tag list or a failed
store write. Otherwise the stale value is returned, as on a timeout. A batch shares one window per call. The calls
that never load (`@CachePut`, `set`, `setMany`, `get` and `getMany`) do not accept it: their option types
(`StrategyOptions`) reject it at compile time, and a JavaScript caller gets `CacheConfigError`. The load calls take
`LoadStrategyOptions`, which adds it. On a load call it needs `strategy: 'swr'`: the types allow it only there, and
from JavaScript another strategy is a `CacheConfigError`.

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
