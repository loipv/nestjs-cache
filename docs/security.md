# Security

This page lists what to watch for when the cache runs on a shared or untrusted Redis, or holds untrusted input.

[Back to the README](../README.md) · See also: [caveats](caveats.md), [stores](stores.md)

- **Redis is a trust boundary.** Anyone who can write to it can forge cached values, expiry timestamps and
  invalidation messages; the library checks their shape, not their authenticity. Use a dedicated Redis, or an ACL user
  limited to your keys and the channel (for `prefix: 'myapp'`: `~myapp:*` and `&<your channel>`). Lock keys live under
  the prefix since 0.4, so they need no separate pattern.
- **Set `prefix` when the Redis is shared**, and give each app its own invalidation `channel`. The default channel,
  `nestjs-cache:invalidate`, is shared by every app on that Redis.
- **Template keys render string arguments verbatim.** An argument containing `:` can address a key in another
  (sub-)namespace. Do not put untrusted input with `:` into template keys; use the default hashed key or a key callback
  that encodes it, or set `escapeKeyArgs: true`, which escapes `%` and `:` in template arguments.
  Keys starting with `__` and no namespace are rejected as a key error (cache skipped, `error` with
  `operation: 'key'`), so untrusted input cannot reach the library's internal `__version__`, `__tag__` and `__lock__`
  keys. This does not replace `escapeKeyArgs`: input with `:` can still address another namespace.
- **Keys appear in debug logs and in invalidation messages.** Do not put secrets or personal data in keys; hash them.
- **The health check result includes the store's error message**, which can contain host names. Expose the health
  route internally only.
- **Use static namespaces.** A per-tenant or per-user namespace makes the Prometheus `namespace` label cardinality
  unbounded.
- **The lock is advisory.** A load that runs longer than `lock.ttl` lets another instance load too, and a waiter that
  does not get the lock or see the value within `waitTimeout` loads without the lock.
- **`memoryStore` is bounded by entry count, not bytes.** Size `maxEntries` for your largest values.
- **`strategy: 'sliding'` refreshes the key's TTL before the value is checked.** Keep untrusted input out of keys that
  could name foreign keys on a shared Redis; a `prefix` prevents this.
- **Cached values are replayed verbatim** to every reader until they expire. Validate data before it is cached.
