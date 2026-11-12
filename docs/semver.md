# Stability and semver

From 1.0.0, `@loipv/nestjs-cache` follows [semantic versioning](https://semver.org). This page defines what the
contract covers, what it leaves out, and which kind of change is a major, a minor or a patch.

[Back to the README](../README.md) · See also: [releasing](../RELEASING.md), [resilience](resilience.md),
[observability](observability.md)

## What is covered

- **Public names.** Every name exported from the root entry point, with its documented members, signatures, option
  fields and defaults. The import paths are `@loipv/nestjs-cache` (ESM and CommonJS) and
  `@loipv/nestjs-cache/package.json`. Nothing else can be imported.
- **Inferred decorator types.** The types TypeScript infers for `Cacheable`, `CachePut`, `CacheEvict` and `HttpCache`
  are covered. Explicit type arguments to those decorators and to the `*Options<...>` generics are best effort: a new
  type parameter is only added last, with a default. Strategy names and option names are a major change to remove or
  rename.
- **Documented runtime behaviour.** What `docs/*.md` and the JSDoc state: the [error
  behaviour](resilience.md#error-behaviour) (including what `invalidateTags` rejects with), when `CacheConfigError` is
  thrown, what `@HttpCache` caches, and how events are delivered. Fixing behaviour that contradicts the docs is a
  patch.
- **Persisted and wire formats.** A change here is a major, because it breaks rolling deploys and stored data. See the
  next section.
- **Events.** The event names and payload fields of `CacheEventMap`, and the `CacheOperation` values.
- **Observability.** Prometheus metric names, existing label names and values, and the encoding of
  `circuit_breaker_state`. Span names, attribute names and value meanings, the `cache.error` event and the span status
  code.
- **Environment.** `engines.node`, the peer dependency ranges and the TypeScript minimum (5.4, with the published
  `.d.ts` checked against it with `skipLibCheck: false`).

## Persisted and wire formats

Instances of different versions run together during a rolling deploy, and Redis keeps data across versions. These are
frozen in 1.x:

- **Data keys:** `[<prefix>:][<namespace>[@<token>]:]<key>`. A change means a cold cache, and nodes of different
  versions would miss each other's entries.
- **Reserved key space:** `__lock__`, `__version__` and `__tag__`. Namespaces starting with `__` are rejected, and a
  key with no namespace (or with the empty namespace) that starts with `__` is a key error.
- **Version and tag token keys:** the key shapes, and the fact that a token key expires. The exact TTL (30 days
  today) is not covered.
- **The lock:** the key `[<prefix>:]__lock__:[<namespace>[@<token>]:]<key>`, a random UUID as value, `SET NX PX`, and a
  token-checked release.
- **The envelope:** `v: 1` and its fields (`value`, `storedAt`, `expiresAt`, `staleAt`, `nil`, `tags`). Forward rules:
  - A field that older readers can ignore is added without changing `v`. A custom `Serializer` must therefore
    round-trip fields it does not know.
  - Bumping `v` is a major change.
  - An envelope whose `v` is a finite number greater than 1 is read as a miss, and no read on a 1.x node deletes it.
    A later miss or write (a `getOrSet` miss, `set` or `@CachePut`) may overwrite it with a `v: 1` entry.
- **The compression prefix:** `"\u0000nc1:"` followed by `gz:` or `br:`, then base64.
- **The invalidation message:** JSON `{ origin, keys }` or `{ origin, prefix }` on the channel `nestjs-cache:invalidate`
  (the channel default). Forward rule: new message kinds may be added in a minor, and a 1.x node handles one it does not
  recognise safely: a message with a string `origin` and an unrecognised body clears all of L1. A message without a
  string `origin` is ignored. A new message kind must not look like either current shape (`{ origin, keys }` or `{ origin, prefix }`), because
  1.x nodes ignore extra fields on those shapes and would handle it as a partial match. Custom buses must pass messages
  through as opaque data.
- **Default decorator keys:** `<Class>.<method>[:<first 16 hex of sha1(stableStringify(args))>]`. The output of
  `stableStringify` is frozen in 1.x, so a change to it would change every default key. The `@HttpCache` default key
  (`escape(path[?sortedQuery])` in the namespace `http`) is frozen too.
- **Tag stamps:** `tags: { <tag>: <token> }` in the envelope, and the limit of 32 tags per entry. Raising the limit is
  a minor; lowering it is a major.

Future opt-ins (Redis Cluster hash tags, replica reads) do not change any of these by default.

## Interfaces you implement

These interfaces and `*Like` shapes are implemented or supplied by you: `CacheStore`, `Serializer`, `LockProvider`,
`LockHandle`, `InvalidationBus`, `RedisClientAdapter`, `RedisSubscriberAdapter`, `IoredisLike`, `IoredisClusterLike`,
the `NodeRedis*Like` types, `PrometheusClientLike`, `RegistryLike`, `TracerLike`, `SpanLike`, `SpanOptionsLike` and
`SpanContextLike`. In 1.x they only gain optional members, and the library checks that an optional member exists before
it calls it. A custom implementation written for 1.0 keeps working in every 1.x.

The types the library provides may grow in a minor: `CacheEventMap` (new events and payload fields), `CacheOperation`
(new values), `CacheEventSink`, the fields of `CacheEnvelope` and the variants of `InvalidationMessage`. Write code
that handles an event, operation or message kind it does not know.

## What is not covered

These can change in any release:

- Constructor parameters of classes Nest creates (`CacheService`, `CacheEvents`, `CacheHealthIndicator`,
  `HttpCacheInterceptor`); do not construct them.
- Declarations that appear in the `.d.ts` without being exported from the root (`CacheEngine`, `CacheTracing`,
  `VersionTokens`, `ResolvedCacheOptions` and similar), members tagged `@internal`, private members of exported
  classes, and subclassing exported classes (use the factories and wrap stores, see [stores](stores.md)).
- The text of error messages, log lines (including the debug line format and its throttling) and warnings. The error
  classes, and when they are thrown, are covered.
- Internal DI tokens (`Symbol.for('@loipv/nestjs-cache:...')`), the providers `CacheModule` exports besides
  `CacheService`, `CacheEvents` and `CacheHealthIndicator`, timing and tick order, the order of store calls, and
  internal constants other than the limit of 32 tags (and the token-key expiry rule above).

## Major, minor and patch

| Change                                                                                                                                                       | Release |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Remove or rename an exported name, a member, an option field or a strategy name                                                                              | major   |
| Add a strategy name (`strategy` is a closed union, so user code with an exhaustive `switch` would break)                                                     | major   |
| Change a default, a signature or documented behaviour in a way that breaks a correct caller                                                                  | major   |
| Change a persisted or wire format: key layout, reserved space, token keys, lock, `v`, compression prefix, the invalidation message, tag stamps, default keys | major   |
| Remove a metric, a span or an event                                                                                                                          | major   |
| Lower the 32-tag limit                                                                                                                                       | major   |
| Add or remove a label on an existing Prometheus metric; rename a metric, span, attribute or event                                                            | major   |
| Raise the Node minimum, narrow a peer range, add a required peer, or raise the TypeScript minimum                                                            | major   |
| Add an exported name, an optional option or an optional interface member                                                                                     | minor   |
| Add an event, an event payload field, a `CacheOperation` value, a metric, a span or a span attribute                                                         | minor   |
| Add a `cache.result` value                                                                                                                                   | minor   |
| Add an optional envelope field without bumping `v`, or a new invalidation message kind                                                                       | minor   |
| Raise the 32-tag limit                                                                                                                                       | minor   |
| Widen a peer range or the supported Node range                                                                                                               | minor   |
| Fix behaviour that contradicts the docs; fix a bug; change messages, logs or internals; update the docs                                                      | patch   |
