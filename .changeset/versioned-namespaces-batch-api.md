---
'@loipv/nestjs-cache': minor
---

Versioned namespaces, a batch API and safer keys.

Added:

- Versioned namespaces: `namespaces: { users: { versioned: true } }` and `versioning: { cacheTtl }` (default 1000 ms).
  `clear` and `@CacheEvict({ allEntries: true })` write a new version token with one `SET` and no `SCAN`.
- Batch API on `CacheService`: `getMany`, `setMany` and `getOrSetMany`. The `load` event carries `keys` for a batch
  loader call.
- `escapeKeyArgs` module option: escapes `%` and `:` in string and number template arguments (off by default).
- Optional `getMany` and `setMany` on `CacheStore`; `redisStore` uses `MGET`. `IoredisLike` and
  `RedisClientAdapter` gain an optional `mget`.
- `IoredisLike.ping` is now optional; the health check reports `ping: 'unsupported'` for a store without it.

Changed:

- Lock keys are now `<prefix>:__lock__:<namespace>:<key>` (`__lock__:<namespace>:<key>` without a prefix). During a
  rolling deploy, 0.3 and 0.4 nodes do not exclude each other, so a loader may run twice.
- Custom `LockProvider`s now receive that complete key.
- Namespaces starting with `__` are reserved and throw `CacheConfigError`.
- `CacheOperation` gains `'version'`.
