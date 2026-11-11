---
'@loipv/nestjs-cache': minor
---

Cache tags.

Added:

- Tags: `tags` on `@Cacheable`, `@CachePut`, `@HttpCache` and on `CacheService.set`, `getOrSet`, `setMany` and
  `getOrSetMany`. An entry is stamped with the version of each of its tags.
- `CacheService.invalidateTags(tags, { store? })` and `@CacheEvict({ tags })`: invalidated entries become misses and
  expire by their TTL.
- The types `TagSpec`, `HttpCacheTags`, `WriteManyOptions` and `GetOrSetManyOptions`.

Changed:

- `CacheOperation` gains `'tag'` (an invalid runtime tag list). The stored envelope gains an optional `tags` field
  (`CacheEnvelope`); instances on 0.6 ignore it, so entries written without a tag stamp (by 0.6 instances, or before `tags` was added
  to a method or call) are not affected by `invalidateTags` until their own TTL. When adding tags to an existing cache,
  clear the affected namespaces after the rollout (or wait one TTL).
- The HTTP interceptor no longer calls the `key` callback twice when applied twice, and its cache call starts only when
  the response is subscribed to.
- The ioredis sharded subscriber uses one consistent condition to decide when to use sharded Pub/Sub.
- Cluster `clear` with no known master rejects in both Redis adapters (behaviour unchanged, the code is now shared).
