# Decorators

`@Cacheable`, `@CachePut` and `@CacheEvict` cache, update and evict the results of service methods; this page covers
their options and how cache keys are built.

[Back to the README](../README.md) · See also: [expiry strategies](configuration.md#expiry-strategies),
[tags](namespaces-and-tags.md#tags), [distributed lock](resilience.md#distributed-lock),
[error behaviour](resilience.md#error-behaviour), [HTTP caching](http-caching.md)

## Usage and options

```ts
import { Injectable } from '@nestjs/common';
import { Cacheable, CacheEvict, CachePut } from '@loipv/nestjs-cache';

// Your own types.
interface User {
  id: string;
}
interface SearchQuery {
  term: string;
}
interface UpdateUserDto {
  name?: string;
}

@Injectable()
export class UserService {
  @Cacheable({ namespace: 'users', key: 'user:{0}', ttl: 60_000 })
  findById(id: string): Promise<User | null> {
    /* ... */
  }

  @Cacheable({
    namespace: 'users',
    key: (query: SearchQuery, page: number) => `search:${query.term}:${page}`,
    condition: (query: SearchQuery) => query.term.length > 2,
  })
  search(query: SearchQuery, page: number): Promise<User[]> {
    /* ... */
  }

  @CachePut({ namespace: 'users', key: 'user:{0}' })
  update(id: string, dto: UpdateUserDto): Promise<User> {
    /* ... */
  }

  @CacheEvict({ namespace: 'users', key: 'user:{0}' })
  remove(id: string): Promise<void> {
    /* ... */
  }

  @CacheEvict({ namespace: 'users', allEntries: true })
  importAll(): Promise<void> {
    /* ... */
  }
}
```

| Option                 | Decorator                 | Meaning                                                                                         |
| ---------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `key`                  | all three                 | Template or callback (see Dynamic keys). `@CacheEvict` also accepts an array                    |
| `namespace`            | all three                 | Key group; the unit for bulk eviction                                                           |
| `store`                | all three                 | Store name, defaults to `default`                                                               |
| `ttl`                  | `@Cacheable`, `@CachePut` | Overrides `defaults.ttl`                                                                        |
| `strategy`             | `@Cacheable`, `@CachePut` | `'fixed'` (default), `'swr'` or `'sliding'` (see Expiry strategies)                             |
| `staleTtl`, `maxTtl`   | `@Cacheable`, `@CachePut` | Strategy parameters (`swr` needs `staleTtl`; `sliding` accepts `maxTtl`)                        |
| `softTimeout`          | `@Cacheable`              | `swr` only: wait up to this many ms for the refresh of a stale entry (see Expiry strategies)    |
| `lock`                 | `@Cacheable`              | `true`/`false` overrides `defaults.lock.enabled` (see Distributed lock)                         |
| `cacheNull`, `nullTtl` | `@Cacheable`, `@CachePut` | Per-method override of the defaults                                                             |
| `condition`            | `@Cacheable`, `@CachePut` | Receives the method arguments; `false` skips the cache                                          |
| `unless`               | `@Cacheable`, `@CachePut` | Receives the result; `true` prevents storing it                                                 |
| `allEntries`           | `@CacheEvict`             | Clear the whole namespace; requires `namespace` and cannot be combined with `key`               |
| `beforeInvocation`     | `@CacheEvict`             | `true`: evict before the method runs. Default: evict after it succeeds                          |
| `tags`                 | all three, `@HttpCache`   | Tags to stamp (`@Cacheable`, `@CachePut`, `@HttpCache`) or invalidate (`@CacheEvict`); see Tags |

Behaviour:

- `@Cacheable`: on a hit, returns the cached value (including a stored empty value). On a miss, runs the method and stores the result.
- `@CachePut`: always runs the method. If `condition` is `false` or `unless` is `true` the cache is untouched. An empty result while `cacheNull` is off deletes the key. Otherwise the result is stored.
- `@CacheEvict`: evicts after the method succeeds; a method that throws evicts nothing. With `beforeInvocation: true` it evicts first, regardless of the outcome.
- A method can carry several `@CacheEvict`, or `@CachePut` together with `@CacheEvict`. `@Cacheable` together with `@CachePut` on one method throws at class definition.

Type checking: decorating a method that does not return a `Promise` is a compile error. The `key` and
`condition` callbacks type their own parameters, and the compiler checks that the method accepts them.
Callbacks may declare fewer parameters than the method.

Unknown store names fail at startup. A bad key template, `allEntries` without `namespace`, an empty `key: []` for
`@CacheEvict`, invalid `tags` (see Tags), a `static` method, and a `ttl`/`nullTtl`/`staleTtl`/`maxTtl`/`softTimeout` that is not a finite number greater than 0
are rejected with `CacheConfigError`, as are a `cacheNull`, `lock`, `allEntries` or `beforeInvocation` that is not a boolean
and a `condition` or `unless` that is not a function. See Error behaviour for the full list.

## Dynamic keys

The full key is `<prefix>:<namespace>:<key>`; missing parts are dropped together with their `:`.

- **Template:** `{N}` is the Nth argument (from 0); `{N.a.b}` reads a nested property. Primitives use `String()`, objects use JSON with sorted keys. Templates are positional because parameter names do not exist at runtime. A malformed template throws at class definition.
- **`escapeKeyArgs: true`** (module option) rewrites `%` as `%25` and `:` as `%3A` in the string and number arguments rendered into a template, so an argument cannot address another namespace. Callback keys and keys you pass to `CacheService` are never escaped. Turning it on changes the keys of arguments that contain `:` or `%`, so those entries start cold.
- **Callback:** receives the method arguments and returns a string.
- **Default:** `<ClassName>.<methodName>`, followed by `:<hash>` when there are arguments. The hash is the first 16 hex characters of the SHA-1 of the arguments' JSON (sorted keys).
- If a key cannot be built (unserializable argument, a callback that throws, a template or callback that renders an empty string), the cache is skipped, the original method runs and an `error` event with `operation: 'key'` is emitted. In a `@CacheEvict` key list, a key that renders empty is dropped (one `error` event) and the other keys are still evicted; a key builder that throws skips the whole eviction.
