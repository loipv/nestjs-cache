---
'@loipv/nestjs-cache': minor
---

HTTP caching and a migration guide from `@nestjs/cache-manager`.

Added:

- `@HttpCache` and `HttpCacheInterceptor`: opt-in caching of `GET` and `HEAD` route responses on Express and Fastify,
  with a normalized default key, a per-request `key` callback and the same options and strategies as `@Cacheable`.
- The types `HttpCacheOptions` and `HttpCacheRequest`.
- A migration guide from `@nestjs/cache-manager` (`docs/migration-from-cache-manager.md`).
