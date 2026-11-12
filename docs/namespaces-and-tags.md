# Versioned namespaces and tags

Versioned namespaces clear a whole namespace with one write, and tags invalidate entries across keys and namespaces
with one call.

[Back to the README](../README.md) · See also: [decorators](decorators.md), [`CacheService`](cache-service.md),
[caveats](caveats.md)

## Versioned namespaces

By default `clear(namespace)` and `@CacheEvict({ allEntries: true })` walk the store (`SCAN` and delete on Redis),
which is slow for a large namespace. A versioned namespace clears with one write instead.

```ts
import type { Redis } from 'ioredis';
import {
  CacheModule,
  memoryStore,
  redisStore,
  tieredStore,
  type CacheService,
} from '@loipv/nestjs-cache';

// Your own code: the Redis client, the injected service and a user.
declare const redis: Redis;
declare const cache: CacheService;
declare const user: { id: string };

CacheModule.forRoot({
  prefix: 'myapp',
  stores: { default: tieredStore({ l1: memoryStore(), l2: redisStore({ client: redis }) }) },
  namespaces: { users: { versioned: true } },
  versioning: { cacheTtl: 1_000 },
});

await cache.set('user:1', user, { namespace: 'users' }); // key: myapp:users@<token>:user:1
await cache.clear('users'); // one SET of a new token; no SCAN
```

- A versioned namespace keeps a token in the key `<prefix>:__version__:<namespace>` and writes data under
  `<prefix>:<namespace>@<token>:<key>`. The token key has a 30-day TTL that every `clear` refreshes. The TTL is set only
  when the token key is created and on `clear`; reads and writes never refresh it. A versioned namespace that has not
  been cleared for 30 days therefore gets a new token on its next use, however busy it is: every entry under the old
  token misses, including entries written just before with a short `ttl` (a miss, never stale data).
- `clear` and `@CacheEvict({ allEntries: true })` write a new token. Old entries are never deleted; they become
  unreachable and expire by their own TTL.
- Each instance caches the token in memory for `versioning.cacheTtl` ms (default `1_000`), so another instance sees a
  clear within that time. The instance that clears sees it at once.
- `delete`, `@CacheEvict` with keys and a `put` of an empty value read the token fresh from the store and delete under
  both the fresh and the cached token: one extra `GET` per delete. On a `tieredStore` the "fresh" read is served from
  L1, so a delete that races a `clear` on another instance, before that instance's invalidation message arrives, can
  still use the previous token.
- Turning `versioned: true` on for a namespace that already has entries changes its keys: the existing
  `<prefix>:<namespace>:*` entries are no longer read, `clear` no longer reaches them, and they expire by their own TTL.
  The namespace starts cold.
- Names must match exactly. A sub-namespace such as `users:admin` is not versioned by `users: { versioned: true }`;
  list it on its own.
- Namespaces starting with `__` are reserved and rejected (see [Error behaviour](resilience.md#error-behaviour)).
- A key starting with `__` is rejected when no namespace is given, because that space holds the library's own
  `__version__`, `__tag__` and `__lock__` keys. It is a key error like an empty key (see
  [Error behaviour](resilience.md#error-behaviour)). Inside a namespace (`{ namespace: 'users', key: '__x' }`) such a
  key is fine, and so is `__` anywhere past the first two characters (`a__b`).
- If the token cannot be read or written, an `error` event with `operation: 'version'` is emitted. On a plain store
  (not tiered) a `get` is then a miss without a `miss` event, `getOrSet` runs the loader without writing the result,
  and `set` and `delete` do nothing.
- On a `tieredStore` (and on any store implementing `getStrict`), a failed version read falls back to the last token
  this process knew, with one `version` error per failure; the next call reads the store again. With no known token the
  loader runs and nothing is cached. A plain store keeps the 0.4 behaviour: one `version` error, the loader runs, and
  nothing is cached. A failed `clear` (L2 down) reports a `version` error and leaves the token unchanged, so it no
  longer moves the token in L1 only.
- Remaining risk: an instance that missed another instance's `clear` just before an outage keeps the old token during
  the outage. The stale data comes from L1 only, so it lasts at most `l1Ttl`.

## Tags

A tag groups entries across keys and namespaces so that one call invalidates all of them. Tag an entry when you write
it, then call `invalidateTags` (or use `@CacheEvict({ tags })`); every entry carrying that tag becomes a miss.

```ts
import { Injectable } from '@nestjs/common';
import { Cacheable, CacheEvict, CacheService } from '@loipv/nestjs-cache';

// Illustrative: `repo`, `Product` and `UpdateProductDto` are your own.
interface Product {
  id: string;
  category: string;
}
interface UpdateProductDto {
  category: string;
}
interface ProductsRepository {
  find(id: string): Promise<Product | null>;
  list(category: string): Promise<Product[]>;
  update(id: string, dto: UpdateProductDto): Promise<Product>;
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly cache: CacheService,
    private readonly repo: ProductsRepository,
  ) {}

  // Templates use the key syntax and honour escapeKeyArgs.
  @Cacheable({ namespace: 'products', key: 'product:{0}', tags: ['product:{0}', 'catalog'] })
  find(id: string) {
    return this.repo.find(id);
  }

  // Tag a list by category, not by every item in it: one entry carries at most 32 tags.
  @Cacheable({ namespace: 'products', key: 'list:{0}', tags: ['category:{0}'] })
  list(category: string) {
    return this.repo.list(category);
  }

  // A callback of the arguments (or, for @Cacheable/@CachePut, also the result); annotate its parameters.
  @CacheEvict({
    tags: (id: string, dto: UpdateProductDto) => [`product:${id}`, `category:${dto.category}`],
  })
  update(id: string, dto: UpdateProductDto) {
    return this.repo.update(id, dto);
  }

  // Or invalidate directly.
  async clearCatalog() {
    await this.cache.invalidateTags(['catalog']);
  }
}
```

Entries written without a tag stamp are not affected by `invalidateTags` until their own TTL. When you add `tags` to
an existing method or call, clear the affected namespaces after the rollout (or wait one TTL).

Declaring tags:

- `@Cacheable` and `@CachePut`: `tags` is an array of templates (same syntax as `key`, honours `escapeKeyArgs`) or a
  callback `(result, ...args) => string[]`. `tags: []` means no tags. Callbacks are checked against the decorated
  method, not inferred from it, so annotate their parameters.
- `@HttpCache`: `tags` is an array of fixed strings (not templates; a `{` or `}` throws `CacheConfigError` at
  decoration) or `(body, req: HttpCacheRequest) => string[]`.
- `CacheService.set` and `getOrSet`: fixed strings or `(value) => string[]`. `setMany` and `getOrSetMany`: fixed
  strings or `(value, key) => string[]` (the types `WriteManyOptions<T>` and `GetOrSetManyOptions<T>` are exported).

```ts
import type { CacheService } from '@loipv/nestjs-cache';

declare const cache: CacheService;
declare const user: { id: string };

await cache.set('user:1', user, { namespace: 'users', tags: ['tenant:7'] });
await cache.invalidateTags(['tenant:7']);
```

Invalidating:

- `CacheService.invalidateTags(tags, { store? })` works per store. It rejects with `CacheConfigError` for an empty
  list, an empty string, a non-array, more than 32 tags or an unknown store. If writing a tag token fails it still
  tries every tag, then rejects with the first error.
- `@CacheEvict({ tags })` takes templates over the arguments or `(...args) => string[]`. Use it alone or with
  `key`/`allEntries` (the keys or namespace are evicted first, then the tags), and with `beforeInvocation`. It never
  rejects the call: token-write failures are `error` events only, and a key error and a tag error do not block each
  other. `@CacheEvict()` with no options keeps its 0.6 meaning (evicts the default key); `@CacheEvict({ tags: [] })`
  is a `CacheConfigError`.

Limits and errors:

- At most 32 tags per entry after de-duplication, and tag strings must be non-empty.
- With `escapeKeyArgs: true` a template tag renders escaped (`product:a%3Ab` for id `a:b`), so `invalidateTags` must
  use the same escaped form.
- A tag callback receives `null` or `undefined` when `cacheNull` caches an empty result. A callback that dereferences
  it produces a `tag` error, and the null is not cached.
- A custom `Serializer` must round-trip the envelope's `tags` field, or invalidation is silently disabled.
- An invalid runtime tag list (for example a callback that returns an empty string) emits one `error` event with
  `operation: 'tag'`; the entry is not written and the caller still gets the value.
- A token read or write failure emits an `error` event with `operation: 'version'`.

Consistency and cost:

- Tags are scoped per store; one tag can span several namespaces in the same store.
- The instance that invalidates sees it immediately. When an entry's stamp differs from an instance's cached tag
  token, that instance re-reads the token from the store (at most once per tag per `versioning.cacheTtl`, default
  1000 ms) and a confirmed match is a hit. So instances do not keep rewriting each other's entries after an
  invalidation, and other instances usually see it on the next read; the worst case is still bounded by
  `versioning.cacheTtl`, the same setting that governs versioned namespaces.
- Each tag has a version key `<prefix>:__tag__:<tag>` with a 30-day TTL. Reads cost no extra round-trip while the tag
  tokens are cached in the process; up to 10 000 tag tokens are kept per process (the least recently refreshed is
  evicted first).
- Tag token keys live 30 days. The TTL is set only when the key is created and on `invalidateTags` or
  `@CacheEvict({ tags })`; reads and writes never refresh it. A tag that has not been invalidated for 30 days gets a new
  token on its next use, however busy it is: every entry tagged with it misses, including entries written just before
  with a short `ttl` (a miss, never stale data). They live in the same store (in `memoryStore`, in a separate LRU
  of `maxEntries` tokens, see [stores](./stores.md)), and one key per distinct tag accumulates in Redis. Bound tags
  built from untrusted input.
- On a two-tier store, if an invalidation message is lost or there is no bus, another instance can keep the old tag
  token for up to `l1Ttl` plus `versioning.cacheTtl` (the tag token key is cached in L1), not only
  `versioning.cacheTtl`.
- Invalidated entries are not deleted. They become misses and leave the store when their TTL expires. The one
  exception is the sliding path: an entry whose tag mismatch is confirmed against the store is deleted (not on tiered
  stores or stores with `getStrict`, where it is just a miss).

Write timing:

- Tags known before the load (arrays and templates, and `@CachePut` arrays) take their tokens before the loader or
  method runs, so an invalidation during the load is never missed.
- Tags from a callback on the result are computed after the load. An invalidation that happens during that load can
  be missed until the entry's TTL; prefer argument tags when you need strictness.
- `@CachePut` and `@CacheEvict({ tags })` sharing a tag on one method: with template (array) tags, `@CachePut` takes
  its tokens before the method runs, so an evict of that tag that runs afterwards makes the freshly put entry a miss.
  Only `@CacheEvict({ beforeInvocation: true })` placed outermost, with `@CachePut` inside, keeps the entry.
  Result-callback tags are stamped at write time, so any evict of that tag that finishes before `@CachePut` writes
  keeps the entry.

Outages and upgrades:

- If tag tokens cannot be read, a store with `getStrict` (such as `tieredStore`) uses the last known tokens. Any other
  store treats a tagged entry as a miss, and `getOrSet` loads without writing and without the distributed lock.
- With `strategy: 'swr'`, an entry invalidated by a tag is a hard miss; it is never served stale.
- Rolling deploy: instances still on 0.6 ignore the `tags` field, so entries they write carry no tag stamp and
  `invalidateTags` does not affect them until their own TTL (the same holds for entries written before `tags` was
  added to a method or call). Only entries written with tags are affected by an invalidation; clear the affected
  namespaces after the rollout, or wait one TTL.
