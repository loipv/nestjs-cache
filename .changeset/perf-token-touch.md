---
'@loipv/nestjs-cache': minor
---

Fewer Redis commands and less work on the hot paths.

Added:

- Optional `CacheStore.touch?(keys, ttlMs)` and `CacheStore.setIfAbsent?(key, value, ttlMs)`, implemented by the memory,
  Redis, tiered and circuit breaker stores. Custom stores need no change.
- `defaults.refreshBackoff` (default `1000` ms, `0` disables): a stale-while-revalidate refresh that wrote nothing is
  not retried for that long, so a failing loader is no longer called once per stale read.
- The `CacheOperation` value `'touch'`, used by `error` events when a token refresh fails.
- Optional `RedisClientAdapter.setMany?(entries)`. `ioredisAdapter` implements it as a pipeline (one pipeline per hash
  slot on Cluster). node-redis already pipelines commands issued in the same tick.

Changed:

- Version and tag tokens are refreshed (TTL back to 30 days) at most about once a day per process while they are in use,
  on stores that have `touch`. Tokens of namespaces and tags that stay in use no longer expire after 30 days.
- New tag and namespace tokens are created with `setIfAbsent`: 2 commands instead of 3.
- Redis `clear` scans 1 000 keys per page (was 100) and runs up to 4 `UNLINK` commands at once.
- Tiered invalidation messages that carry keys are split into messages of at most 256 KiB, so a large `setMany` no
  longer makes peers drop their whole L1.
- Locked loads re-read the key after the lock is acquired and serve a value written meanwhile without calling the
  loader. The lock is released in the background, off the caller's path.
