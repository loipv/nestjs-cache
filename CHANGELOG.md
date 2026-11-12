# Changelog

## 1.0.0

### Major Changes

- First release on npm.

  `@loipv/nestjs-cache` 1.0.0 is the first published version. The public API is frozen and follows
  [semver](https://github.com/loipv/nestjs-cache/blob/main/docs/semver.md) from here.

  - Requirements: Node 22 or later; TypeScript 5.4 or later with `experimentalDecorators`; peers `@nestjs/common` and `@nestjs/core` `^11.0.0 || ^12.0.0`, `rxjs` `^7.1.0`, `reflect-metadata` `^0.2.0`, and the optional `ioredis` `^5.0.0 || ^6.0.0` or `redis` `^5.0.0 || ^6.0.0`.
  - `escapeKeyArgs` defaults to `false`: template arguments are not escaped unless you enable it, see [security](https://github.com/loipv/nestjs-cache/blob/main/docs/security.md).
  - Decorators: `@Cacheable`, `@CachePut`, `@CacheEvict` and the `CacheService` API, see [decorators](https://github.com/loipv/nestjs-cache/blob/main/docs/decorators.md) and [the service](https://github.com/loipv/nestjs-cache/blob/main/docs/cache-service.md).
  - Stores: memory, Redis (ioredis or node-redis v5/v6, Cluster, Sentinel) and tiered L1/L2 with invalidation, see [stores](https://github.com/loipv/nestjs-cache/blob/main/docs/stores.md).
  - Resilience: distributed locks, circuit breaker, `swr` and `sliding` strategies, `softTimeout`, see [resilience](https://github.com/loipv/nestjs-cache/blob/main/docs/resilience.md).
  - Namespaces and tags: versioned namespaces with O(1) `clear`, batch API, tag invalidation, see [namespaces and tags](https://github.com/loipv/nestjs-cache/blob/main/docs/namespaces-and-tags.md).
  - HTTP caching: `@HttpCache` on Express and Fastify, see [HTTP caching](https://github.com/loipv/nestjs-cache/blob/main/docs/http-caching.md).
  - Serializers and compression: JSON serializer and gzip or brotli `compressedSerializer` (with a `level` option; brotli defaults to quality 4), see [serializers](https://github.com/loipv/nestjs-cache/blob/main/docs/serializers.md).
  - Observability: Prometheus metrics, `@nestjs/terminus` health indicator and OpenTelemetry tracing, see [observability](https://github.com/loipv/nestjs-cache/blob/main/docs/observability.md).
  - Security and migration: see [security](https://github.com/loipv/nestjs-cache/blob/main/docs/security.md) and [migrating from `@nestjs/cache-manager`](https://github.com/loipv/nestjs-cache/blob/main/docs/migration-from-cache-manager.md).

Versions 0.1.0 to 0.3.0 below were never published to npm.

## [0.3.0] - 2026-11-10

### Added

- `CachePrometheusModule` (`forRoot` and `forRootAsync`) that records cache metrics through a Prometheus client you pass in (`@prometheus-io/client` or `prom-client`), with the `PrometheusClientLike`, `RegistryLike` and `CachePrometheusOptions` types.
- `CacheHealthIndicator` and `CacheHealthResult`, a health check in the shape `@nestjs/terminus` expects.
- `CacheStore.ping` (optional), implemented by the memory, Redis, tiered and circuit breaker stores.
- `logging.level` (`'off'`, `'error'` or `'debug'`) and the `CacheLogLevel` type.
- Log lines when a circuit breaker opens (`warn`) or closes (`log`).
- Sample Grafana dashboard in `grafana/dashboard.json` (in the repository, not in the npm package).

### Changed

- Metrics and health ship from the main entry point, not from the `/prometheus` and `/terminus` subpaths planned earlier. The CommonJS build would otherwise bundle a second copy of the `CacheEvents` class into each entry point, and the metrics collector and the module would then use different classes.
- Prometheus clients are passed in by the user; there is no new peer dependency.
- `IoredisLike` gained a required `ping()`. Real ioredis clients are unaffected, but hand-written stubs must add it.
- `CacheEventSink` gained an optional `logLevel` field. This is additive.
- `CacheOperation` gained the value `'metrics'`, used for logs only; `error` events never carry it.

## [0.2.0] - 2026-11-10

### Added

- Expiry strategies `fixed`, `swr` (stale-while-revalidate, with `staleTtl`) and `sliding` (with optional `maxTtl`) for `@Cacheable`, `@CachePut`, `CacheService.getOrSet`, `CacheService.set` and `CacheService.get`.
- Optional distributed lock (`defaults.lock`, per-call `lock`) that coalesces concurrent misses across instances; `LockProvider`, `LockHandle` and `CacheStore.lock`, implemented by the Redis store and by a tiered store whose L2 has a lock.
- `circuitBreaker(store, options)`, `CircuitBreakerStore`, `CircuitOpenError` and the `CircuitBreakerOptions` and `BreakerState` types.
- `lock` and `breaker` events; `hit.stale` is `true` for `swr` stale reads.
- `getAndTouch` (already optional on `CacheStore` and implemented by `RedisStore` in 0.1) is now also implemented by the memory and tiered stores.
- `MemoryStoreOptions` type export; `CacheLockDefaults` type export.

### Changed

- `WriteOptions` is now a type alias containing a union, so `interface X extends WriteOptions` no longer compiles; use `type X = WriteOptions & { ... }`.
- `IoredisLike` gained a required `eval` and a `set ... 'NX'` overload. Real ioredis clients are unaffected, but hand-written fakes must add them.
- Repeated `error` log lines are throttled to one per 30 seconds for each (store, operation) pair, with a `(+N similar errors suppressed)` suffix. Events are still emitted for every occurrence.
- `package.json` now has `repository`, `homepage`, `bugs` and more keywords.
- `defaults.lock` must be an object: `null`, a string, a number, a boolean or an array throws `CacheConfigError` (`undefined` still means the defaults).

### Fixed

- Decorators on `static` methods are rejected with `CacheConfigError`.
- `@CacheEvict({ key: [] })` is rejected with `CacheConfigError`.
- Lock-unavailable warnings are de-duplicated once per class, method and store, so a method that names two stores without a lock warns for each.

## [0.1.0] - 2026-11-10

### Added

- `@Cacheable`, `@CachePut` and `@CacheEvict` decorators and a `CacheService` for direct calls.
- Named stores: in-memory LRU, Redis (ioredis) and a two-tier L1/L2 store with Pub/Sub invalidation.
- In-process coalescing of concurrent misses, optional null caching and TTL jitter.
- Dynamic keys from templates or callbacks, a `CacheEvents` emitter, and a pluggable serializer.
- Dual ESM and CommonJS build with no runtime dependencies.

[0.3.0]: https://github.com/loipv/nestjs-cache/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/loipv/nestjs-cache/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/loipv/nestjs-cache/releases/tag/v0.1.0
