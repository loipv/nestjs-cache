---
'@loipv/nestjs-cache': minor
---

Version and tag tokens in use no longer expire after 30 days, and the hot paths send fewer Redis commands.

Added:

- Optional `CacheStore.touch?(keys, ttlMs)` and `CacheStore.setIfAbsent?(key, value, ttlMs)`, implemented by the memory,
  Redis, tiered and circuit breaker stores. Both members are optional, so a custom store without them keeps working
  unchanged. The library now calls them whenever a store has them: a custom store that already has a `touch` or
  `setIfAbsent` member with another meaning must rename it.
- `defaults.refreshBackoff` (default `1000` ms, `0` disables): a stale-while-revalidate refresh that wrote nothing is
  not retried for that long.
- The `CacheOperation` value `'touch'`, used by `error` events when a token refresh fails.

Changed:

- Version and tag tokens are refreshed (TTL back to 30 days) about once a day per process while they are in use, on
  stores that have `touch`. Tokens of namespaces and tags that stay in use no longer expire after 30 days.
- New tag and namespace tokens are created with `setIfAbsent` on stores that have it: 2 commands instead of 3.
- swr refresh backoff is on by default: a failing loader is retried at most once per `refreshBackoff` (1 s) per key
  instead of once per stale read, so `load` and `error` events (and `errors_total{operation="refresh"}`) drop
  accordingly. Set `defaults.refreshBackoff: 0` to keep the 1.0 behaviour.
- Redis `clear` scans 1 000 keys per page (was 100) and runs up to 4 `UNLINK` commands at once.
- Tiered invalidation messages that carry keys are split into messages of at most 256 KiB, so a large `setMany` no
  longer makes peers drop their whole L1.
- Locked loads re-read the key after the lock is acquired and serve a value written meanwhile without calling the
  loader. The lock is released in the background, off the caller's path.
