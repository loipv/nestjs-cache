import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import type { CacheModuleOptions } from '../../../src/module/cache.options.js';
import { CircuitOpenError } from '../../../src/resilience/circuit-breaker.store.js';
import type { KeyRef } from '../../../src/core/cache-engine.js';
import { VERSION_KEY_TTL } from '../../../src/core/version-tokens.js';
import type { LockHandle, LockProvider } from '../../../src/stores/cache-store.interface.js';
import { makeEngine } from '../helpers/engine.js';
import { FakeLock } from '../helpers/fake-lock.js';
import { FakeStore } from '../helpers/fake-store.js';
import type {
  SpanLike,
  SpanOptionsLike,
  TracerLike,
} from '../../../src/observability/tracing.types.js';
import { FakeTracer, type FakeSpan } from '../helpers/fake-tracer.js';

const SWR = { ttl: 100, strategy: 'swr', staleTtl: 1_000 } as const;
const ERROR = { code: 2 };

let tracers: FakeTracer[] = [];

/** An engine tracing into a fresh `FakeTracer`, checked in `afterEach`. */
function traced(options: CacheModuleOptions = {}, recordKeys = false) {
  const tracer = new FakeTracer();
  tracers.push(tracer);
  return { ...makeEngine({ ...options, tracer, recordKeys }), tracer };
}

function lockingStore(lock: LockProvider = new FakeLock()): FakeStore & { lock: LockProvider } {
  return Object.assign(new FakeStore(), { lock });
}

function delayed<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(value);
    }, ms);
  });
}

function rejectedAfter(ms: number, error: Error): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(error);
    }, ms);
  });
}

function children(tracer: FakeTracer, parent: FakeSpan): string[] {
  return tracer
    .spans()
    .filter((span) => span.parent === parent)
    .map((span) => span.name);
}

function errorOperations(span: FakeSpan): unknown[] {
  return span.events
    .filter((event) => event.name === 'cache.error')
    .map((event) => event.attributes?.['cache.error.operation']);
}

describe('CacheEngine tracing: single-key calls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const tracer of tracers) tracer.assertAllEnded();
    tracers = [];
  });

  it('each call has its span with cache.store and cache.namespace', async () => {
    const other = new FakeStore();
    const { engine, tracer } = traced({ stores: { default: new FakeStore(), other } });
    const ref = { store: 'other', namespace: 'ns', key: 'k' };
    await engine.get(ref);
    await engine.getOrSet(ref, async () => 1);
    await engine.set(ref, 1);
    await engine.put(ref, 2);
    await engine.delete({ store: 'other', namespace: 'ns' }, ['k', 'j']);
    await engine.clear('ns', 'other');
    await engine.invalidateTags(['t', 't', 'u'], 'other');
    const roots = tracer.spans().filter((span) => span.parent === undefined);
    expect(roots.map((span) => span.name)).toEqual([
      'cache.get',
      'cache.getOrSet',
      'cache.set',
      'cache.put',
      'cache.delete',
      'cache.clear',
      'cache.invalidateTags',
    ]);
    for (const span of roots.slice(0, 6)) {
      expect(span.attributes).toMatchObject({ 'cache.store': 'other', 'cache.namespace': 'ns' });
    }
    const invalidate = tracer.span('cache.invalidateTags');
    expect(invalidate.attributes['cache.store']).toBe('other');
    expect(invalidate.attributes).not.toHaveProperty('cache.namespace');
    // De-duplicated tags; valid keys.
    expect(invalidate.attributes['cache.tags']).toBe(2);
    expect(tracer.span('cache.delete').attributes['cache.keys']).toBe(2);
    // The default store when none is named; no namespace attribute without a namespace.
    await engine.get({ key: 'x' });
    const plain = tracer.spans('cache.get')[1]!;
    expect(plain.attributes['cache.store']).toBe('default');
    expect(plain.attributes).not.toHaveProperty('cache.namespace');
  });

  it('cache.result is hit, stale, miss or bypass', async () => {
    const { engine, tracer } = traced();
    await engine.get({ key: 'k' });
    await engine.set({ key: 'k' }, 'v', SWR);
    await engine.get({ key: 'k' });
    vi.setSystemTime(150);
    await engine.getOrSet({ key: 'k' }, async () => 'new', SWR);
    await vi.runAllTimersAsync();
    await engine.getOrSet({ key: '' }, async () => 'loaded');
    await engine.get({ key: '' });
    const results = [...tracer.spans('cache.get'), ...tracer.spans('cache.getOrSet')].map(
      (span) => span.attributes['cache.result'],
    );
    expect(results).toEqual(['miss', 'hit', 'bypass', 'stale', 'bypass']);
  });

  it('cache.result is bypass when a versioned namespace cannot read its version', async () => {
    const { engine, store, tracer } = traced({ namespaces: { users: { versioned: true } } });
    store.failNext('get');
    expect(await engine.getOrSet({ namespace: 'users', key: '1' }, async () => 'v')).toBe('v');
    store.failNext('get');
    expect(await engine.get({ namespace: 'users', key: '1' })).toBeUndefined();
    for (const span of [tracer.span('cache.getOrSet'), tracer.span('cache.get')]) {
      expect(span.attributes['cache.result']).toBe('bypass');
      expect(errorOperations(span)).toEqual(['version']);
      expect(span.status).toBeUndefined();
    }
  });

  it('the second of two concurrent misses joins the load and has no cache.load', async () => {
    const { engine, tracer } = traced();
    const loader = vi.fn(() => delayed(10, 'v'));
    const both = Promise.all([
      engine.getOrSet({ key: 'k' }, loader),
      engine.getOrSet({ key: 'k' }, loader),
    ]);
    await vi.runAllTimersAsync();
    expect(await both).toEqual(['v', 'v']);
    expect(loader).toHaveBeenCalledOnce();
    const [owner, joined] = tracer.spans('cache.getOrSet');
    expect(owner!.attributes).not.toHaveProperty('cache.load.joined');
    expect(joined!.attributes['cache.load.joined']).toBe(true);
    expect(joined!.attributes['cache.result']).toBe('miss');
    expect(tracer.span('cache.load').parent).toBe(owner);
    expect(children(tracer, joined!)).toEqual([]);
  });

  it('a miss joining a refresh that a held lock skipped is not marked joined', async () => {
    const inner = new FakeLock();
    // acquire settles after 10 ms, so the refresh flight is still open when the miss arrives.
    const slow: LockProvider = {
      acquire: (key, ttlMs) =>
        delayed(10, undefined).then((): Promise<LockHandle | undefined> =>
          inner.acquire(key, ttlMs),
        ),
    };
    const { engine, tracer } = traced({
      stores: { default: lockingStore(slow) },
      defaults: { lock: { waitTimeout: 200 } },
    });
    const opts = { ...SWR, lock: true };
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    inner.held.add('__lock__:k');
    expect(await engine.getOrSet({ key: 'k' }, async () => 'new', opts)).toBe('old');
    await engine.delete({}, ['k']);
    const joined = engine.getOrSet({ key: 'k' }, async () => 'missed', opts);
    await vi.advanceTimersByTimeAsync(310);
    expect(await joined).toBe('missed');
    const miss = tracer.spans('cache.getOrSet')[1]!;
    expect(miss.attributes['cache.result']).toBe('miss');
    // It loaded on its own: its own cache.load, and no cache.load.joined.
    expect(miss.attributes).not.toHaveProperty('cache.load.joined');
    expect(children(tracer, miss)).toEqual(['cache.lock', 'cache.load']);
  });

  it('misses sharing the load that follows a skipped refresh are marked joined', async () => {
    const inner = new FakeLock();
    // acquire settles after 10 ms, so the refresh flight is still open when the misses arrive.
    const slow: LockProvider = {
      acquire: (key, ttlMs) =>
        delayed(10, undefined).then((): Promise<LockHandle | undefined> =>
          inner.acquire(key, ttlMs),
        ),
    };
    const { engine, tracer } = traced({
      stores: { default: lockingStore(slow) },
      defaults: { lock: { waitTimeout: 200 } },
    });
    const opts = { ...SWR, lock: true };
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    inner.held.add('__lock__:k');
    expect(await engine.getOrSet({ key: 'k' }, async () => 'new', opts)).toBe('old');
    await engine.delete({}, ['k']);
    const loader = vi.fn(async () => 'missed');
    const misses = Promise.all([
      engine.getOrSet({ key: 'k' }, loader, opts),
      engine.getOrSet({ key: 'k' }, loader, opts),
      engine.getOrSet({ key: 'k' }, loader, opts),
    ]);
    await vi.advanceTimersByTimeAsync(310);
    expect(await misses).toEqual(['missed', 'missed', 'missed']);
    expect(loader).toHaveBeenCalledOnce();
    const [, owner, ...joiners] = tracer.spans('cache.getOrSet');
    // All three joined the skipped refresh; the first then loads, the other two share its load.
    expect(owner!.attributes).not.toHaveProperty('cache.load.joined');
    expect(children(tracer, owner!)).toEqual(['cache.lock', 'cache.load']);
    expect(joiners).toHaveLength(2);
    for (const joiner of joiners) {
      expect(joiner.attributes['cache.load.joined']).toBe(true);
      expect(children(tracer, joiner)).toEqual([]);
    }
  });

  it('a miss joining a load that fails is still marked joined', async () => {
    const { engine, tracer } = traced();
    const failure = new Error('shared load failed');
    const loader = vi.fn(() => rejectedAfter(10, failure));
    const both = Promise.allSettled([
      engine.getOrSet({ key: 'k' }, loader),
      engine.getOrSet({ key: 'k' }, loader),
    ]);
    await vi.runAllTimersAsync();
    expect((await both).map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(loader).toHaveBeenCalledOnce();
    const [owner, joined] = tracer.spans('cache.getOrSet');
    expect(owner!.attributes).not.toHaveProperty('cache.load.joined');
    expect(joined!.attributes['cache.load.joined']).toBe(true);
    expect(children(tracer, joined!)).toEqual([]);
    expect(joined!.exceptions).toEqual([failure]);
    expect(joined!.status).toEqual(ERROR);
  });

  it('a span started by the loader is under cache.load, itself under cache.getOrSet', async () => {
    const { engine, tracer } = traced();
    await engine.getOrSet({ key: 'k' }, async () => {
      const db = tracer.startSpan('db.query');
      await Promise.resolve();
      db.end();
      return 'v';
    });
    const db = tracer.span('db.query');
    expect(db.parent?.name).toBe('cache.load');
    expect(db.parent?.parent).toBe(tracer.span('cache.getOrSet'));
  });

  it('a loader skipping the cache (empty key) still runs in cache.load', async () => {
    const { engine, tracer } = traced();
    expect(await engine.getOrSet({ key: '' }, async () => 'v')).toBe('v');
    expect(tracer.span('cache.load').parent).toBe(tracer.span('cache.getOrSet'));
  });
});

describe('CacheEngine tracing: the lock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const tracer of tracers) tracer.assertAllEnded();
    tracers = [];
  });

  const LOCK = { defaults: { lock: { enabled: true, waitTimeout: 100, retryDelay: 10 } } };

  it('an acquired lock: cache.lock.acquired true, the load beside it', async () => {
    const { engine, tracer } = traced({ ...LOCK, stores: { default: lockingStore() } });
    expect(await engine.getOrSet({ key: 'k' }, async () => 'v')).toBe('v');
    const main = tracer.span('cache.getOrSet');
    const lock = tracer.span('cache.lock');
    expect(lock.parent).toBe(main);
    expect(lock.attributes['cache.lock.acquired']).toBe(true);
    expect(children(tracer, main)).toEqual(['cache.lock', 'cache.load']);
    expect(main.attributes['cache.result']).toBe('miss');
  });

  it('a lock wait that times out: cache.lock.acquired false, then the load', async () => {
    const lock = new FakeLock();
    lock.held.add('__lock__:k');
    const { engine, tracer } = traced({ ...LOCK, stores: { default: lockingStore(lock) } });
    const pending = engine.getOrSet({ key: 'k' }, async () => 'v');
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe('v');
    expect(tracer.span('cache.lock').attributes['cache.lock.acquired']).toBe(false);
    expect(tracer.span('cache.getOrSet').attributes['cache.result']).toBe('miss');
    expect(tracer.spans('cache.load')).toHaveLength(1);
  });

  it('a value written while waiting makes the call a hit', async () => {
    const lock = new FakeLock();
    lock.held.add('__lock__:k');
    const store = lockingStore(lock);
    const { engine, tracer } = traced({ ...LOCK, stores: { default: store } });
    const writer = makeEngine({ stores: { default: store } }).engine;
    const loader = vi.fn(async () => 'mine');
    const pending = engine.getOrSet({ key: 'k' }, loader);
    await vi.advanceTimersByTimeAsync(5);
    await writer.set({ key: 'k' }, 'theirs');
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBe('theirs');
    expect(loader).not.toHaveBeenCalled();
    expect(tracer.span('cache.lock').attributes['cache.lock.acquired']).toBe(false);
    expect(tracer.span('cache.getOrSet').attributes['cache.result']).toBe('hit');
    expect(tracer.spans('cache.load')).toEqual([]);
  });

  it('a failing acquire ends cache.lock without cache.lock.acquired', async () => {
    const lock = new FakeLock();
    const failure = new Error('acquire failed');
    lock.failNext('acquire', failure);
    const { engine, tracer } = traced({ ...LOCK, stores: { default: lockingStore(lock) } });
    expect(await engine.getOrSet({ key: 'k' }, async () => 'v')).toBe('v');
    const span = tracer.span('cache.lock');
    expect(span.attributes).not.toHaveProperty('cache.lock.acquired');
    const main = tracer.span('cache.getOrSet');
    expect(main.exceptions).toEqual([failure]);
    expect(errorOperations(main)).toEqual(['lock']);
    expect(main.status).toBeUndefined();
  });

  it('a failing background release is recorded on no span, and still emits its error (M5)', async () => {
    const lock = new FakeLock();
    const failure = new Error('release failed');
    lock.failNext('release', failure);
    const { engine, emitted, tracer } = traced({
      ...LOCK,
      stores: { default: lockingStore(lock) },
    });
    expect(await engine.getOrSet({ key: 'k' }, async () => 'v')).toBe('v');
    await vi.waitFor(() => {
      expect(emitted.filter((e) => e.event === 'error')).toHaveLength(1);
    });
    expect(lock.releaseCalls).toEqual(['__lock__:k']);
    expect(emitted.find((e) => e.event === 'error')?.payload).toEqual({
      store: 'default',
      operation: 'lock',
      error: failure,
    });
    expect(tracer.span('cache.lock').attributes['cache.lock.acquired']).toBe(true);
    for (const span of tracer.spans()) {
      expect(span.exceptions).toEqual([]);
      expect(span.events).toEqual([]);
      expect(span.status).toBeUndefined();
    }
  });
});

describe('CacheEngine tracing: swr refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const tracer of tracers) tracer.assertAllEnded();
    tracers = [];
  });

  it('a stale read starts a root cache.refresh linked to cache.getOrSet, with its own load', async () => {
    const { engine, tracer } = traced();
    await engine.set({ namespace: 'ns', key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    expect(await engine.getOrSet({ namespace: 'ns', key: 'k' }, async () => 'new', SWR)).toBe(
      'old',
    );
    await vi.runAllTimersAsync();
    const main = tracer.span('cache.getOrSet');
    const refresh = tracer.span('cache.refresh');
    expect(refresh.root).toBe(true);
    expect(refresh.parent).toBeUndefined();
    expect(refresh.links).toEqual([
      { context: { traceId: main.traceId, spanId: main.spanId, traceFlags: 1 } },
    ]);
    expect(refresh.attributes).toEqual({ 'cache.store': 'default', 'cache.namespace': 'ns' });
    expect(tracer.span('cache.load').parent).toBe(refresh);
    expect(children(tracer, main)).toEqual([]);
    expect(main.attributes['cache.result']).toBe('stale');
  });

  it('a second stale read during the refresh starts no new cache.refresh', async () => {
    const { engine, tracer } = traced();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const loader = vi.fn(() => delayed(50, 'new'));
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    await vi.runAllTimersAsync();
    expect(loader).toHaveBeenCalledOnce();
    expect(tracer.spans('cache.getOrSet')).toHaveLength(2);
    expect(tracer.spans('cache.refresh')).toHaveLength(1);
  });

  it('a refresh skipped by a held lock still ends cache.refresh once', async () => {
    const lock = new FakeLock();
    const { engine, tracer } = traced({
      defaults: { lock: { enabled: true } },
      stores: { default: lockingStore(lock) },
    });
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    lock.held.add('__lock__:k');
    const loader = vi.fn(async () => 'new');
    expect(await engine.getOrSet({ key: 'k' }, loader, SWR)).toBe('old');
    await vi.runAllTimersAsync();
    expect(loader).not.toHaveBeenCalled();
    const refresh = tracer.span('cache.refresh');
    expect(refresh.endCount).toBe(1);
    expect(children(tracer, refresh)).toEqual(['cache.lock']);
    expect(tracer.span('cache.lock').attributes['cache.lock.acquired']).toBe(false);
  });

  it('a refresh failing after the main span ended is recorded on cache.refresh only', async () => {
    const { engine, tracer } = traced();
    await engine.set({ key: 'k' }, 'old', SWR);
    vi.setSystemTime(150);
    const failure = new Error('refresh loader failed');
    expect(await engine.getOrSet({ key: 'k' }, () => rejectedAfter(50, failure), SWR)).toBe('old');
    const main = tracer.span('cache.getOrSet');
    expect(main.endCount).toBe(1);
    await vi.runAllTimersAsync();
    const refresh = tracer.span('cache.refresh');
    // Recorded once, though it is both the failed child's error and a swallowed refresh error.
    expect(refresh.exceptions).toEqual([failure]);
    expect(refresh.status).toEqual(ERROR);
    expect(errorOperations(refresh)).toEqual(['refresh']);
    expect(tracer.span('cache.load').exceptions).toEqual([failure]);
    expect(tracer.span('cache.load').status).toEqual(ERROR);
    expect(main.exceptions).toEqual([]);
    expect(main.events).toEqual([]);
    expect(main.status).toBeUndefined();
    expect(main.writesAfterEnd).toEqual([]);
  });

  it('a refresh skipped by backoff starts no cache.refresh', async () => {
    /* Spec 3.5: a stale read during the backoff after a failed refresh creates no span. */
    const { engine, tracer } = traced();
    const options = { ...SWR, staleTtl: 10_000 } as const;
    await engine.set({ key: 'k' }, 'old', options);
    vi.setSystemTime(150);
    const loader = vi.fn((): Promise<string> => Promise.reject(new Error('boom')));
    expect(await engine.getOrSet({ key: 'k' }, loader, options)).toBe('old');
    await vi.runAllTimersAsync();
    expect(tracer.spans('cache.refresh')).toHaveLength(1);
    vi.setSystemTime(500);
    expect(await engine.getOrSet({ key: 'k' }, loader, options)).toBe('old');
    await vi.runAllTimersAsync();
    expect(loader).toHaveBeenCalledOnce();
    expect(tracer.spans('cache.refresh')).toHaveLength(1);
    expect(tracer.spans('cache.getOrSet')).toHaveLength(2);
    expect(tracer.spans('cache.load')).toHaveLength(1);
  });
});

describe('CacheEngine tracing: writes and errors', () => {
  afterEach(() => {
    for (const tracer of tracers) tracer.assertAllEnded();
    tracers = [];
  });

  it('cache.written is false for an unless veto, a skipped tag list, a store error, an empty key or a failed version read', async () => {
    const { engine, store, tracer } = traced({ namespaces: { users: { versioned: true } } });
    await engine.put({ key: 'a' }, 1, { unless: () => true });
    await engine.put({ key: 'b' }, 1, { tags: [''] });
    await engine.set({ key: 'c' }, 1, { tags: [''] });
    store.failNext('set');
    await engine.set({ key: 'd' }, 1);
    store.failNext('set');
    await engine.put({ key: 'e' }, 1);
    await engine.set({ key: 'f' }, 1);
    await engine.put({ key: 'g' }, 1);
    await engine.set({ key: '' }, 1);
    await engine.put({ key: '' }, 1);
    store.failNext('get');
    await engine.set({ namespace: 'users', key: 'h' }, 1);
    store.failNext('get');
    await engine.put({ namespace: 'users', key: 'i' }, 1);
    const written = (name: string) =>
      tracer.spans(name).map((span) => span.attributes['cache.written']);
    expect(written('cache.put')).toEqual([false, false, false, true, false, false]);
    expect(written('cache.set')).toEqual([false, false, true, false, false]);
    // The swallowed errors leave the status unset.
    expect(tracer.spans().every((span) => span.status === undefined)).toBe(true);
  });

  it.each([
    [
      'throws synchronously',
      (error: Error) => () => {
        throw error;
      },
    ],
    ['rejects', (error: Error) => () => Promise.reject(error)],
  ])('a loader that %s marks cache.load and cache.getOrSet ERROR', async (_, make) => {
    const { engine, tracer } = traced();
    const failure = new Error('loader failed');
    const loader = make(failure) as () => Promise<string>;
    await expect(engine.getOrSet({ key: 'k' }, loader)).rejects.toBe(failure);
    const main = tracer.span('cache.getOrSet');
    const load = tracer.span('cache.load');
    expect(load.parent).toBe(main);
    expect(load.status).toEqual(ERROR);
    expect(load.exceptions).toEqual([failure]);
    expect(main.status).toEqual(ERROR);
    expect(main.exceptions).toEqual([failure]);
  });

  it('a loader rejecting undefined marks cache.load and cache.getOrSet ERROR', async () => {
    const { engine, tracer } = traced();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
    const loader = (): Promise<string> => Promise.reject(undefined);
    await expect(engine.getOrSet({ key: 'k' }, loader)).rejects.toBeUndefined();
    const main = tracer.span('cache.getOrSet');
    const load = tracer.span('cache.load');
    expect(load.status).toEqual(ERROR);
    expect(load.exceptions).toEqual([undefined]);
    expect(main.status).toEqual(ERROR);
    expect(main.exceptions).toEqual([undefined]);
  });

  it('a failed invalidateTags records its error once: the version event, then ERROR', async () => {
    const { engine, store, tracer } = traced();
    const failure = new Error('token write failed');
    store.failNext('set', failure);
    await expect(engine.invalidateTags(['t'])).rejects.toBe(failure);
    const span = tracer.span('cache.invalidateTags');
    expect(span.exceptions).toEqual([failure]);
    expect(errorOperations(span)).toEqual(['version']);
    expect(span.status).toEqual(ERROR);
  });

  it('a non-object ref or scope rejects instead of throwing, traced as untraced', async () => {
    const calls: [string, (engine: ReturnType<typeof makeEngine>['engine']) => Promise<unknown>][] =
      [
        ['cache.get', (e) => e.get(null as unknown as KeyRef)],
        ['cache.getOrSet', (e) => e.getOrSet(undefined as unknown as KeyRef, async () => 1)],
        ['cache.set', (e) => e.set(null as unknown as KeyRef, 1)],
        ['cache.put', (e) => e.put(null as unknown as KeyRef, 1)],
        ['cache.getMany', (e) => e.getMany(null as never, ['a'])],
        ['cache.setMany', (e) => e.setMany(null as never, [['a', 1]])],
        ['cache.getOrSetMany', (e) => e.getOrSetMany(null as never, ['a'], async () => new Map())],
        ['cache.delete', (e) => e.delete(null as never, ['a'])],
      ];
    const { engine, tracer } = traced();
    const untraced = makeEngine().engine;
    for (const [name, call] of calls) {
      let pending: Promise<unknown> | undefined;
      expect(() => {
        pending = call(engine);
      }).not.toThrow();
      await expect(pending).rejects.toBeInstanceOf(TypeError);
      await expect(call(untraced)).rejects.toBeInstanceOf(TypeError);
      const span = tracer.span(name);
      expect(span.attributes['cache.store']).toBe('default');
      expect(span.attributes).not.toHaveProperty('cache.namespace');
      expect(span.status).toEqual(ERROR);
    }
  });

  it('a CacheConfigError from validation ends the span with ERROR and rejects', async () => {
    const { engine, tracer } = traced();
    await expect(engine.getOrSet({ key: 'k' }, async () => 1, { ttl: -1 })).rejects.toBeInstanceOf(
      CacheConfigError,
    );
    await expect(engine.get({ store: 'nope', key: 'k' })).rejects.toBeInstanceOf(CacheConfigError);
    await expect(engine.set({ namespace: '__x', key: 'k' }, 1)).rejects.toBeInstanceOf(
      CacheConfigError,
    );
    await expect(engine.put({ key: 'k' }, 1, { ttl: 0 })).rejects.toBeInstanceOf(CacheConfigError);
    await expect(engine.delete({ store: 'nope' }, ['k'])).rejects.toBeInstanceOf(CacheConfigError);
    await expect(engine.clear('')).rejects.toBeInstanceOf(CacheConfigError);
    await expect(engine.invalidateTags([])).rejects.toBeInstanceOf(CacheConfigError);
    const spans = tracer.spans();
    expect(spans).toHaveLength(7);
    for (const span of spans) {
      expect(span.status).toEqual(ERROR);
      expect(span.exceptions).toHaveLength(1);
      expect(span.exceptions[0]).toBeInstanceOf(CacheConfigError);
    }
  });

  it('a store read error is recorded on cache.getOrSet with its operation, status unset', async () => {
    const { engine, store, tracer } = traced();
    const failure = new Error('get failed');
    store.failNext('get', failure);
    expect(await engine.getOrSet({ key: 'k' }, async () => 'v')).toBe('v');
    const main = tracer.span('cache.getOrSet');
    expect(main.exceptions).toEqual([failure]);
    expect(errorOperations(main)).toEqual(['get']);
    expect(main.status).toBeUndefined();
    expect(main.attributes['cache.result']).toBe('miss');
  });

  it('a nested call whose span fails to start never writes onto the outer span', async () => {
    const inner = new FakeTracer();
    tracers.push(inner);
    // Fails only for `cache.get`: the nested call falls back to running untraced.
    const selective: TracerLike = {
      startActiveSpan<F extends (span: SpanLike) => unknown>(
        name: string,
        options: SpanOptionsLike,
        fn: F,
      ): ReturnType<F> {
        if (name === 'cache.get') throw new Error('fake tracer: cache.get failed');
        return inner.startActiveSpan(name, options, fn);
      },
      startSpan: (name, options) => inner.startSpan(name, options),
    };
    const { engine, store } = makeEngine({ tracer: selective });
    await engine.set({ key: 'other' }, 'x');
    const failure = new Error('read failed');
    const value = await engine.getOrSet({ key: 'k' }, async () => {
      store.failNext('get', failure);
      const missed = await engine.get<string>({ key: 'gone' });
      const hit = await engine.get<string>({ key: 'other' });
      return `${String(missed)}/${String(hit)}`;
    });
    expect(value).toBe('undefined/x');
    const main = inner.span('cache.getOrSet');
    expect(main.attributes['cache.result']).toBe('miss');
    expect(main.exceptions).toEqual([]);
    expect(main.events).toEqual([]);
    expect(main.status).toBeUndefined();
    expect(inner.spans('cache.get')).toEqual([]);
  });

  it('a CircuitOpenError records nothing', async () => {
    const lock = new FakeLock();
    const store = lockingStore(lock);
    const { engine, tracer } = traced({ stores: { default: store } });
    store.failNext('get', new CircuitOpenError());
    store.failNext('set', new CircuitOpenError());
    lock.failNext('acquire', new CircuitOpenError());
    expect(await engine.getOrSet({ key: 'k' }, async () => 1, { lock: true })).toBe(1);
    store.failNext('delete', new CircuitOpenError());
    await engine.delete({}, ['k']);
    for (const span of tracer.spans()) {
      expect(span.exceptions).toEqual([]);
      expect(span.events).toEqual([]);
      expect(span.status).toBeUndefined();
    }
  });

  it('a failing background token touch is recorded on no span, and still emits its error (M5)', async () => {
    class TouchStore extends FakeStore {
      readonly touch = vi.fn((): Promise<void> => Promise.reject(new Error('touch failed')));
    }
    const store = new TouchStore();
    // The token exists already: a token this process just created is not touched.
    store.data.set('app:__version__:users', { value: 'token001', ttlMs: VERSION_KEY_TTL });
    const { engine, emitted, tracer } = traced({
      prefix: 'app',
      namespaces: { users: { versioned: true } },
      stores: { default: store },
    });
    await engine.set({ namespace: 'users', key: '1' }, 'x');
    await vi.waitFor(() => {
      expect(emitted.filter((e) => e.event === 'error')).toHaveLength(1);
    });
    expect(store.touch).toHaveBeenCalledTimes(1);
    expect(emitted.find((e) => e.event === 'error')?.payload).toEqual({
      store: 'default',
      operation: 'touch',
      error: new Error('touch failed'),
    });
    expect(tracer.spans().length).toBeGreaterThan(0);
    for (const span of tracer.spans()) {
      expect(span.exceptions).toEqual([]);
      expect(span.events).toEqual([]);
      expect(span.status).toBeUndefined();
    }
  });

  it('takeTags has no span of its own', async () => {
    const { engine, tracer } = traced();
    expect(await engine.takeTags(undefined, [''])).toBe('skip');
    expect(tracer.spans()).toEqual([]);
  });
});

describe('CacheEngine tracing: keys and concurrency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const tracer of tracers) tracer.assertAllEnded();
    tracers = [];
  });

  async function everyCall(engine: ReturnType<typeof makeEngine>['engine']): Promise<void> {
    const ref = { namespace: 'ns', key: 'k' };
    await engine.get(ref);
    await engine.getOrSet(ref, async () => 1);
    await engine.set(ref, 1);
    await engine.put(ref, 2);
    await engine.delete({ namespace: 'ns' }, ['k', '', 'j']);
    await engine.clear('ns');
    await engine.invalidateTags(['t', 'u', 't']);
  }

  it('recordKeys false sets no cache.key', async () => {
    const { engine, tracer } = traced({ prefix: 'app' });
    await everyCall(engine);
    expect(tracer.spans()).toHaveLength(8);
    for (const span of tracer.spans()) expect(span.attributes).not.toHaveProperty('cache.key');
  });

  it('recordKeys true sets the full keys, with the prefix', async () => {
    const { engine, tracer } = traced({ prefix: 'app' }, true);
    await everyCall(engine);
    const key = (name: string) => tracer.span(name).attributes['cache.key'];
    for (const name of ['cache.get', 'cache.getOrSet', 'cache.set', 'cache.put']) {
      expect(key(name)).toBe('app:ns:k');
    }
    expect(key('cache.delete')).toEqual(['app:ns:k', 'app:ns:j']);
    expect(key('cache.invalidateTags')).toEqual(['t', 'u']);
    expect(tracer.span('cache.clear').attributes).not.toHaveProperty('cache.key');
    expect(tracer.span('cache.load').attributes).not.toHaveProperty('cache.key');
  });

  it('two concurrent getOrSet calls keep their own result and errors', async () => {
    const { engine, tracer } = traced();
    await engine.set({ key: 'a' }, 'cached');
    const failure = new Error('b failed');
    const a = engine.getOrSet({ key: 'a' }, () => delayed(20, 'unused'));
    const b = engine.getOrSet({ key: 'b' }, () => rejectedAfter(10, failure));
    const c = engine.getOrSet({ key: 'c' }, () => delayed(30, 'loaded'));
    const settled = Promise.allSettled([a, b, c]);
    await vi.runAllTimersAsync();
    const [ra, rb, rc] = await settled;
    expect(ra).toEqual({ status: 'fulfilled', value: 'cached' });
    expect(rb).toEqual({ status: 'rejected', reason: failure });
    expect(rc).toEqual({ status: 'fulfilled', value: 'loaded' });
    const [sa, sb, sc] = tracer.spans('cache.getOrSet');
    expect(sa!.attributes['cache.result']).toBe('hit');
    expect(sa!.exceptions).toEqual([]);
    expect(sa!.status).toBeUndefined();
    expect(sb!.attributes['cache.result']).toBe('miss');
    expect(sb!.exceptions).toEqual([failure]);
    expect(sb!.status).toEqual(ERROR);
    expect(sc!.attributes['cache.result']).toBe('miss');
    expect(sc!.exceptions).toEqual([]);
    expect(sc!.status).toBeUndefined();
    const loads = tracer.spans('cache.load');
    expect(loads.map((span) => span.parent)).toEqual([sb, sc]);
  });
});
