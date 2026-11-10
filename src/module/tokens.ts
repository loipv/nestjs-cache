export const CACHE_ENGINE: unique symbol = Symbol.for('@loipv/nestjs-cache:engine');
export const CACHE_OPTIONS: unique symbol = Symbol.for('@loipv/nestjs-cache:options');
export const CACHE_ENGINE_PROPERTY: unique symbol = Symbol.for(
  '@loipv/nestjs-cache:engine-property',
);
export const CACHE_METADATA: unique symbol = Symbol.for('@loipv/nestjs-cache:metadata');
/** @internal The module's `CacheLogger`; exported by `CacheModule` for the metrics module. */
export const CACHE_LOGGER: unique symbol = Symbol.for('@loipv/nestjs-cache:logger');
