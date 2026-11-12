# `CacheService`

`CacheService` reads, writes, deletes and loads cache entries from your own code, one key at a time or in batches.

[Back to the README](../README.md) · See also: [expiry strategies](configuration.md#expiry-strategies),
[tags](namespaces-and-tags.md#tags), [error behaviour](resilience.md#error-behaviour)

## Methods

```ts
import type {
  CacheService,
  GetOrSetManyOptions,
  GetOrSetOptions,
  KeyOptions,
  StrategyOptions,
  WriteManyOptions,
  WriteOptions,
} from '@loipv/nestjs-cache';

/** The public methods of `CacheService`. */
interface CacheServiceMethods {
  get<T>(key: string, options?: KeyOptions & StrategyOptions): Promise<T | undefined>;
  set<T>(key: string, value: T, options?: WriteOptions<T>): Promise<void>;
  delete(key: string | readonly string[], options?: KeyOptions): Promise<void>;
  clear(namespace: string, options?: { store?: string }): Promise<void>;
  invalidateTags(tags: readonly string[], options?: { store?: string }): Promise<void>;
  getOrSet<T>(key: string, loader: () => Promise<T>, options?: GetOrSetOptions<T>): Promise<T>;
  getMany<T>(
    keys: readonly string[],
    options?: KeyOptions & StrategyOptions,
  ): Promise<(T | undefined)[]>;
  setMany<T>(
    entries: readonly (readonly [key: string, value: T])[],
    options?: WriteManyOptions<T>,
  ): Promise<void>;
  getOrSetMany<T>(
    keys: readonly string[],
    loader: (missing: string[]) => Promise<ReadonlyMap<string, T>>,
    options?: GetOrSetManyOptions<T>,
  ): Promise<(T | undefined)[]>;
}

// docs:check fails here when this summary and the real class differ (a method or a signature).
type Same<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
export const inSync: Same<CacheServiceMethods, Pick<CacheService, keyof CacheService>> = true;
```

```ts
import type { CacheService } from '@loipv/nestjs-cache';

// Your own code: the injected service and a repository.
declare const cache: CacheService;
declare const repo: { find(id: string): Promise<{ id: string } | null> };

const user = await cache.getOrSet('user:1', () => repo.find('1'), {
  namespace: 'users',
  ttl: 30_000,
  cacheNull: true,
});
```

`KeyOptions` is `{ namespace?, store? }`. `WriteOptions` adds `ttl`, `tags` and the strategy options
(`StrategyOptions`); `WriteManyOptions` is the same with a `(value, key)` tags callback. `GetOrSetOptions` and
`GetOrSetManyOptions` take the load strategy options (`LoadStrategyOptions`, which add `softTimeout`) and add `cacheNull`,
`nullTtl`, `unless` and `lock` (`false` only for `getOrSetMany`). `get` returns `undefined` on a miss. `clear` needs a non-empty namespace and rejects
`''` with `CacheConfigError`. A `namespace` that starts with `__` is reserved and also rejects with `CacheConfigError`. `T` is your assertion; the library does not
validate stored data at runtime.

An empty key, or a reserved key (one that starts with `__` when the namespace is missing or `''`), is a key error
(`error` with `operation: 'key'`): `get` returns `undefined`, `getOrSet` runs the loader without caching, and `set`
does nothing. `delete` drops the invalid keys, emits one `error` event and still deletes the others; `delete('')` alone
does nothing. With a non-empty namespace, a key such as `__x` is valid.

## Batch operations

`getMany`, `setMany` and `getOrSetMany` read and write many keys of one namespace in a call.

```ts
import type { CacheService } from '@loipv/nestjs-cache';

// Your own code: the injected service, a user type, two users and a repository.
interface User {
  id: string;
}
declare const cache: CacheService;
declare const userOne: User, userTwo: User;
declare const repo: { findByKeys(keys: string[]): Promise<{ key: string; user: User }[]> };

const [a, b] = await cache.getMany<User>(['user:1', 'user:2'], { namespace: 'users' });

await cache.setMany(
  [
    ['user:1', userOne],
    ['user:2', userTwo],
  ],
  { namespace: 'users', ttl: 30_000 },
);

const users = await cache.getOrSetMany<User>(
  ['user:1', 'user:2', 'user:3'],
  async (missing) => {
    const rows = await repo.findByKeys(missing); // only the keys not in the cache
    return new Map(rows.map((row) => [row.key, row.user]));
  },
  { namespace: 'users', ttl: 30_000, cacheNull: true },
);
```

- Results are in input order. A key read twice in one call is read and loaded once. An empty or reserved key (see above) gives
  `undefined` and one `error` event with `operation: 'key'`. `[]` makes no store call.
- The loader receives only the misses and returns a `Map`. A requested key missing from the `Map` is treated as an
  `undefined` result and follows `cacheNull` (a stored marker reads back as `undefined`). Keys in the `Map` that were not requested are ignored: not cached, not
  returned. An error from the loader, or a return value that is not a `Map`, reaches the caller.
- Loading is single-flight per key and shared with `getOrSet` in the same process: concurrent `getOrSetMany(['a', 'b'])`
  and `getOrSetMany(['b', 'c'])` call their loaders with `['a', 'b']` and `['c']`.
- `swr` serves stale values and refreshes them with one loader call for the stale keys; with `softTimeout` the whole
  call shares one wait window (see [Expiry strategies](configuration.md#expiry-strategies)). `sliding` makes `getMany`
  call `getAndTouch` for each key (per key, not one batch call).
- `getOrSetMany` never locks: its `lock` option accepts only `false` (a JavaScript caller passing `lock: true` gets
  `CacheConfigError`), and `defaults.lock.enabled` is ignored for batches.
  Coalescing is per process.
- The `load` event fires once per loader call and carries `keys` (all the keys passed to the loader); `key` is the
  first of them.
- `CacheStore` has the optional `getMany` and `setMany`. `redisStore` uses one `MGET` when the client has `mget`;
  other stores are called key by key.
- `setMany` with a duplicated key keeps the last value.
- `setMany` entries must be `[key, value]` pairs. An element that cannot be destructured (`null`, a number) throws a
  `TypeError`; one that can is not checked, so a 2-character string such as `'ab'` silently becomes key `a`, value `b`.
- With a versioned namespace the batch methods read the token once for the call.
