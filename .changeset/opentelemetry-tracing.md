---
'@loipv/nestjs-cache': minor
---

Opt-in OpenTelemetry tracing.

Added:

- `CacheTracingModule` with `forRoot` and `forRootAsync`: pass a tracer such as `trace.getTracer('my-app')` and every
  cache call gets a span (`cache.get`, `cache.getOrSet`, ...), with child spans `cache.load`, `cache.lock` and
  `cache.refresh`. It needs a global `CacheModule`. Nothing is traced without the module, and the library gains no
  dependency on OpenTelemetry.
- The types `CacheTracingOptions` (`tracer`, `recordKeys`), `CacheTracingAsyncOptions`, `TracerLike`, `SpanLike`,
  `SpanOptionsLike`, `SpanContextLike` and `SpanAttributeValue`.
