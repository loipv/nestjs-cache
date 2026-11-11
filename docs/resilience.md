# Resilience

This page covers the distributed lock, the per-store circuit breaker, and what happens when the cache or a store fails.

[Back to the README](../README.md) · See also: [stores](stores.md), [events](observability.md#events),
[security](security.md)

## Distributed lock

Off by default. Without it, concurrent misses are coalesced per process only. With it, one instance loads while the
others wait and then read the stored value, so a miss costs one load across the whole cluster.

```ts
import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  Cacheable,
  CacheModule,
  memoryStore,
  redisStore,
  tieredStore,
  type CacheService,
} from '@loipv/nestjs-cache';

// Your own code: the Redis client, the injected service and the report loader.
interface Report {
  id: string;
}
declare const redis: Redis;
declare const cache: CacheService;
declare function buildReport(id: string): Promise<Report>;

CacheModule.forRoot({
  stores: { default: tieredStore({ l1: memoryStore(), l2: redisStore({ client: redis }) }) },
  defaults: {
    lock: { enabled: true, ttl: 10_000, waitTimeout: 3_000, retryDelay: 50 },
  },
});

@Injectable()
export class ReportService {
  @Cacheable({ namespace: 'reports', key: 'r:{0}', lock: true }) // per method, overrides defaults.lock.enabled
  build(id: string): Promise<Report> {
    return buildReport(id);
  }
}

await cache.getOrSet('report:1', () => buildReport('1'), { namespace: 'reports', lock: true });
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
import type { Redis } from 'ioredis';
import { circuitBreakerStore, memoryStore, redisStore, tieredStore } from '@loipv/nestjs-cache';

declare const redis: Redis; // your own client

const store = tieredStore({
  l1: memoryStore(),
  l2: circuitBreakerStore(redisStore({ client: redis }), {
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
  otherwise `circuitBreakerStore` throws `CacheConfigError`. `circuitBreakerStore(...)` returns a `CircuitBreakerStore`, its options are
  typed `CircuitBreakerOptions`, and `breaker` events carry a `BreakerState`.
- Guarded: `get`, `set`, `delete`, `clear`, `getAndTouch`, `getMany`, `setMany`, `getStrict`, `setStrict`, `ping`,
  `lock.acquire` and `lock.release`. `invalidation`, `bind` and `close` are passed through. The breaker has the
  optional ones (`getAndTouch`, `getMany`, `setMany`, `getStrict`, `setStrict`, `ping` and `lock`) only if the wrapped
  store does.
- `clear` is guarded by the breaker `timeout`. For big namespaces (Redis `SCAN`/`UNLINK` loops) use a larger `timeout`, otherwise `@CacheEvict({ allEntries: true })` can trip the breaker.
- A result that arrives after its command timed out is ignored: it does not reset the failure count or change the
  state. If an `acquire` times out but the lock is granted late, the late lock is released best-effort.
- `CircuitOpenError` never reaches your code and never emits `error`: reads count as a miss, writes are skipped, and
  loads run without the lock. Every state change emits a `breaker` event.
- In a tiered store, an open L2 circuit means L1 keeps serving and L1 writes still happen, but invalidation messages
  are not published. L1 entries on other instances can therefore stay stale for up to `l1Ttl` while the circuit is
  open.

## Error behaviour

Cache failures never reach the caller. There are two exceptions: `CacheConfigError`, and `CacheService.invalidateTags`,
which rejects when a tag version write fails (so the caller knows the invalidation did not happen; `@CacheEvict({ tags })`
does not reject).

| Situation                                                                  | Behaviour                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store read fails                                                           | Treated as a miss, the original method runs, `error` is emitted                                                                                                                                                                                                                                           |
| Store write fails                                                          | The result is still returned, `error` is emitted                                                                                                                                                                                                                                                          |
| Delete or clear fails                                                      | No exception, `error` is emitted, logged at error level                                                                                                                                                                                                                                                   |
| Envelope unreadable or unknown `v` | Miss, `error` with `operation: 'deserialize'`; key deleted only if it holds an object with a `v` field that the serializer returned, or that `jsonSerializer` or `compressedSerializer(jsonSerializer)` finds when it throws; a payload that cannot be decompressed is kept (see [Compression](serializers.md#compression)) |
| Key cannot be built or is empty                                            | Cache skipped, `error` with `operation: 'key'`; in a delete list only the empty key is skipped                                                                                                                                                                                                            |
| Namespace version cannot be read or written                                | `error` with `operation: 'version'`; `get` is a miss without a `miss` event, `getOrSet` loads without writing, `set` and `delete` do nothing; a tiered store (or any store with `getStrict`) uses the last known token instead (see [Versioned namespaces](namespaces-and-tags.md#versioned-namespaces))                        |
| Tag list is invalid (empty tag, more than 32 tags, a callback that throws) | `error` with `operation: 'tag'`; the entry is not written and the caller still gets the value; `@CacheEvict` invalidates nothing and never rejects (see [Tags](namespaces-and-tags.md#tags))                                                                                                                                    |
| Tag tokens cannot be read or written                                       | `error` with `operation: 'version'`; a tiered store (or any store with `getStrict`) uses the last known tokens, otherwise the tagged entry is a miss and `getOrSet` loads without writing; `invalidateTags` rejects with the first token-write error, `@CacheEvict` only emits events (see [Tags](namespaces-and-tags.md#tags)) |
| Lock acquire or release fails, or a background refresh fails               | Load without the lock / keep the old value; `error` with `operation: 'lock'` or `'refresh'`                                                                                                                                                                                                               |
| The original method throws                                                 | The error reaches the caller, nothing is stored                                                                                                                                                                                                                                                           |
| `CircuitOpenError` from a breaker                                          | Never reaches callers and never emits `error`; read = miss, write/delete skipped                                                                                                                                                                                                                          |

`CacheConfigError` is thrown only in these cases:

| When                                     | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class definition (decorators)            | Bad decorator options (`ttl`, `nullTtl`, `staleTtl`, `maxTtl`, `softTimeout`, a non-boolean `cacheNull`, `lock`, `allEntries` or `beforeInvocation`, a non-function `condition` or `unless`, key template, `allEntries` without `namespace`); `softTimeout` on `@CachePut`, or without `strategy: 'swr'` on `@Cacheable` or `@HttpCache`; `@Cacheable` together with `@CachePut`; a `static` method; `@CacheEvict({ key: [] })`; invalid decorator `tags` (not an array or function, an empty string, a malformed template, `@CacheEvict({ tags: [] })`); a namespace starting with `__` |
| `circuitBreakerStore(...)` / store setup | Invalid breaker or store options                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| App startup                              | Invalid module options (including `defaults.lock`, a non-boolean `defaults.cacheNull`, a duration <= 0, `jitter` outside `[0, 1)`, a missing `default` store, a bad `namespaces`, `versioning.cacheTtl` or `escapeKeyArgs`, a namespace starting with `__` in `namespaces`); a decorator naming an unknown store                                                                                                                                                                                                           |
| `CacheService` call (rejects)            | Unknown store name; invalid `ttl`, `nullTtl`, `staleTtl`, `maxTtl` or `softTimeout` (including `maxTtl < ttl`); `softTimeout` on `get`, `getMany`, `set` or `setMany`, or without `strategy: 'swr'` on `getOrSet` or `getOrSetMany`; a non-boolean `cacheNull`, or `lock` on `getOrSet`; unknown `strategy` name; `swr` without `staleTtl`; `clear('')`; a namespace starting with `__`; `keys` or `entries` that is not an array; `getOrSetMany` with `lock: true`; `invalidateTags` with an empty list, an empty string, a non-array, more than 32 tags or an unknown store            |

`compressedSerializer(...)` with invalid options also throws `CacheConfigError`. Every other failure (store, serializer, key building, `unless`, lock, background refresh) goes through the `error`
event and does not reach the caller.
