export const CACHE_ENGINE: unique symbol = Symbol.for('@loipv/nestjs-cache:engine');
export const CACHE_OPTIONS: unique symbol = Symbol.for('@loipv/nestjs-cache:options');
export const CACHE_ENGINE_PROPERTY: unique symbol = Symbol.for(
  '@loipv/nestjs-cache:engine-property',
);
export const CACHE_METADATA: unique symbol = Symbol.for('@loipv/nestjs-cache:metadata');
/** @internal The module's `CacheLogger`; exported by `CacheModule` for the metrics module. */
export const CACHE_LOGGER: unique symbol = Symbol.for('@loipv/nestjs-cache:logger');
export const CACHE_PROMETHEUS_OPTIONS: unique symbol = Symbol.for(
  '@loipv/nestjs-cache:prometheus-options',
);
/** @internal The `CacheTracingModule` options; `CacheTracing.use` validates them. */
export const CACHE_TRACING_OPTIONS: unique symbol = Symbol.for(
  '@loipv/nestjs-cache:tracing-options',
);
/** @internal The `CacheTracingModule` provider that registers the tracer with `CacheTracing`. */
export const CACHE_TRACING_REGISTRATION: unique symbol = Symbol.for(
  '@loipv/nestjs-cache:tracing-registration',
);
