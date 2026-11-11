---
'@loipv/nestjs-cache': minor
---

Compression, swr `softTimeout`, Redis Sentinel and tag improvements.

Added:

- `compressedSerializer`: gzip or brotli compression of payloads above a threshold, readable alongside uncompressed
  entries (the type `CompressedSerializerOptions`).
- `softTimeout` for `strategy: 'swr'` on `@Cacheable`, `@HttpCache`, `getOrSet` and `getOrSetMany`: a stale hit waits up
  to that many milliseconds for the refresh and returns the fresh value if it arrives in time.
- Redis Sentinel: ioredis clients created with `sentinels` work with `redisStore`; node-redis `createSentinel(...)`
  clients are detected by `nodeRedisAdapter` (the type `NodeRedisSentinelLike`). A Sentinel `MASTER_CHANGE` clears L1.

Changed:

- Tags: when an entry's stamp differs from the cached tag token, the token is re-read from the store (at most once per
  tag per `versioning.cacheTtl`) and a confirmed match is a hit, so instances stop rewriting each other's entries after
  an invalidation and invalidations are usually visible on the next read.
- Tags: a sliding read whose tag mismatch is confirmed against the store deletes the entry instead of extending it
  (not on tiered stores or stores with `getStrict`).
