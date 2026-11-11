---
'@loipv/nestjs-cache': minor
---

Redis Cluster, node-redis and a tiered-store fix.

Added:

- Redis Cluster through ioredis: pass a `Cluster` to `redisStore`. It needs ioredis 5.6.0 or later (sharded Pub/Sub) and
  Redis 7 or later. `MGET` and `UNLINK` are split per hash slot, and `clear` scans every master.
- `nodeRedisAdapter` for `redis` v5 (new optional peer dependency), standalone and cluster.
- Optional `CacheStore.getStrict` and `setStrict`, for stores whose `get` and `set` degrade instead of rejecting.
- Optional `RedisClientAdapter.scanIterator`, used by `clear` when present.

Fixed:

- A tiered store with a versioned namespace no longer creates its own token when L2 is down (R5): a failed version read
  falls back to the last known token.
- `clear` of a versioned namespace while L2 is down no longer changes the token in L1 only (R4): it reports a `version`
  error and leaves the token unchanged.
