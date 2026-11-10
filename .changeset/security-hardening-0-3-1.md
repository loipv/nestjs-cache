---
'@loipv/nestjs-cache': patch
---

Security hardening:

- A cached value that cannot be deserialized is still a miss with an `error` event (`operation: 'deserialize'`), but
  the key is now deleted only when it holds an object with a `v` field (a broken envelope of this library). Lock
  tokens and other apps' keys on a shared Redis are no longer deleted by a read.
- A decorator key template or callback that renders an empty string is a key error (`error` with
  `operation: 'key'`, the method runs uncached), and so is an empty key passed to `CacheService` (`get` returns
  `undefined`, `getOrSet` runs the loader uncached, `set` does nothing). `CacheService.delete` and `@CacheEvict` key
  lists drop the empty keys, report one key error and still delete the other keys. Before, `''` collapsed to the
  bare namespace key.
- An invalidation message longer than 1 MiB is no longer parsed; it clears the whole L1 instead.
- `stableStringify` detects cycles with a `Set` (same output, faster on deep arguments).
- `memoryStore` at capacity sweeps expired entries at most once a second instead of on every insert, and otherwise
  evicts the least recently used entry.
- `cacheNull` must be a boolean: a non-boolean `defaults.cacheNull` now fails at startup, a non-boolean decorator
  `cacheNull` fails at class definition, and `CacheService.getOrSet` rejects one, each with `CacheConfigError`. Apps
  that pass a string such as `'false'` (which was truthy and turned null caching on) must pass a boolean.

The README has a new Security section.
