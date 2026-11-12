import type { FactoryProvider, ModuleMetadata } from '@nestjs/common';

/** A span attribute value the library sets: a string, number, boolean or list of strings. */
export type SpanAttributeValue = string | number | boolean | string[];

/**
 * Structural subset of an OpenTelemetry `SpanContext`: what a link needs to point at a span.
 * Satisfied by the result of `span.spanContext()` in the OpenTelemetry JS API 1.x.
 *
 * Implemented by you. In 1.x, members are only added as optional, and the library checks that they
 * exist before calling them.
 */
export interface SpanContextLike {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

/**
 * Structural subset of an OpenTelemetry `Span`: only the methods the library calls. Satisfied by
 * the spans of the OpenTelemetry JS API 1.x, so no dependency on that package is needed.
 *
 * Implemented by you. In 1.x, members are only added as optional, and the library checks that they
 * exist before calling them.
 */
export interface SpanLike {
  /** Sets one attribute (`cache.store`, `cache.result`, ...). */
  setAttribute(key: string, value: SpanAttributeValue): unknown;
  /** Adds an event; the library adds `cache.error` with `cache.error.operation` on a swallowed error. */
  addEvent(name: string, attributes?: Record<string, SpanAttributeValue>): unknown;
  /** Records an error: one the caller receives, or one the library swallowed. */
  recordException(exception: unknown): void;
  /** Sets the status; the library only sets `{ code: 2 }` (`ERROR`) for an error the caller receives. */
  setStatus(status: { code: number; message?: string }): unknown;
  /** Ends the span; the library calls it exactly once per span it starts. */
  end(): void;
  /** The span's identity, used to link a background `cache.refresh` to the span that started it. */
  spanContext(): SpanContextLike;
}

/**
 * Structural subset of an OpenTelemetry `SpanOptions`: the options the library passes.
 *
 * Implemented by you. In 1.x, members are only added as optional, and the library checks that they
 * exist before calling them.
 */
export interface SpanOptionsLike {
  /** Attributes set when the span starts. */
  attributes?: Record<string, SpanAttributeValue>;
  /** `true` starts a new trace (the background `cache.refresh` span). */
  root?: boolean;
  /** Links to related spans (`cache.refresh` links to the span that triggered it). */
  links?: { context: SpanContextLike }[];
}

/**
 * Structural subset of an OpenTelemetry `Tracer`. Pass `trace.getTracer('my-app')` from
 * the OpenTelemetry JS API 1.x; it is assignable without a cast.
 *
 * Implemented by you. In 1.x, members are only added as optional, and the library checks that they
 * exist before calling them.
 */
export interface TracerLike {
  /**
   * Starts a span, makes it the active one while `fn` runs (so spans started inside `fn` are
   * its children), and returns what `fn` returns. Must call `fn` synchronously.
   */
  startActiveSpan<F extends (span: SpanLike) => unknown>(
    name: string,
    options: SpanOptionsLike,
    fn: F,
  ): ReturnType<F>;
  /** Starts a span under the active one without activating it (the `cache.lock` wait). */
  startSpan(name: string, options?: SpanOptionsLike): SpanLike;
}

/** Options of `CacheTracingModule.forRoot`. */
export interface CacheTracingOptions {
  /** The tracer spans are started with, for example `trace.getTracer('my-app')`. */
  tracer: TracerLike;
  /**
   * Record `cache.key`: the full key (prefix and namespace version included), an array of full
   * keys on batch calls and `delete`, the tag names on `invalidateTags`. Default `false`: keys
   * may hold user data and have a very large number of values.
   */
  recordKeys?: boolean;
}

/** Options of `CacheTracingModule.forRootAsync`: `useFactory` resolves the module options. */
export interface CacheTracingAsyncOptions {
  imports?: ModuleMetadata['imports'];
  /** Providers passed to `useFactory`, in order. */
  inject?: FactoryProvider['inject'];
  /** Returns the module options, or a promise of them. */
  useFactory: (...args: never[]) => CacheTracingOptions | Promise<CacheTracingOptions>;
}
