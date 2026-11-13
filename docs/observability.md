# Events and observability

This page describes the cache events and the optional Prometheus metrics, `@nestjs/terminus` health check, logging,
sample Grafana dashboard and OpenTelemetry tracing.

[Back to the README](../README.md) · See also: [error behaviour](resilience.md#error-behaviour),
[security](security.md)

## Events

```ts
import { Inject, Injectable } from '@nestjs/common';
import { CacheEvents } from '@loipv/nestjs-cache';

@Injectable()
export class CacheMonitor {
  constructor(@Inject(CacheEvents) events: CacheEvents) {
    const off = events.on('error', ({ store, operation, error }) => {
      // report to your monitoring
    });
  }
}
```

`on` returns an unsubscribe function. A listener that throws is swallowed and logged. `@Inject(CacheEvents)`
works without `emitDecoratorMetadata`; plain constructor injection (`constructor(events: CacheEvents)`) needs it.

| Event     | Payload                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `hit`     | `store`, `namespace`, `key`, `stale` (`true` for `swr` stale reads)       |
| `miss`    | `store`, `namespace`, `key`                                               |
| `set`     | `store`, `namespace`, `key`, `ttl`                                        |
| `delete`  | `store`, `namespace`, `keys`                                              |
| `clear`   | `store`, `namespace`                                                      |
| `load`    | `store`, `namespace`, `key`, `durationMs`, `success`, `keys` (batch only) |
| `error`   | `store`, `operation`, `error`                                             |
| `lock`    | `store`, `namespace`, `key`, `waitedMs`, `acquired`                       |
| `breaker` | `store`, `state` (`'closed'`, `'open'` or `'half-open'`)                  |

Repeated `error` log lines are throttled to one per 30 seconds for each (store, operation) pair; the next line carries a
`(+N similar errors suppressed)` suffix. Events are still emitted for every occurrence.

`operation` of an `error` event is one of `get`, `set`, `delete`, `clear`, `deserialize`, `key`, `publish`, `subscribe`,
`refresh`, `lock`, `version`, `tag`, `touch` (the `CacheOperation` type). `touch` is a failed background refresh of
version token key TTLs (see [Versioned namespaces](namespaces-and-tags.md#versioned-namespaces)); no call fails with it.

## Metrics, health check and logging

Three optional features: Prometheus metrics, a health check for `@nestjs/terminus`, and a configurable log level.
They ship from the main entry point and add no runtime or peer dependencies.

### Prometheus

`CachePrometheusModule` records metrics through a Prometheus client that you pass in. Use
[`@prometheus-io/client`](https://www.npmjs.com/package/@prometheus-io/client), the maintained successor of `prom-client`:

```bash
npm install @prometheus-io/client
```

`CachePrometheusModule` reads cache events, so it needs a global `CacheModule`: call
`CacheModule.forRoot({ isGlobal: true })`. Without it, Nest fails at startup with a missing dependency error.

```ts
import { Module } from '@nestjs/common';
import { CacheModule, CachePrometheusModule } from '@loipv/nestjs-cache';
import * as client from '@prometheus-io/client';

@Module({
  imports: [
    CacheModule.forRoot({ isGlobal: true }),
    CachePrometheusModule.forRoot({
      client, // the module itself: `import * as client from '...'`
      registry: client.register, // optional, defaults to client.register
      prefix: 'cache_', // optional, defaults to 'cache_'
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5], // optional, for both histograms
    }),
  ],
})
export class AppModule {}
```

`prom-client` works the same way, because the library only relies on structural types. Note that the `prom-client` package is
marked deprecated on npm in favour of `@prometheus-io/client`:

```ts
import { Module } from '@nestjs/common';
import { CacheModule, CachePrometheusModule } from '@loipv/nestjs-cache';
import * as client from 'prom-client';

@Module({
  imports: [CacheModule.forRoot({ isGlobal: true }), CachePrometheusModule.forRoot({ client })],
})
export class MetricsAppModule {}
```

There is also `forRootAsync({ imports, inject, useFactory })` (`CachePrometheusAsyncOptions`), where `useFactory`
returns the same options (`CachePrometheusOptions`).

The module does not open an endpoint. Expose the registry yourself, for example with a controller:

```ts
import { Controller, Get, Header } from '@nestjs/common';
import * as client from '@prometheus-io/client';

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', client.register.contentType)
  metrics(): Promise<string> {
    return client.register.metrics();
  }
}
```

Metric names below use the default prefix `cache_`:

| Metric                  | Type      | Labels                                                  |
| ----------------------- | --------- | ------------------------------------------------------- |
| `requests_total`        | counter   | `store`, `namespace`, `result` (`hit`, `miss`, `stale`) |
| `errors_total`          | counter   | `store`, `operation`                                    |
| `load_duration_seconds` | histogram | `store`, `namespace`, `success` (`true`, `false`)       |
| `lock_wait_seconds`     | histogram | `store`, `acquired` (`true`, `false`)                   |
| `circuit_breaker_state` | gauge     | `store` (0 = closed, 1 = half-open, 2 = open)           |

- The key is never a label, so cardinality stays bounded. A missing `namespace` is recorded as `""`.
- There are no metrics for `set`, `delete` or `clear`.
- A miss that waits on a lock and is then served from the cache emits `miss` first and `hit` after, so it is counted as
  both a miss and a hit.
- Registering a name that already exists in the registry throws `CacheConfigError` at startup
  (`Metric "cache_requests_total" is already registered; use a different prefix or registry`). This happens when two
  apps in one process share `client.register`; give one of them another `prefix` or `registry`.
- The metrics are removed from the registry when the app closes, so a second app can start afterwards.
- A failure while updating a metric is logged as a warning, `Cache metrics failed on store "<store>": <message>`, at
  most once per 30 s per store (the same throttle as other store errors). Nothing is logged at `logging.level: 'off'`.
  It is never emitted as an `error` event, so `errors_total` is not affected.

Custom or fake clients: `PrometheusClientLike` and `RegistryLike` are structural types. A registry needs
`getSingleMetric`, `removeSingleMetric` and `registerMetric`, and the constructors are typed `new (config: never) => ...`.
See the TSDoc example on `PrometheusClientLike` for a minimal fake to use in tests.

### Health check

`CacheModule` provides `CacheHealthIndicator`. It does not import `@nestjs/terminus`; `check` returns the shape that
Terminus expects, and Terminus treats `down` as a failure (HTTP 503).

```ts
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { CacheHealthIndicator } from '@loipv/nestjs-cache';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly cache: CacheHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.cache.check('cache', { store: 'default', timeout: 500 })]);
  }
}
```

`check(key, { store, timeout })`: `store` defaults to `'default'` and `timeout` to `1000` ms. The call resolves to one of:

- `{ [key]: { status: 'up' } }`
- `{ [key]: { status: 'up', ping: 'unsupported' } }` when the store has no `ping`
- `{ [key]: { status: 'down', message } }`, where `message` is the error message, `'circuit open'` for an open breaker,
  or `'timed out after <timeout> ms'`

It never rejects, except with `CacheConfigError` for an unknown store name or a `timeout` that is not a finite number
from 1 to 2147483647. It does not emit `error` events, and a `ping` that rejects after the timeout is handled.

| Store                      | `ping`                                                                     |
| -------------------------- | -------------------------------------------------------------------------- |
| `memoryStore`              | Always resolves                                                            |
| `redisStore`               | Redis `PING`. Present only when the Redis client adapter has `ping`        |
| `tieredStore`              | Calls the L2 store's `ping`. Present only when L2 has it                   |
| `circuitBreakerStore(...)` | Goes through the breaker: rejects with `CircuitOpenError` while it is open |
| Store without `ping`       | Reported as `up` with `ping: 'unsupported'`                                |

`ioredisAdapter` provides `ping` and `mget` only when the client has them; both are optional members of `IoredisLike`, so a hand-written stub can leave them out (health then reports `ping: 'unsupported'`).

With ioredis's default offline queue, a `ping` that timed out stays queued until ioredis gives up
(`maxRetriesPerRequest`, default 20), so frequent checks while Redis is down queue PINGs until then. Set
`maxRetriesPerRequest` low or `enableOfflineQueue: false` on the client if that matters. On a store wrapped with
`circuitBreakerStore(...)`, a failed `ping` counts toward `failureThreshold` like any other operation. Once `openDuration`
has passed, the next call, which may be a `ping`, becomes the single probe; while that probe is in flight (half-open),
other calls including `ping` are rejected with `CircuitOpenError`.

### Logging

```ts
import { CacheModule } from '@loipv/nestjs-cache';

CacheModule.forRoot({ logging: { level: 'error' } }); // 'off' | 'error' | 'debug'
```

Any other value throws `CacheConfigError`.

| Level               | What is logged                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'error'` (default) | The 0.2 logs: throttled store errors, startup and decorator warnings, plus circuit breaker logs (opened at `warn`, closed at `log`, never throttled) |
| `'debug'`           | Everything in `'error'`, plus one debug line per `hit`, `miss`, `set`, `delete`, `clear`, `load` and `lock` event                                    |
| `'off'`             | Nothing from the library, with one exception (below)                                                                                                 |

`'off'` silences store error logs, breaker logs, startup lock warnings, explorer and decorator warnings, the tiered
store's missing-bus warning, and metrics collector failures. Events are still emitted, so your own listeners and the
metrics keep working. The exception is the decorator warning
`<Class>.<method> was called on an instance not created by Nest; caching is skipped.`: it is logged at every level,
once per method, because no cache configuration exists at that point.

Debug lines have the form `Cache <event> <store> <key or namespace>[ <detail>]`. Keys appear in debug logs only:

```text
[Nest] DEBUG [CacheModule] Cache hit default users:user:1 stale
[Nest] DEBUG [CacheModule] Cache load default users:user:1 12ms ok
[Nest] DEBUG [CacheModule] Cache lock default users:user:1 waited 50ms acquired
```

### Grafana

`grafana/dashboard.json` in the repository is a sample dashboard (it is not part of the npm package). In Grafana,
open Dashboards, New, Import, upload the file and pick your Prometheus datasource for `DS_PROMETHEUS`. It assumes the
default `cache_` prefix and has a `store` variable. Panels: hit ratio, requests by result, errors by operation, load
p95, lock wait p95 and breaker state.

## Tracing

`CacheTracingModule` traces cache calls through an OpenTelemetry tracer that you pass in. Tracing is opt-in: without
the module nothing is traced and the call paths are unchanged. The library has no dependency on OpenTelemetry; it
relies on the structural types `TracerLike`, `SpanLike`, `SpanOptionsLike` and `SpanContextLike`, which a tracer from
`@opentelemetry/api` satisfies. Install and configure the SDK yourself. With only `@opentelemetry/api` and no SDK
registered, the spans are still created, through the API's no-op tracer: they are non-recording and export nothing, and
the cache behaves exactly as without tracing.

Like `CachePrometheusModule`, it needs a global `CacheModule`: call `CacheModule.forRoot({ isGlobal: true })`. Register
it once; a second registration, or invalid options, throws `CacheConfigError` at startup.

```ts
import { Module } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { CacheModule, CacheTracingModule } from '@loipv/nestjs-cache';

@Module({
  imports: [
    CacheModule.forRoot({ isGlobal: true }),
    CacheTracingModule.forRoot({
      tracer: trace.getTracer('my-app'),
      recordKeys: false, // optional, defaults to false
    }),
  ],
})
export class TracedAppModule {}
```

`forRootAsync({ imports, inject, useFactory })` (`CacheTracingAsyncOptions`) takes a factory that returns the same
options (`CacheTracingOptions`):

```ts
import { Module } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { CacheModule, CacheTracingModule } from '@loipv/nestjs-cache';

@Module({
  imports: [
    CacheModule.forRoot({ isGlobal: true }),
    CacheTracingModule.forRootAsync({
      useFactory: () => ({ tracer: trace.getTracer('my-app'), recordKeys: true }),
    }),
  ],
})
export class AsyncTracedAppModule {}
```

### Spans

Every call into the cache engine starts one span with the tracer's default kind (`INTERNAL` in OpenTelemetry), made
active while the call runs. Redis command spans from your own ioredis or redis auto-instrumentation therefore nest under
the cache span; the library does not instrument the Redis client.

| Span                   | Entry point      | Called by                                      |
| ---------------------- | ---------------- | ---------------------------------------------- |
| `cache.get`            | `get`            | `CacheService`                                 |
| `cache.getOrSet`       | `getOrSet`       | `@Cacheable`, `@HttpCache`, `CacheService`     |
| `cache.set`            | `set`            | `CacheService`                                 |
| `cache.put`            | `put`            | `@CachePut`                                    |
| `cache.delete`         | `delete`         | `@CacheEvict`, `CacheService`                  |
| `cache.clear`          | `clear`          | `@CacheEvict({ allEntries })`, `CacheService`  |
| `cache.invalidateTags` | `invalidateTags` | `@CacheEvict({ tags })`, `CacheService`        |
| `cache.getMany`        | `getMany`        | `CacheService`                                 |
| `cache.setMany`        | `setMany`        | `CacheService`                                 |
| `cache.getOrSetMany`   | `getOrSetMany`   | `CacheService`                                 |

Child spans:

- **`cache.load`** wraps your loader (the batch loader too) and is active while it runs, so the database or HTTP spans
  it makes nest under it. Only the call that owns the single-flight has a `cache.load`; a call that joins another
  call's load has none and gets `cache.load.joined = true` on its main span.
- **`cache.lock`** covers the distributed lock wait, from the start of `acquire` until the lock is obtained, times out
  or fails, so its duration is the `waitedMs` of the `lock` event. It is not made active: Redis spans issued during the
  wait nest under the main span, not under `cache.lock`. When the wait ends with a value written by another instance,
  the main span has `cache.result = hit`.
- **`cache.refresh`** is the background refresh of `swr`, for single and batch calls. It is a new root span with a link
  to the span that triggered it, not a child, because a refresh usually ends after its triggering span, even with
  `softTimeout`. It holds its own `cache.lock` and `cache.load` and carries `cache.store` and `cache.namespace`. A
  refresh that joins a flight already running has no new `cache.refresh`.

### Attributes

| Attribute                                   | On                          | Value                                                                                                              |
| ------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `cache.store`                               | every span                  | the store name                                                                                                     |
| `cache.namespace`                           | spans with a namespace      | the namespace                                                                                                      |
| `cache.key`                                 | with `recordKeys: true`     | the full key (prefix and version included); an array for batch calls and `delete`; the tag names for `invalidateTags` |
| `cache.result`                              | `get`, `getOrSet`           | `hit`, `stale`, `miss` or `bypass` (empty or reserved key, a key that cannot be built, or a version error)                     |
| `cache.load.joined`                         | `getOrSet` on a miss        | `true` when the call shares another call's load                                                                    |
| `cache.keys`                                | batch calls, `delete`       | the number of keys (see below)                                                                                     |
| `cache.hits`, `cache.stale`, `cache.misses` | `getMany`, `getOrSetMany`   | the number of distinct keys in each outcome, always set (0 when none)                                              |
| `cache.tags`                                | `invalidateTags`            | the number of distinct tags                                                                                        |
| `cache.written`                             | `set`, `put`                | `false` when nothing was written: `unless` skipped it, a tag failed, the key was empty or reserved, or a store or version error |
| `cache.lock.acquired`                       | `cache.lock`                | `true` or `false`                                                                                                  |

On `getMany`, `setMany` and `getOrSetMany`, `cache.keys` counts the keys as you passed them, duplicates included. On
`delete` it counts the valid keys: empty and reserved keys are dropped first. `cache.hits`, `cache.stale` and `cache.misses` count
distinct keys, so with duplicate keys they need not add up to `cache.keys`.

### Keys, PII and cardinality

`recordKeys` is off by default, because keys often hold user ids, emails or other personal data, and a span attribute
leaves the process. Turn it on only when your keys are safe to export. The value is the full key, so it also includes
the store prefix and the namespace version. Keys have high cardinality: do not turn them into metric dimensions or
span-derived labels.

### Errors

- An error that reaches the caller (a loader that throws, `CacheConfigError`, a rejected `invalidateTags`) is recorded
  with `recordException` and status `ERROR` on the span where it happened, for example `cache.load`, and on the main
  span.
- An error the library swallows, that is, one that emits the `error` event, is recorded with `recordException` and a
  `cache.error` event carrying `cache.error.operation` (a `CacheOperation`) on the running cache span. The status stays
  unset, because the caller still gets a result. Background work (the background refresh of version token key TTLs,
  operation `touch`, and the background lock release) runs outside any cache span, so its failures are reported only
  through the `error` event, logs and metrics, not on a span.
- A failed `swr` refresh is the exception. A refresh whose loader fails is a swallowed `refresh` error, yet it marks
  `cache.refresh` and its `cache.load` with status `ERROR`, because the refresh itself failed. The span of the request
  that triggered it is untouched: that request already got its stale value.
- A span records each error once. When the same error both sets status `ERROR` and is swallowed on one span, for
  example a failed token write that `invalidateTags` then rejects with, or a failed refresh loader on `cache.refresh`,
  that span has one exception, the `cache.error` event and status `ERROR`.
- `CircuitOpenError` records nothing, as with the `error` event.
- A tracer or span that throws never reaches the caller and never makes a function run twice. The call carries on as if
  tracing were off, and the failure is logged at `error` level under the operation `tracing`, throttled like other
  store errors.
