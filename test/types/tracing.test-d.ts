import { trace } from '@opentelemetry/api';
import type {
  CacheTracingAsyncOptions,
  CacheTracingOptions,
  SpanContextLike,
  SpanLike,
  SpanOptionsLike,
  TracerLike,
} from '../../src/observability/tracing.types.js';

/* The OpenTelemetry API's Tracer and Span are assignable without a cast. */
const otel = trace.getTracer('x');
export const tracer: TracerLike = otel;
export const span: SpanLike = otel.startSpan('s');
export const context: SpanContextLike = span.spanContext();
export const options: SpanOptionsLike = {
  attributes: { 'cache.store': 'default', 'cache.key': ['a', 'b'] },
  root: true,
  links: [{ context }],
};
export const active: number = tracer.startActiveSpan('a', options, (s) => {
  s.end();
  return 1;
});

export const ok: CacheTracingOptions = { tracer, recordKeys: true };
// @ts-expect-error recordKeys must be a boolean
export const badKeys: CacheTracingOptions = { tracer, recordKeys: 'yes' };
// @ts-expect-error tracer is required
export const noTracer: CacheTracingOptions = {};

const TOKEN = Symbol('cfg');
export const asyncOptions: CacheTracingAsyncOptions = {
  imports: [],
  inject: [TOKEN],
  useFactory: (cfg: { record: boolean }) => ({ tracer, recordKeys: cfg.record }),
};
