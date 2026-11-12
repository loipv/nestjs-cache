import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  SpanAttributeValue,
  SpanContextLike,
  SpanLike,
  SpanOptionsLike,
  TracerLike,
} from '../../../src/observability/tracing.types.js';

/** A tracer or span method `FakeTracer.failOn` can make throw. */
export type FakeTracerMethod =
  | 'startActiveSpan'
  | 'startSpan'
  | 'setAttribute'
  | 'addEvent'
  | 'recordException'
  | 'setStatus'
  | 'end'
  | 'spanContext';

/**
 * When a failing method throws: `'before'` throws without doing anything (`startActiveSpan`
 * never calls `fn`); `'after'` does the work first (`startActiveSpan` calls `fn`, `end` counts
 * the end) and then throws.
 */
export type FailWhen = 'before' | 'after';

/** One recorded span: its parent, attributes, events, exceptions, status, links and ends. */
export class FakeSpan implements SpanLike {
  readonly attributes: Record<string, SpanAttributeValue> = {};
  readonly events: { name: string; attributes: Record<string, SpanAttributeValue> | undefined }[] =
    [];
  readonly exceptions: unknown[] = [];
  status: { code: number; message?: string } | undefined;
  endCount = 0;
  readonly traceId: string;
  readonly spanId: string;

  constructor(
    private readonly tracer: FakeTracer,
    readonly name: string,
    readonly parent: FakeSpan | undefined,
    readonly root: boolean,
    readonly links: { context: SpanContextLike }[],
    id: number,
  ) {
    this.spanId = id.toString(16).padStart(16, '0');
    this.traceId = parent?.traceId ?? id.toString(16).padStart(32, '0');
  }

  setAttribute(key: string, value: SpanAttributeValue): this {
    this.tracer.call('setAttribute', () => {
      this.attributes[key] = value;
    });
    return this;
  }

  addEvent(name: string, attributes?: Record<string, SpanAttributeValue>): this {
    this.tracer.call('addEvent', () => {
      this.events.push({ name, attributes });
    });
    return this;
  }

  recordException(exception: unknown): void {
    this.tracer.call('recordException', () => {
      this.exceptions.push(exception);
    });
  }

  setStatus(status: { code: number; message?: string }): this {
    this.tracer.call('setStatus', () => {
      this.status = status;
    });
    return this;
  }

  end(): void {
    this.tracer.call('end', () => {
      this.endCount += 1;
    });
  }

  spanContext(): SpanContextLike {
    return this.tracer.call('spanContext', () => ({
      traceId: this.traceId,
      spanId: this.spanId,
      traceFlags: 1,
    }));
  }
}

/**
 * A structural tracer that records every span. The active span is tracked with its own
 * `AsyncLocalStorage`, like an OpenTelemetry context manager, so `parent` reflects nesting.
 */
export class FakeTracer implements TracerLike {
  /** Every call to a tracer or span method, failing ones included. */
  calls = 0;
  private readonly recorded: FakeSpan[] = [];
  private readonly active = new AsyncLocalStorage<FakeSpan>();
  private readonly failing = new Map<FakeTracerMethod, FailWhen>();
  private nextId = 1;

  /** Makes `method` throw on every call from now on (see `FailWhen`). */
  failOn(method: FakeTracerMethod, when: FailWhen = 'before'): void {
    this.failing.set(method, when);
  }

  /** Stops every `failOn`. */
  reset(): void {
    this.failing.clear();
  }

  /** The recorded spans in start order, optionally only those named `name`. */
  spans(name?: string): FakeSpan[] {
    return name === undefined ? [...this.recorded] : this.recorded.filter((s) => s.name === name);
  }

  /** The only span named `name`; throws unless there is exactly one. */
  span(name: string): FakeSpan {
    const found = this.spans(name);
    if (found.length !== 1) {
      throw new Error(`expected one span "${name}", found ${String(found.length)}`);
    }
    return found[0]!;
  }

  /** Throws unless every recorded span was ended exactly once. */
  assertAllEnded(): void {
    const bad = this.recorded.filter((s) => s.endCount !== 1);
    if (bad.length > 0) {
      throw new Error(
        `spans not ended exactly once: ${bad.map((s) => `${s.name} (${String(s.endCount)})`).join(', ')}`,
      );
    }
  }

  startActiveSpan<F extends (span: SpanLike) => unknown>(
    name: string,
    options: SpanOptionsLike,
    fn: F,
  ): ReturnType<F> {
    return this.call('startActiveSpan', () => {
      const span = this.open(name, options);
      return this.active.run(span, () => fn(span)) as ReturnType<F>;
    });
  }

  startSpan(name: string, options?: SpanOptionsLike): SpanLike {
    return this.call('startSpan', () => this.open(name, options));
  }

  /** @internal Runs a method body, throwing before or after it when the method is failing. */
  call<R>(method: FakeTracerMethod, body: () => R): R {
    this.calls += 1;
    const when = this.failing.get(method);
    if (when === 'before') throw new Error(`fake tracer: ${method} failed`);
    const result = body();
    if (when === 'after') throw new Error(`fake tracer: ${method} failed`);
    return result;
  }

  private open(name: string, options: SpanOptionsLike | undefined): FakeSpan {
    const root = options?.root === true;
    const parent = root ? undefined : this.active.getStore();
    const span = new FakeSpan(this, name, parent, root, options?.links ?? [], this.nextId++);
    Object.assign(span.attributes, options?.attributes);
    this.recorded.push(span);
    return span;
  }
}
