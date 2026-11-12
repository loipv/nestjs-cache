import { AsyncLocalStorage } from 'node:async_hooks';
import type { CacheOperation } from '../core/events.js';
import { CacheConfigError } from '../errors.js';
import type { CacheLogger } from '../module/cache.logger.js';
import type {
  CacheTracingOptions,
  SpanAttributeValue,
  SpanLike,
  SpanOptionsLike,
  TracerLike,
} from './tracing.types.js';

/** @internal The validated `CacheTracingModule` options. */
export interface ResolvedTracingOptions {
  tracer: TracerLike;
  recordKeys: boolean;
}

/** @internal Validates the `CacheTracingModule` options and fills the defaults. */
export function resolveTracingOptions(options: unknown): ResolvedTracingOptions {
  const given = (typeof options === 'object' && options !== null ? options : {}) as {
    tracer?: unknown;
    recordKeys?: unknown;
  };
  const tracer = given.tracer as Partial<TracerLike> | null | undefined;
  if (
    typeof tracer !== 'object' ||
    tracer === null ||
    typeof tracer.startActiveSpan !== 'function' ||
    typeof tracer.startSpan !== 'function'
  ) {
    throw new CacheConfigError(
      'Invalid cacheTracing option tracer: must provide startActiveSpan and startSpan',
    );
  }
  const recordKeys = given.recordKeys ?? false;
  if (typeof recordKeys !== 'boolean') {
    throw new CacheConfigError('Invalid cacheTracing option recordKeys: must be a boolean');
  }
  return { tracer: tracer as TracerLike, recordKeys };
}

/** `SpanStatusCode.ERROR` in OpenTelemetry. */
const STATUS_ERROR = 2;

/** The store (and namespace) a main or refresh span is about. */
interface TraceBase {
  store: string;
  namespace?: string;
}

/** The counters of a batch scope, set on its span when it ends (0 when none). */
interface BatchCounts {
  hits: number;
  stale: number;
  misses: number;
}

/** The current cache span: a main span or a `cache.refresh`, held in the `AsyncLocalStorage`. */
interface Scope {
  readonly span: SpanLike;
  readonly store: string;
  /** Only on a batch scope. */
  readonly batch: BatchCounts | undefined;
  /** Set once the span ended; recorders then do nothing. */
  ended: boolean;
  /** Set once the span's status is `ERROR`. */
  failed: boolean;
  /** The errors recorded on the span, so each is recorded once; created on the first one. */
  recorded: Set<unknown> | undefined;
}

interface Enabled {
  readonly tracer: TracerLike;
  readonly recordKeys: boolean;
  readonly als: AsyncLocalStorage<Scope>;
}

/** What the traced body produced: the promise the caller gets, or a synchronous throw. */
type Outcome<T> = { promise: Promise<T> } | { thrown: unknown };

const NO_LOCK = { end: (): void => undefined };

function attributesOf(base: TraceBase): Record<string, SpanAttributeValue> {
  return base.namespace === undefined
    ? { 'cache.store': base.store }
    : { 'cache.store': base.store, 'cache.namespace': base.namespace };
}

/**
 * Internal: not part of the public API. Owns the user's tracer once `CacheTracingModule`
 * registers it, and the current cache scope (an `AsyncLocalStorage`, created on registration).
 * Until then every method calls its function directly or does nothing. A throwing tracer or span
 * method is logged (as `'tracing'`) and never reaches the caller, and never runs a function twice.
 */
export class CacheTracing {
  private on: Enabled | undefined;

  /** @internal `CacheModule` builds it with its `CacheLogger`. */
  constructor(private readonly logger?: CacheLogger) {}

  /** Whether a tracer is registered. */
  get enabled(): boolean {
    return this.on !== undefined;
  }

  /** Whether `cache.key` is recorded; lets a caller skip building a key list for `key`. */
  get recordKeys(): boolean {
    return this.on?.recordKeys === true;
  }

  /** Registers the tracer; throws `CacheConfigError` for invalid options or a second call. */
  use(options: CacheTracingOptions): void {
    if (this.on !== undefined) {
      throw new CacheConfigError('CacheTracingModule is already registered');
    }
    const { tracer, recordKeys } = resolveTracingOptions(options);
    this.on = { tracer, recordKeys, als: new AsyncLocalStorage<Scope>() };
  }

  /**
   * Runs `fn` in a new active main span `name` and its own scope. A rejection (or a
   * synchronous throw) records the exception and sets `ERROR`, then reaches the caller as is.
   * A `'batch'` scope counts hits, stale hits and misses instead of setting `cache.result`, and
   * its span always gets the three counters, 0 when none.
   */
  span<T>(
    name: string,
    base: TraceBase,
    fn: () => Promise<T>,
    kind: 'single' | 'batch' = 'single',
  ): Promise<T> {
    const on = this.on;
    if (on === undefined) return fn();
    // If the tracer fails, `fn` runs untraced outside any scope, so a nested call never writes
    // onto the span of the call it runs in.
    return this.scoped(on, name, base, { attributes: attributesOf(base) }, kind, fn, () =>
      on.als.exit(fn),
    );
  }

  /**
   * Runs `fn` in an active child span of the current one. A rejection marks the child and the
   * current scope's span `ERROR`. Untraced outside a scope or after the scope ended.
   */
  child<T>(name: 'cache.load', fn: () => Promise<T>): Promise<T> {
    const on = this.on;
    if (on === undefined) return fn();
    const scope = on.als.getStore();
    if (scope === undefined || scope.ended) return fn();
    return this.activate(on.tracer, scope.store, name, {}, fn, (span) =>
      this.settle(span, scope.store, fn, (error) => {
        this.fail(span, scope.store, error);
        this.failScope(scope, error);
      }),
    );
  }

  /**
   * Runs `fn` in a new root span `cache.refresh` linked to the current scope's span (no link
   * outside a scope), in a scope of its own: a background refresh outlives its trigger. If the
   * tracer fails, `fn` runs untraced outside any scope, so it never writes to its trigger.
   */
  root<T>(base: TraceBase, fn: () => Promise<T>): Promise<T> {
    const on = this.on;
    if (on === undefined) return fn();
    const options: SpanOptionsLike = { attributes: attributesOf(base), root: true };
    const current = on.als.getStore();
    if (current !== undefined && !current.ended) {
      this.guard(base.store, () => {
        options.links = [{ context: current.span.spanContext() }];
      });
    }
    return this.scoped(on, 'cache.refresh', base, options, 'single', fn, () => on.als.exit(fn));
  }

  /**
   * Starts `cache.lock` under the active span, not activated. `end` is idempotent; `true` or
   * `false` sets `cache.lock.acquired`, `undefined` (the acquire failed) sets nothing.
   */
  lockSpan(): { end(acquired: boolean | undefined): void } {
    const on = this.on;
    const scope = on?.als.getStore();
    if (on === undefined || scope === undefined || scope.ended) return NO_LOCK;
    let span: SpanLike;
    try {
      span = on.tracer.startSpan('cache.lock');
    } catch (error) {
      this.report(scope.store, error);
      return NO_LOCK;
    }
    let ended = false;
    return {
      end: (acquired) => {
        if (ended) return;
        ended = true;
        if (acquired !== undefined) {
          this.guard(scope.store, () => {
            span.setAttribute('cache.lock.acquired', acquired);
          });
        }
        this.guard(scope.store, () => {
          span.end();
        });
      },
    };
  }

  /** A hit: `cache.result` `'hit'`/`'stale'` on a single scope, a count on a batch scope. */
  hit(stale: boolean): void {
    const scope = this.current();
    if (scope === undefined) return;
    if (scope.batch) {
      if (stale) scope.batch.stale += 1;
      else scope.batch.hits += 1;
    } else {
      this.attribute(scope, 'cache.result', stale ? 'stale' : 'hit');
    }
  }

  /** A miss: `cache.result = 'miss'` on a single scope, a count on a batch scope. */
  miss(): void {
    const scope = this.current();
    if (scope === undefined) return;
    if (scope.batch) {
      scope.batch.misses += 1;
    } else {
      this.attribute(scope, 'cache.result', 'miss');
    }
  }

  /** Sets `cache.result` (`'bypass'`: the call skipped the cache). */
  result(value: 'bypass'): void {
    const scope = this.current();
    if (scope !== undefined) this.attribute(scope, 'cache.result', value);
  }

  /** Sets one attribute on the current scope's span. */
  set(key: string, value: SpanAttributeValue): void {
    const scope = this.current();
    if (scope !== undefined) this.attribute(scope, key, value);
  }

  /** Sets `cache.key` (a full key, or a list of them) when `recordKeys` is on. */
  key(full: string | readonly string[]): void {
    if (!this.recordKeys) return;
    const scope = this.current();
    if (scope !== undefined) {
      this.attribute(scope, 'cache.key', typeof full === 'string' ? full : [...full]);
    }
  }

  /**
   * A failure the library swallowed: records the exception (unless the span already has it) and
   * a `cache.error` event carrying `cache.error.operation`. The status stays unset, since the
   * caller still gets a result.
   */
  error(operation: CacheOperation, error: unknown): void {
    const scope = this.current();
    if (scope === undefined) return;
    this.record(scope, error);
    this.guard(scope.store, () => {
      scope.span.addEvent('cache.error', { 'cache.error.operation': operation });
    });
  }

  /** The live scope, or `undefined` when tracing is off, outside a scope, or after it ended. */
  private current(): Scope | undefined {
    const scope = this.on?.als.getStore();
    return scope === undefined || scope.ended ? undefined : scope;
  }

  /** Starts an active span that owns a new scope (`span`, `root`). */
  private scoped<T>(
    on: Enabled,
    name: string,
    base: TraceBase,
    options: SpanOptionsLike,
    kind: 'single' | 'batch',
    fn: () => Promise<T>,
    untraced: () => Promise<T>,
  ): Promise<T> {
    return this.activate(on.tracer, base.store, name, options, untraced, (span) => {
      const scope: Scope = {
        span,
        store: base.store,
        batch: kind === 'batch' ? { hits: 0, stale: 0, misses: 0 } : undefined,
        ended: false,
        failed: false,
        recorded: undefined,
      };
      return this.settle(
        span,
        scope.store,
        () => on.als.run(scope, fn),
        (error) => {
          this.failScope(scope, error);
        },
        scope,
      );
    });
  }

  /**
   * Calls `tracer.startActiveSpan` with `body`. If the tracer throws before calling `body`, or
   * returns without calling it, `untraced` runs instead; if it throws after, the outcome of
   * `body` is kept. Either way the user function runs once: a callback the tracer invokes again,
   * or late (after the fallback ran), only ends its span. A synchronous throw of the user
   * function is rethrown here, not mistaken for a tracer error.
   */
  private activate<T>(
    tracer: TracerLike,
    store: string,
    name: string,
    options: SpanOptionsLike,
    untraced: () => Promise<T>,
    body: (span: SpanLike) => Outcome<T>,
  ): Promise<T> {
    const state: { invoked: boolean; outcome: Outcome<T> | undefined } = {
      invoked: false,
      outcome: undefined,
    };
    try {
      void tracer.startActiveSpan(name, options, (span: SpanLike) => {
        if (state.invoked) {
          this.guard(store, () => {
            span.end();
          });
          return undefined;
        }
        state.invoked = true;
        const outcome = body(span);
        state.outcome = outcome;
        return 'promise' in outcome ? outcome.promise : undefined;
      });
    } catch (error) {
      this.report(store, error);
    }
    const outcome = state.outcome;
    if (outcome === undefined) {
      state.invoked = true;
      return untraced();
    }
    if ('thrown' in outcome) throw outcome.thrown;
    return outcome.promise;
  }

  /**
   * Runs `run` and ends `span` once when it settles, on a side branch: the caller gets the
   * promise `run` returned, so tracing adds no tick, and the side branch's reactions (registered
   * first) end the span before the caller resumes. The side branch handles the rejection, which
   * still reaches the caller through the original promise. A rejection or synchronous throw
   * first calls `onError`, which records it. With a `scope`, the scope is closed (its batch
   * counters set) before the span ends.
   */
  private settle<T>(
    span: SpanLike,
    store: string,
    run: () => Promise<T>,
    onError: (error: unknown) => void,
    scope?: Scope,
  ): Outcome<T> {
    const close = (): void => {
      if (scope) this.close(scope);
      this.guard(store, () => {
        span.end();
      });
    };
    let promise: Promise<T>;
    try {
      promise = run();
    } catch (thrown) {
      onError(thrown);
      close();
      return { thrown };
    }
    promise.then(close, (error: unknown) => {
      onError(error);
      close();
    });
    return { promise };
  }

  /**
   * Marks the scope's span `ERROR` for an error that reaches its caller (a failed child, or the
   * call's own rejection). An error the span already has (from the child, or a swallowed one) is
   * not recorded again.
   */
  private failScope(scope: Scope, error: unknown): void {
    if (scope.ended) return;
    this.record(scope, error);
    if (scope.failed) return;
    scope.failed = true;
    this.guard(scope.store, () => {
      scope.span.setStatus({ code: STATUS_ERROR });
    });
  }

  /** Records `error` on the scope's span, once per error. */
  private record(scope: Scope, error: unknown): void {
    const recorded = (scope.recorded ??= new Set());
    if (recorded.has(error)) return;
    recorded.add(error);
    this.guard(scope.store, () => {
      scope.span.recordException(error);
    });
  }

  private fail(span: SpanLike, store: string, error: unknown): void {
    this.guard(store, () => {
      span.recordException(error);
    });
    this.guard(store, () => {
      span.setStatus({ code: STATUS_ERROR });
    });
  }

  /** Sets the batch counters and closes the scope; the caller ends the span. */
  private close(scope: Scope): void {
    const counts = scope.batch;
    if (counts !== undefined) {
      this.attribute(scope, 'cache.hits', counts.hits);
      this.attribute(scope, 'cache.stale', counts.stale);
      this.attribute(scope, 'cache.misses', counts.misses);
    }
    scope.ended = true;
  }

  private attribute(scope: Scope, key: string, value: SpanAttributeValue): void {
    this.guard(scope.store, () => {
      scope.span.setAttribute(key, value);
    });
  }

  /** Runs one tracer or span call; a throw is logged and never escapes. */
  private guard(store: string, call: () => void): void {
    try {
      call();
    } catch (error) {
      this.report(store, error);
    }
  }

  private report(store: string, error: unknown): void {
    this.logger?.storeError(store, 'tracing', error);
  }
}
