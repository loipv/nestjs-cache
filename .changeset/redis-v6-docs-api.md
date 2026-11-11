---
'@loipv/nestjs-cache': minor
---

`redis` v6 support, a docs and example overhaul, and an API tidy-up before 1.0.

Added:

- Support for `redis` v6: the peer dependency is `^5.0.0 || ^6.0.0`.
- The documentation is split into `docs/` (with its code examples type-checked in CI), and `RELEASING.md` describes
  the release process. Every public export has JSDoc.
- `examples/basic`: a NestJS 12 app with `@Cacheable`, `@CacheEvict({ tags })`, `@HttpCache` and optional Redis and
  Prometheus. `npm run example:check` installs the packed tarball into it and runs a smoke test in CI.
- The types `LoadStrategyOptions`, `RedisInvalidationBusOptions` (taken by `redisInvalidationBus`; `RedisStoreOptions`
  extends it with the same fields) and `CachePrometheusAsyncOptions` (taken by `CachePrometheusModule.forRootAsync`).
- Runtime validation for JavaScript callers: `@Cacheable` with a non-boolean `lock`, `@Cacheable` or `@CachePut` with
  a non-function `condition` or `unless`, and `@CacheEvict` with a non-boolean `allEntries` or `beforeInvocation`
  throw `CacheConfigError` at class definition. `getOrSet` with a non-boolean `lock` rejects with `CacheConfigError`.

Changed:

- `rxjs` (`^7.1.0`) is now a peer dependency instead of being bundled into `dist`. A Nest app already has it.
- `CACHE_ENGINE` is no longer exported from the package. It is an internal token for an internal class. Migration:
  inject `CacheService` instead.
- `CACHE_OPTIONS`, `CACHE_ENGINE_PROPERTY` and `CACHE_METADATA` are no longer exported. Migration: none needed. They
  were internal keys, and `CACHE_OPTIONS` could not be injected outside `CacheModule`.
- `PrometheusMetricConfig` is no longer exported. Migration: if you used it, declare
  `{ name: string; help: string; labelNames: readonly string[]; registers: readonly RegistryLike[] }` locally.
- `softTimeout` is supported only where the cache loads: `@Cacheable`, `@HttpCache`, `getOrSet` and `getOrSetMany`.
  `StrategyOptions` now has `softTimeout?: never` and types `@CachePut`, `set`, `setMany`, `get` and `getMany`. The
  new `LoadStrategyOptions` (with `softTimeout` on `swr`) types the load calls. From JavaScript, `softTimeout` on
  `@CachePut` throws `CacheConfigError` at class definition, and on `get`, `getMany`, `set` or `setMany` the call
  rejects with `CacheConfigError`. Migration: remove `softTimeout` from those calls, where it never had an effect.
  Use `LoadStrategyOptions` where you typed strategy options that carry `softTimeout`.
- `GetOrSetOptions` and `GetOrSetManyOptions` are no longer `WriteOptions & …` / `WriteManyOptions & …`. They have the
  same fields, with `LoadStrategyOptions`. Migration: a value typed `GetOrSetOptions` that sets `softTimeout` is no
  longer assignable to `WriteOptions`. Drop `softTimeout` before passing it to `set`.
- `GetOrSetManyOptions.lock` is typed `false` (was `boolean`). Migration: remove `lock: true` from `getOrSetMany`
  calls. It always rejected with `CacheConfigError`.
- `CacheEvents.emit` and `CacheEvents.sinkFor` are no longer in the published types. They were marked `@internal`.
  Migration: listeners (`on`) are unaffected. Code that emitted events, for example to fake them in tests, must use
  its own emitter.
- `CacheOperation` no longer includes `'metrics'`, which an `error` event never carried. Migration: drop any
  `case 'metrics'`, which never ran.
- The `circuitBreaker` factory is renamed `circuitBreakerStore`, to pair with its class `CircuitBreakerStore`. Migration:
  `circuitBreaker(store, opts)` becomes `circuitBreakerStore(store, opts)`. Its option errors now say
  `Invalid circuitBreakerStore option …` instead of `Invalid circuitBreaker option …`; update any code that matches
  the message.
- Foreign-version envelopes are now cleaned up under `compressedSerializer(jsonSerializer)`, as they already were
  under the plain `jsonSerializer`.
- With `strategy: 'swr'` and `softTimeout`, a call returns the stale value when the refresh produced an empty value
  that was not actually written. That also covers `cacheNull`, when `unless`, a skipped tag stamp or a store write
  failure prevented the write.
