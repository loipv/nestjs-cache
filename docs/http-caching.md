# HTTP caching

This page covers `@HttpCache`, which caches the responses of the controller routes you decorate, and how to invalidate
them.

[Back to the README](../README.md) · See also: [decorators](decorators.md),
[versioned namespaces](namespaces-and-tags.md#versioned-namespaces), [tags](namespaces-and-tags.md#tags)

`@HttpCache` caches a controller route's response body. It is opt-in: a route without the decorator is never cached.

```ts
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CacheEvict, HttpCache } from '@loipv/nestjs-cache';

// Your own types.
interface User {
  id: string;
}
interface CreateUserDto {
  name: string;
}

@Controller('users')
export class UsersController {
  @Get()
  @HttpCache({ namespace: 'users', ttl: 60_000 })
  list(): Promise<User[]> {
    /* ... */
  }

  @Get(':id')
  @HttpCache({ namespace: 'users', key: (req) => `user:${req.params.id}` })
  find(@Param('id') id: string): Promise<User> {
    /* ... */
  }

  @Post()
  @CacheEvict({ namespace: 'users', allEntries: true })
  create(@Body() dto: CreateUserDto): Promise<User> {
    /* ... */
  }
}
```

`CacheModule` must be global or imported into the controller's module. It works on Express and Fastify.

- **Where:** on a method or on a class. A method's options replace the class's options entirely (no merge). Only `GET`
  and `HEAD` are cached (`HEAD` shares the `GET` entry); other methods and non-HTTP contexts pass through.
- **Options:** `ttl`, `namespace` (default `'http'`), `store`, `lock`, `cacheNull`, `nullTtl`, `key`, `unless`
  (`(body) => boolean`; return `true` to keep that body out of the cache) and the strategy options (`strategy: 'swr'`
  with `staleTtl`/`softTimeout`, or `'sliding'` with `maxTtl`). Invalid options throw `CacheConfigError` when the decorator runs; an
  unknown `store` fails at startup (`app.init()`) with a message that names `@HttpCache`.
- **Default key:** the request URL with the query sorted by name, then value, and `%` and `:` percent-encoded:
  `/users?b=2&a=1` and `/users?a=1&b=2` share the entry `/users?a=1&b=2`. It varies only on the path and the query,
  not on the host (for example `@Controller({ host })` multi-tenant routes), headers such as `Accept`,
  `Accept-Language` or a version header, or cookies: anything else that changes the body must go into a key callback,
  or the route must not be cached.
- **Key callback:** `key` is a fixed string, or `(req) => string | undefined` where `req` is
  `{ method, url, defaultKey, path, query, params, headers }` and `defaultKey` is the default key above. Returning
  `undefined` skips the cache for that request, for example
  `key: (req) => (req.headers.authorization ? undefined : req.defaultKey)` caches only anonymous requests. A callback
  that throws, or returns something other than a non-empty string, emits one `error` event with `operation: 'key'` and
  the handler runs uncached. Callback keys are not escaped: with `escapeKeyArgs: true`,
  `@CacheEvict({ key: 'user:{0}' })` escapes `:` and `%` in the id but ``(req) => `user:${req.params.id}` `` does not,
  so build both keys the same way, for example ``@CacheEvict({ key: (id: string) => `user:${id}` })``.
- **What is cached:** the handler's return value (the body) only. `StreamableFile`, `Buffer`, `Uint8Array` and streams
  are never cached, but do not put `@HttpCache` on routes that return them: concurrent requests coalesced by
  single-flight would share one stream instance. `undefined` is never cached, so routes that use `@Res()` are not
  supported. `null` is cached only with `cacheNull`. `@HttpCode` and `@Header` still apply on a hit.
- **Server-side cache:** the library adds no response headers and ignores the request `Cache-Control`.
- **Errors:** an error from the handler, including `HttpException`, reaches your exception filters and is not cached.
  A cache or store error never reaches the client: it emits an `error` event and the handler runs.
- **Engine features** apply unchanged: single-flight per process, `lock` across instances, `swr` and `sliding`, the
  circuit breaker, events and Prometheus metrics.

Invalidation: put list routes in a namespace and clear it from the mutations with
`@CacheEvict({ namespace: 'users', allEntries: true })`. Declare the namespace with
`namespaces: { users: { versioned: true } }` so that clear is O(1) (see Versioned namespaces). For single-record
routes, build the key from the request (``key: (req) => `user:${req.params.id}` ``) and evict it with
`@CacheEvict({ namespace: 'users', key: 'user:{0}' })`, with `@Param('id') id` as the method's first parameter.

Coming from `@nestjs/cache-manager`? See the
[migration guide](migration-from-cache-manager.md).
