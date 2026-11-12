# @loipv/nestjs-cache

Decorator-based caching for NestJS: Redis (ioredis or node-redis, Cluster, Sentinel) and two-tier stores, tags, stale-while-revalidate, stampede protection, HTTP caching and Prometheus metrics

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

Peer dependencies: `@nestjs/common`, `@nestjs/core` (`^11 || ^12`), `reflect-metadata` (`^0.2`) and `rxjs` (`^7.1`, which
Nest itself requires, so a Nest app already has it).
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

For Redis, Redis Cluster or Sentinel and the two-tier store, see [Stores](docs/stores.md). A runnable NestJS 12 app
with tags, `@HttpCache`, optional Redis and Prometheus is in [`examples/basic`](examples/basic/README.md).

## Documentation

- [Configuration](docs/configuration.md): module options and defaults, null caching, TTL jitter and the expiry
  strategies (`fixed`, `swr` with `softTimeout`, `sliding`).
- [Decorators](docs/decorators.md): `@Cacheable`, `@CachePut` and `@CacheEvict`, their options, and dynamic keys.
- [HTTP caching](docs/http-caching.md): `@HttpCache` on controller routes, on Express and Fastify.
- [`CacheService`](docs/cache-service.md): `get`, `set`, `delete`, `clear`, `getOrSet` and the batch methods
  `getMany`, `setMany` and `getOrSetMany`.
- [Stores](docs/stores.md): memory, Redis (ioredis or node-redis; standalone, Cluster or Sentinel), the two-tier
  store, custom stores and invalidation buses.
- [Versioned namespaces and tags](docs/namespaces-and-tags.md): an O(1) namespace `clear`, and tag invalidation with
  `invalidateTags` and `@CacheEvict({ tags })`.
- [Serializers](docs/serializers.md): custom serializers and gzip or brotli compression (`compressedSerializer`).
- [Resilience](docs/resilience.md): the distributed lock, the circuit breaker, and how errors are handled.
- [Events and observability](docs/observability.md): events, Prometheus metrics, the `@nestjs/terminus` health check,
  logging and a sample Grafana dashboard.
- [Tracing](docs/observability.md#tracing): opt-in OpenTelemetry spans for every cache call, with `CacheTracingModule`.
- [Security](docs/security.md) and [Caveats](docs/caveats.md).
- [Stability and semver](docs/semver.md): what 1.x keeps stable, and what counts as a major, minor or patch change.
- [Migrating from `@nestjs/cache-manager`](docs/migration-from-cache-manager.md).

## Compatibility

The semver contract is in [Stability and semver](docs/semver.md).

| Component          | Supported                                                  |
| ------------------ | ---------------------------------------------------------- |
| NestJS             | 11 (CommonJS) and 12 (ESM)                                 |
| Node.js            | `>=22` (LTS 22, 24, 26)                                    |
| TypeScript         | `>=5.4` (the published `.d.ts` is checked against 5.4)     |
| ioredis            | `^5 \|\| ^6` (optional peer; Cluster needs 5.6.0 or later) |
| redis (node-redis) | `^5 \|\| ^6` (optional peer; Sentinel supported)           |
| rxjs               | `^7.1` (peer, as for `@nestjs/common`)                     |
| Redis server       | 6.2 or later (Cluster: 7 or later)                         |

The decorators (`@Cacheable`, `@CachePut`, `@CacheEvict`, `@HttpCache`) are legacy decorators: consumers need
`experimentalDecorators: true` in `tsconfig.json`. Standard (TC39) decorators are not supported.

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
- **0.9 - Redis v6, docs and example (done):** `redis` v6 support, the docs split into `docs/`, an [example app](examples/basic/README.md), and an API tidy-up (see the changelog for the breaking changes).
- **0.10 - Tracing (done):** opt-in OpenTelemetry tracing (`CacheTracingModule`).
- **1.0 - API freeze (done):** the public API is frozen and follows [semver](docs/semver.md) from there.
- **After 1.0 - Replica reads (planned):** reads from Redis replicas.

## Changelog and releasing

Each version's changes are listed in [CHANGELOG.md](CHANGELOG.md). [RELEASING.md](RELEASING.md) describes how
releases are published and the rules the CI workflows follow.

## License

MIT
