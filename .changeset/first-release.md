---
'@loipv/nestjs-cache': major
---

First release on npm.

`@loipv/nestjs-cache` 1.0.0 is the first published version. The public API is frozen and follows
[semver](https://github.com/loipv/nestjs-cache/blob/main/docs/semver.md) from here.

- Decorators: `@Cacheable`, `@CachePut`, `@CacheEvict` and the `CacheService` API, see [decorators](https://github.com/loipv/nestjs-cache/blob/main/docs/decorators.md) and [the service](https://github.com/loipv/nestjs-cache/blob/main/docs/cache-service.md).
- Stores: memory, Redis (ioredis or node-redis v5/v6, Cluster, Sentinel) and tiered L1/L2 with invalidation, see [stores](https://github.com/loipv/nestjs-cache/blob/main/docs/stores.md).
- Resilience: distributed locks, circuit breaker, `swr` and `sliding` strategies, `softTimeout`, see [resilience](https://github.com/loipv/nestjs-cache/blob/main/docs/resilience.md).
- Namespaces and tags: versioned namespaces with O(1) `clear`, batch API, tag invalidation, see [namespaces and tags](https://github.com/loipv/nestjs-cache/blob/main/docs/namespaces-and-tags.md).
- HTTP caching: `@HttpCache` on Express and Fastify, see [HTTP caching](https://github.com/loipv/nestjs-cache/blob/main/docs/http-caching.md).
- Serializers and compression: JSON serializer and gzip or brotli `compressedSerializer`, see [serializers](https://github.com/loipv/nestjs-cache/blob/main/docs/serializers.md).
- Observability: Prometheus metrics, `@nestjs/terminus` health indicator and OpenTelemetry tracing, see [observability](https://github.com/loipv/nestjs-cache/blob/main/docs/observability.md).
- Security and migration: see [security](https://github.com/loipv/nestjs-cache/blob/main/docs/security.md) and [migrating from `@nestjs/cache-manager`](https://github.com/loipv/nestjs-cache/blob/main/docs/migration-from-cache-manager.md).
