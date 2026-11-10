# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-10

### Added

- Expiry strategies `fixed`, `swr` (stale-while-revalidate, with `staleTtl`) and `sliding` (with optional `maxTtl`) for `@Cacheable`, `@CachePut`, `CacheService.getOrSet`, `CacheService.set` and `CacheService.get`.
- Optional distributed lock (`defaults.lock`, per-call `lock`) that coalesces concurrent misses across instances; `LockProvider`, `LockHandle` and `CacheStore.lock`, implemented by the Redis store and by a tiered store whose L2 has a lock.
- `circuitBreaker(store, options)`, `CircuitBreakerStore`, `CircuitOpenError` and the `CircuitBreakerOptions` and `BreakerState` types.
- `lock` and `breaker` events; `hit.stale` is `true` for `swr` stale reads.
- Optional `CacheStore.getAndTouch`, implemented by the memory, Redis and tiered stores.
- `MemoryStoreOptions` type export; `CacheLockDefaults` type export.

### Changed

- Repeated `error` log lines are throttled to one per 30 seconds for each (store, operation) pair, with a `(+N similar errors suppressed)` suffix. Events are still emitted for every occurrence.
- `package.json` now has `repository`, `homepage`, `bugs` and more keywords.

### Fixed

- Decorators on `static` methods are rejected with `CacheConfigError`.
- `@CacheEvict({ key: [] })` is rejected with `CacheConfigError`.
- Lock-unavailable warnings are de-duplicated (once per class and method).

## [0.1.0] - 2026-11-10

### Added

- `@Cacheable`, `@CachePut` and `@CacheEvict` decorators and a `CacheService` for direct calls.
- Named stores: in-memory LRU, Redis (ioredis) and a two-tier L1/L2 store with Pub/Sub invalidation.
- In-process coalescing of concurrent misses, optional null caching and TTL jitter.
- Dynamic keys from templates or callbacks, a `CacheEvents` emitter, and a pluggable serializer.
- Dual ESM and CommonJS build with no runtime dependencies.

[0.2.0]: https://github.com/loipv/nestjs-cache/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/loipv/nestjs-cache/releases/tag/v0.1.0
