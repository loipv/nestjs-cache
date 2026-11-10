import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWithLock } from '../../../src/core/lock-runner.js';
import { CacheConfigError } from '../../../src/errors.js';
import {
  circuitBreaker,
  CircuitBreakerStore,
  CircuitOpenError,
} from '../../../src/resilience/circuit-breaker.store.js';
import type {
  CacheStore,
  InvalidationBus,
  LockHandle,
} from '../../../src/stores/cache-store.interface.js';
import { FakeBus } from '../helpers/fake-bus.js';
import { FakeLock } from '../helpers/fake-lock.js';
import { FakeStore } from '../helpers/fake-store.js';
import { memoryStore } from '../../../src/stores/memory.store.js';

const TIMEOUT_MESSAGE = 'Cache store operation timed out after 500 ms';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Makes the next `inner.get` hang until the returned deferred settles. */
function hangNextGet(inner: FakeStore): Deferred<string | undefined> {
  const d = deferred<string | undefined>();
  vi.spyOn(inner, 'get').mockImplementationOnce(() => d.promise);
  return d;
}

function makeSink() {
  return { emit: vi.fn() };
}

function breakerStates(sink: ReturnType<typeof makeSink>): unknown[] {
  return sink.emit.mock.calls.map((call) => (call[1] as { state: string }).state);
}

/** Opens a breaker with `failureThreshold` 1 by failing one `get`. */
async function openWithOneFailure(inner: FakeStore, b: ReturnType<typeof circuitBreaker>) {
  inner.failNext('get');
  await expect(b.get('k')).rejects.toThrow('get failed');
  expect(b.state).toBe('open');
}

describe('circuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('opens after failureThreshold consecutive failures and rejects without calling the store', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 2 });
    const sink = makeSink();
    b.bind(sink);
    inner.failNext('get');
    inner.failNext('get');
    await expect(b.get('k')).rejects.toThrow();
    expect(b.state).toBe('closed');
    await expect(b.get('k')).rejects.toThrow();
    expect(b.state).toBe('open');
    expect(sink.emit).toHaveBeenCalledWith('breaker', { state: 'open' });
    const calls = inner.calls.length;
    await expect(b.get('k')).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(b.set('k', 'v', 10)).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(b.delete(['k'])).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(b.clear('')).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(b.get('k')).rejects.toThrow('Cache store circuit is open');
    expect(inner.calls.length).toBe(calls);
  });

  it('uses the defaults: 5 failures, 10_000 ms open, 500 ms timeout', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner);
    for (let i = 0; i < 4; i++) {
      inner.failNext('set');
      await expect(b.set('k', 'v', 10)).rejects.toThrow('set failed');
    }
    expect(b.state).toBe('closed');
    inner.failNext('set');
    await expect(b.set('k', 'v', 10)).rejects.toThrow('set failed');
    expect(b.state).toBe('open');

    vi.setSystemTime(9_999);
    await expect(b.get('k')).rejects.toBeInstanceOf(CircuitOpenError);
    vi.setSystemTime(10_000);
    inner.data.set('k', { value: 'v', ttlMs: 10 });
    await expect(b.get('k')).resolves.toBe('v');
    expect(b.state).toBe('closed');

    hangNextGet(inner);
    const pending = b.get('k');
    const settled = expect(pending).rejects.toThrow(TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(499);
    let done = false;
    void pending.catch(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
  });

  it('a success resets the failure count', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 2 });
    inner.failNext('get');
    await expect(b.get('k')).rejects.toThrow();
    await expect(b.get('k')).resolves.toBeUndefined();
    inner.failNext('get');
    await expect(b.get('k')).rejects.toThrow();
    expect(b.state).toBe('closed');
    inner.failNext('get');
    await expect(b.get('k')).rejects.toThrow();
    expect(b.state).toBe('open');
  });

  it('counts failures across all guarded operations', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 4 });
    inner.failNext('get');
    inner.failNext('set');
    inner.failNext('delete');
    inner.failNext('clear');
    await expect(b.get('k')).rejects.toThrow('get failed');
    await expect(b.set('k', 'v', 1)).rejects.toThrow('set failed');
    await expect(b.delete(['k'])).rejects.toThrow('delete failed');
    expect(b.state).toBe('closed');
    await expect(b.clear('p')).rejects.toThrow('clear failed');
    expect(b.state).toBe('open');
  });

  it('forwards arguments and results of guarded operations', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner);
    await b.set('a', '1', 25);
    expect(inner.data.get('a')).toEqual({ value: '1', ttlMs: 25 });
    await expect(b.get('a')).resolves.toBe('1');
    await b.delete(['a']);
    expect(inner.data.has('a')).toBe(false);
    await b.set('p:x', '2', 5);
    await b.clear('p:');
    expect(inner.data.size).toBe(0);
    expect(inner.calls.map((c) => c.op)).toEqual(['set', 'get', 'delete', 'set', 'clear']);
  });

  it('half-open lets exactly one probe through', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 1, openDuration: 1_000 });
    const sink = makeSink();
    b.bind(sink);
    await openWithOneFailure(inner, b);

    vi.setSystemTime(999);
    await expect(b.get('k')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(b.state).toBe('open');

    vi.advanceTimersByTime(1);
    const probe = hangNextGet(inner);
    const probeCall = b.get('k');
    expect(b.state).toBe('half-open');
    const before = inner.calls.length;
    const getSpy = vi.mocked(inner.get);
    const callsBefore = getSpy.mock.calls.length;
    await expect(b.get('k')).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(b.set('k', 'v', 1)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(getSpy.mock.calls.length).toBe(callsBefore);
    expect(inner.calls.length).toBe(before);

    probe.resolve('v');
    await expect(probeCall).resolves.toBe('v');
    expect(b.state).toBe('closed');
    expect(breakerStates(sink)).toEqual(['open', 'half-open', 'closed']);

    // The failure count was reset: with threshold 1 one new failure opens it again.
    await expect(b.get('k')).resolves.toBeUndefined();
    await openWithOneFailure(inner, b);
  });

  it('a probe that succeeds resets the count (threshold > 1)', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 2, openDuration: 100 });
    inner.failNext('get');
    inner.failNext('get');
    await expect(b.get('k')).rejects.toThrow();
    await expect(b.get('k')).rejects.toThrow();
    expect(b.state).toBe('open');
    vi.setSystemTime(100);
    await expect(b.get('k')).resolves.toBeUndefined();
    expect(b.state).toBe('closed');
    inner.failNext('get');
    await expect(b.get('k')).rejects.toThrow();
    expect(b.state).toBe('closed');
  });

  it('a failed probe reopens and restarts openDuration', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 3, openDuration: 1_000 });
    const sink = makeSink();
    b.bind(sink);
    for (let i = 0; i < 3; i++) {
      inner.failNext('get');
      await expect(b.get('k')).rejects.toThrow();
    }
    expect(b.state).toBe('open');

    vi.setSystemTime(5_000);
    inner.failNext('get');
    // One failed probe is enough to reopen, whatever the threshold.
    await expect(b.get('k')).rejects.toThrow('get failed');
    expect(b.state).toBe('open');
    expect(breakerStates(sink)).toEqual(['open', 'half-open', 'open']);

    const calls = inner.calls.length;
    vi.setSystemTime(5_999);
    await expect(b.get('k')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(inner.calls.length).toBe(calls);

    vi.setSystemTime(6_000);
    await expect(b.get('k')).resolves.toBeUndefined();
    expect(b.state).toBe('closed');
    expect(breakerStates(sink)).toEqual(['open', 'half-open', 'open', 'half-open', 'closed']);
  });

  it('a probe that times out reopens with a fresh openDuration', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 1, openDuration: 1_000 });
    await openWithOneFailure(inner, b);
    vi.setSystemTime(1_000);
    hangNextGet(inner);
    const probe = expect(b.get('k')).rejects.toThrow(TIMEOUT_MESSAGE);
    expect(b.state).toBe('half-open');
    await vi.advanceTimersByTimeAsync(500);
    await probe;
    expect(b.state).toBe('open');
    // Reopened at 1_500, so it stays open until 2_500.
    vi.setSystemTime(2_499);
    await expect(b.get('k')).rejects.toBeInstanceOf(CircuitOpenError);
    vi.setSystemTime(2_500);
    await expect(b.get('k')).resolves.toBeUndefined();
    expect(b.state).toBe('closed');
  });

  it('a half-open probe that throws synchronously reopens with a fresh openDuration', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 1, openDuration: 1_000 });
    const sink = makeSink();
    b.bind(sink);
    await openWithOneFailure(inner, b);
    vi.setSystemTime(1_500);
    vi.spyOn(inner, 'get').mockImplementationOnce(() => {
      throw new Error('sync probe');
    });
    await expect(b.get('k')).rejects.toThrow('sync probe');
    expect(b.state).toBe('open');
    expect(breakerStates(sink)).toEqual(['open', 'half-open', 'open']);
    // Reopened at 1_500, so it stays open until 2_500.
    vi.setSystemTime(2_499);
    await expect(b.get('k')).rejects.toBeInstanceOf(CircuitOpenError);
    vi.setSystemTime(2_500);
    await expect(b.get('k')).resolves.toBeUndefined();
    expect(b.state).toBe('closed');
  });

  it('a probe that times out and then succeeds late leaves the breaker open', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 1, openDuration: 1_000 });
    const sink = makeSink();
    b.bind(sink);
    await openWithOneFailure(inner, b);
    vi.setSystemTime(1_000);
    const slow = hangNextGet(inner);
    const probe = expect(b.get('k')).rejects.toThrow(TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(500);
    await probe;
    expect(b.state).toBe('open');
    slow.resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    // The late success is ignored: still open, no further transition.
    expect(b.state).toBe('open');
    expect(breakerStates(sink)).toEqual(['open', 'half-open', 'open']);
    const calls = inner.calls.length;
    vi.setSystemTime(2_499);
    await expect(b.get('k')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(inner.calls.length).toBe(calls);
  });

  it('a timeout counts as a failure', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 1 });
    const sink = makeSink();
    b.bind(sink);
    hangNextGet(inner);
    const result = expect(b.get('k')).rejects.toThrow(TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(b.state).toBe('open');
    expect(sink.emit).toHaveBeenCalledWith('breaker', { state: 'open' });
  });

  it('uses the configured timeout in the message', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { timeout: 42 });
    hangNextGet(inner);
    const result = expect(b.get('k')).rejects.toThrow(
      'Cache store operation timed out after 42 ms',
    );
    await vi.advanceTimersByTimeAsync(42);
    await result;
  });

  it('a late success after a timeout does not reset the count (Review Focus 4)', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 2 });
    const slow = hangNextGet(inner);
    const first = expect(b.get('k')).rejects.toThrow(TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(500);
    await first;
    slow.resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(b.state).toBe('closed');
    inner.failNext('get');
    await expect(b.get('k')).rejects.toThrow('get failed');
    expect(b.state).toBe('open');
  });

  it('a late result does not change the state of an open breaker', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 1, openDuration: 10_000 });
    const sink = makeSink();
    b.bind(sink);
    const slow = hangNextGet(inner);
    const first = expect(b.get('k')).rejects.toThrow(TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(500);
    await first;
    expect(b.state).toBe('open');
    slow.resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(b.state).toBe('open');
    expect(breakerStates(sink)).toEqual(['open']);
  });

  it('a timed-out operation that later rejects counts once', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 2 });
    const slow = hangNextGet(inner);
    const first = expect(b.get('k')).rejects.toThrow(TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(500);
    await first;
    slow.reject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);
    // Two failures would have opened it.
    expect(b.state).toBe('closed');
  });

  it('ignores outcomes of operations admitted before the last state change', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 1, openDuration: 100 });
    const sink = makeSink();
    b.bind(sink);
    // Admitted while closed; settles while the breaker is half-open with a probe in flight.
    const old = hangNextGet(inner);
    const oldCall = b.get('old');
    inner.failNext('set');
    await expect(b.set('k', 'v', 1)).rejects.toThrow('set failed');
    expect(b.state).toBe('open');
    vi.setSystemTime(100);
    const probe = hangNextGet(inner);
    const probeCall = b.get('probe');
    expect(b.state).toBe('half-open');
    old.resolve('old');
    await expect(oldCall).resolves.toBe('old');
    expect(b.state).toBe('half-open');
    probe.reject(new Error('probe failed'));
    await expect(probeCall).rejects.toThrow('probe failed');
    expect(b.state).toBe('open');
    expect(breakerStates(sink)).toEqual(['open', 'half-open', 'open']);
  });

  it('treats a synchronous throw from the inner store as a failure', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 1 });
    vi.spyOn(inner, 'delete').mockImplementationOnce(() => {
      throw new Error('sync');
    });
    const result = b.delete(['k']);
    await expect(result).rejects.toThrow('sync');
    expect(b.state).toBe('open');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('late rejections are swallowed', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const inner = new FakeStore();
      const b = circuitBreaker(inner, { failureThreshold: 10 });
      const slow = hangNextGet(inner);
      const first = expect(b.get('k')).rejects.toThrow(TIMEOUT_MESSAGE);
      await vi.advanceTimersByTimeAsync(500);
      await first;
      slow.reject(new Error('late'));

      const lock = new FakeLock();
      const locking = circuitBreaker(Object.assign(new FakeStore(), { lock }));
      const lateAcquire = deferred<LockHandle | undefined>();
      vi.spyOn(lock, 'acquire').mockImplementationOnce(() => lateAcquire.promise);
      const acquired = expect(locking.lock?.acquire('k', 100)).rejects.toThrow(TIMEOUT_MESSAGE);
      await vi.advanceTimersByTimeAsync(500);
      await acquired;
      lateAcquire.reject(new Error('late acquire'));

      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('only exposes getAndTouch/lock when the inner store has them (Review Focus 5)', () => {
    const plain = circuitBreaker(new FakeStore());
    expect(plain.lock).toBeUndefined();
    expect(plain.getAndTouch).toBeUndefined();
    expect(plain.invalidation).toBeUndefined();
    expect('lock' in plain).toBe(false);
    expect('getAndTouch' in plain).toBe(false);
    expect('invalidation' in plain).toBe(false);

    const rich = circuitBreaker(
      Object.assign(new FakeStore(), { lock: new FakeLock(), getAndTouch: vi.fn() }),
    );
    expect(rich.lock).toBeDefined();
    expect(rich.getAndTouch).toBeDefined();
    expect('lock' in rich).toBe(true);
    expect('getAndTouch' in rich).toBe(true);
  });

  it('guards getAndTouch', async () => {
    const getAndTouch = vi.fn((key: string, ttlMs: number) =>
      Promise.resolve(`${key}:${String(ttlMs)}`),
    );
    const inner: FakeStore & Pick<Required<CacheStore>, 'getAndTouch'> = Object.assign(
      new FakeStore(),
      { getAndTouch },
    );
    const b = circuitBreaker(inner, { failureThreshold: 1 });
    await expect(b.getAndTouch?.('k', 30)).resolves.toBe('k:30');
    expect(getAndTouch).toHaveBeenCalledWith('k', 30);

    getAndTouch.mockImplementationOnce(() => Promise.reject(new Error('touch failed')));
    await expect(b.getAndTouch?.('k', 30)).rejects.toThrow('touch failed');
    expect(b.state).toBe('open');
    await expect(b.getAndTouch?.('k', 30)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(getAndTouch).toHaveBeenCalledTimes(2);
  });

  it('getAndTouch times out like any other operation', async () => {
    const touch = deferred<string | undefined>();
    const inner = Object.assign(new FakeStore(), { getAndTouch: vi.fn(() => touch.promise) });
    const b = circuitBreaker(inner, { failureThreshold: 1 });
    const result = expect(b.getAndTouch?.('k', 1)).rejects.toThrow(TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(b.state).toBe('open');
  });

  it('guards lock.acquire and handle.release', async () => {
    const lock = new FakeLock();
    const inner = Object.assign(new FakeStore(), { lock });
    const b = circuitBreaker(inner, { failureThreshold: 1 });
    expect(b.lock).not.toBe(lock);

    const handle = await b.lock?.acquire('k', 100);
    expect(handle).toBeDefined();
    expect(lock.acquireCalls).toEqual(['k']);
    expect(lock.acquireTtls).toEqual([100]);
    expect(lock.held.has('k')).toBe(true);
    // Held by someone else: undefined passes through and is not a failure.
    await expect(b.lock?.acquire('k', 100)).resolves.toBeUndefined();
    expect(b.state).toBe('closed');

    await handle?.release();
    expect(lock.releaseCalls).toEqual(['k']);
    expect(lock.held.has('k')).toBe(false);

    lock.failNext('acquire');
    await expect(b.lock?.acquire('j', 100)).rejects.toThrow('acquire failed');
    expect(b.state).toBe('open');
    await expect(b.lock?.acquire('k', 100)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(lock.acquireCalls).toEqual(['k', 'k', 'j']);
  });

  it('a failed release counts as a failure; release is rejected while open', async () => {
    const lock = new FakeLock();
    const b = circuitBreaker(Object.assign(new FakeStore(), { lock }), { failureThreshold: 1 });
    const first = await b.lock?.acquire('a', 100);
    const second = await b.lock?.acquire('b', 100);
    lock.failNext('release');
    await expect(first?.release()).rejects.toThrow('release failed');
    expect(b.state).toBe('open');
    await expect(second?.release()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(lock.releaseCalls).toEqual(['a']);
    // The lock stays held until its TTL expires.
    expect(lock.held.has('b')).toBe(true);
  });

  it('forwards invalidation, bind and close unchanged', async () => {
    const bus: InvalidationBus = new FakeBus();
    const inner = Object.assign(new FakeStore(), { invalidation: bus });
    const b = circuitBreaker(inner, { failureThreshold: 1 });
    expect(b.invalidation).toBe(bus);
    expect('invalidation' in b).toBe(true);

    const sink = makeSink();
    b.bind(sink);
    expect(inner.bind).toHaveBeenCalledOnce();
    expect(inner.bind).toHaveBeenCalledWith(sink);

    // close is not guarded: it reaches the store even while the circuit is open.
    await openWithOneFailure(inner, b);
    await expect(b.close()).resolves.toBeUndefined();
    expect(inner.close).toHaveBeenCalledOnce();
  });

  it('works with an inner store that has neither bind nor close', async () => {
    const inner: CacheStore = {
      get: () => Promise.resolve('v'),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
    const b = circuitBreaker(inner);
    expect(() => {
      b.bind(makeSink());
    }).not.toThrow();
    await expect(b.close()).resolves.toBeUndefined();
    await expect(b.get('k')).resolves.toBe('v');
  });

  it('emits nothing before bind', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 1, openDuration: 100 });
    await openWithOneFailure(inner, b);
    vi.setSystemTime(100);
    await expect(b.get('k')).resolves.toBeUndefined();
    expect(b.state).toBe('closed');

    const sink = makeSink();
    b.bind(sink);
    expect(sink.emit).not.toHaveBeenCalled();
    await openWithOneFailure(inner, b);
    expect(breakerStates(sink)).toEqual(['open']);
  });

  it('a throwing sink never reaches the caller', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner, { failureThreshold: 1, openDuration: 100 });
    b.bind({
      emit: () => {
        throw new Error('sink');
      },
    });
    await openWithOneFailure(inner, b);
    vi.setSystemTime(100);
    await expect(b.get('k')).resolves.toBeUndefined();
    expect(b.state).toBe('closed');
  });

  it.each([
    ['failureThreshold', 0],
    ['failureThreshold', 1.5],
    ['failureThreshold', -1],
    ['failureThreshold', Number.NaN],
    ['openDuration', 0],
    ['openDuration', Number.POSITIVE_INFINITY],
    ['timeout', -1],
    ['timeout', 0],
    ['timeout', Number.NaN],
    ['timeout', '500'],
  ] as const)('rejects %s = %s', (f, v) => {
    expect(() => circuitBreaker(new FakeStore(), { [f]: v })).toThrow(CacheConfigError);
  });

  it('names the option and the rule in the config error', () => {
    expect(() => circuitBreaker(new FakeStore(), { failureThreshold: 1.5 })).toThrow(
      'Invalid circuitBreaker option failureThreshold: 1.5 (must be an integer >= 1)',
    );
    expect(() => circuitBreaker(new FakeStore(), { openDuration: 0 })).toThrow(
      'Invalid circuitBreaker option openDuration: 0 (must be a finite number > 0 and <= 2147483647)',
    );
    expect(() => circuitBreaker(new FakeStore(), { timeout: -1 })).toThrow(
      'Invalid circuitBreaker option timeout: -1 (must be a finite number > 0 and <= 2147483647)',
    );
  });

  it('accepts valid explicit options', () => {
    expect(() =>
      circuitBreaker(new FakeStore(), { failureThreshold: 1, openDuration: 0.5, timeout: 1 }),
    ).not.toThrow();
    expect(() => circuitBreaker(new FakeStore(), {})).not.toThrow();
  });

  it('clears its timers', async () => {
    const inner = new FakeStore();
    const b = circuitBreaker(inner);
    await b.get('k');
    expect(vi.getTimerCount()).toBe(0);
    await b.set('k', 'v', 1);
    inner.failNext('get');
    await expect(b.get('k')).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);

    const slow = hangNextGet(inner);
    const pending = b.get('k');
    expect(vi.getTimerCount()).toBe(1);
    slow.resolve('v');
    await expect(pending).resolves.toBe('v');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fake timers drive the lock wait and the breaker timeout in one test (assumption 3)', async () => {
    const lock = new FakeLock();
    lock.held.add('k');
    const inner = Object.assign(new FakeStore(), { lock });
    const b = circuitBreaker(inner, { failureThreshold: 10, timeout: 500 });
    const hooks = { onLock: vi.fn(), onError: vi.fn() };
    const getSpy = vi.spyOn(inner, 'get').mockImplementation(() => new Promise(() => undefined));
    const load = vi.fn(() => Promise.resolve('loaded'));
    const reread = async (): Promise<{ found: false } | { found: true; value: string }> => {
      try {
        const raw = await b.get('k');
        return raw === undefined ? { found: false } : { found: true, value: raw };
      } catch {
        return { found: false };
      }
    };
    const lockProvider = b.lock;
    if (lockProvider === undefined) throw new Error('expected a lock');
    const run = loadWithLock(
      lockProvider,
      'k',
      { ttl: 5_000, waitTimeout: 2_000, retryDelay: 100 },
      reread,
      load,
      hooks,
    );
    // Each round: 100 ms sleep, then a reread that hangs until the 500 ms breaker timeout.
    await vi.advanceTimersByTimeAsync(600);
    expect(getSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(run).resolves.toEqual({ value: 'loaded', from: 'load' });
    expect(hooks.onLock).toHaveBeenCalledWith(false, expect.any(Number) as number);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('circuitBreaker timers (real)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('unrefs the timeout timer', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const inner = new FakeStore();
    const b = circuitBreaker(inner);
    const slow = hangNextGet(inner);
    const pending = b.get('k');
    expect(spy).toHaveBeenCalledOnce();
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    slow.resolve('v');
    await expect(pending).resolves.toBe('v');
  });
});

describe('CircuitOpenError identity', () => {
  it('has the expected name and message', () => {
    const error = new CircuitOpenError();
    expect(error.name).toBe('CircuitOpenError');
    expect(error.message).toBe('Cache store circuit is open');
    expect(error).toBeInstanceOf(Error);
  });

  it('CircuitOpenError is recognised across builds', () => {
    class OtherBuildCircuitOpenError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CircuitOpenError';
      }
    }
    const foreign: unknown = new OtherBuildCircuitOpenError('x');
    expect(foreign instanceof CircuitOpenError).toBe(true);
    if (foreign instanceof CircuitOpenError) {
      expect(foreign.message).toBe('x');
    }
  });

  it('rejects other errors and non-errors', () => {
    expect(new Error('x') instanceof CircuitOpenError).toBe(false);
    expect(new TypeError('x') instanceof CircuitOpenError).toBe(false);
    expect(new CacheConfigError('x') instanceof CircuitOpenError).toBe(false);
    const plain: unknown = { name: 'CircuitOpenError', message: 'x' };
    expect(plain instanceof CircuitOpenError).toBe(false);
    expect((null as unknown) instanceof CircuitOpenError).toBe(false);
    expect(('CircuitOpenError' as unknown) instanceof CircuitOpenError).toBe(false);
  });

  it('keeps normal subclass semantics', () => {
    class SpecialCircuitOpenError extends CircuitOpenError {}
    const base = new CircuitOpenError();
    const sub = new SpecialCircuitOpenError();
    expect(sub instanceof CircuitOpenError).toBe(true);
    expect(sub instanceof SpecialCircuitOpenError).toBe(true);
    expect(base instanceof SpecialCircuitOpenError).toBe(false);
  });
});

describe('late lock handles and duration bounds', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases a handle that resolves after the acquire timeout', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const release = vi.fn(() => Promise.resolve());
      const lock = {
        acquire: () =>
          new Promise<LockHandle>((resolve) => {
            setTimeout(() => {
              resolve({ release });
            }, 600);
          }),
      };
      const inner = Object.assign(new FakeStore(), { lock });
      const sink = makeSink();
      const b = circuitBreaker(inner, { failureThreshold: 5 });
      b.bind(sink);
      const guarded = b.lock!.acquire('k', 1_000);
      const caught = guarded.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(500);
      expect(((await caught) as Error).message).toBe(TIMEOUT_MESSAGE);
      expect(release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(release).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).not.toHaveBeenCalled();
      expect(b.state).toBe('closed');
      expect(sink.emit).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it.each([
    ['rejects at once', 0, 'reject'],
    ['rejects after the timeout', 600, 'reject'],
    // Control: the same wiring with a late handle does release, so the zero counts above mean something.
    ['resolves after the timeout', 600, 'resolve'],
  ] as const)(
    'an inner acquire that %s releases only a handle it was given',
    async (_, delay, outcome) => {
      // setImmediate stays real so the flush below reaches the unhandledRejection check.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const release = vi.fn(() => Promise.resolve());
        // The handle that would carry the release; the rejection path never hands it out.
        const handle: LockHandle = { release };
        const acquire = vi.fn(
          (): Promise<LockHandle | undefined> =>
            new Promise((resolve, reject) => {
              setTimeout(() => {
                if (outcome === 'resolve') resolve(handle);
                else reject(new Error('acquire failed'));
              }, delay);
            }),
        );
        const inner = Object.assign(new FakeStore(), { lock: { acquire } });
        const b = circuitBreaker(inner, { failureThreshold: 5 });
        const caught = b.lock!.acquire('k', 1_000).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(700);
        expect(((await caught) as Error).message).toBe(
          delay === 0 ? 'acquire failed' : TIMEOUT_MESSAGE,
        );
        await vi.advanceTimersByTimeAsync(0);
        await new Promise((resolve) => setImmediate(resolve));
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(outcome === 'resolve' ? 1 : 0);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    },
  );

  it.each(['timeout', 'openDuration'] as const)('rejects %s above the setTimeout limit', (name) => {
    expect(() => circuitBreaker(new FakeStore(), { [name]: 2_147_483_648 })).toThrow(
      `Invalid circuitBreaker option ${name}: 2147483648 (must be a finite number > 0 and <= 2147483647)`,
    );
    expect(() => circuitBreaker(new FakeStore(), { [name]: 2_147_483_647 })).not.toThrow();
  });
});

describe('index exports', () => {
  it('exports circuitBreaker and CircuitOpenError', async () => {
    const index = await import('../../../src/index.js');
    expect(index.circuitBreaker).toBe(circuitBreaker);
    expect(index.CircuitOpenError).toBe(CircuitOpenError);
    expect(index.CircuitBreakerStore).toBe(CircuitBreakerStore);
  });
});

describe('circuitBreaker batch', () => {
  /* The batch members are present only when the inner store has them. */
  it('getMany and setMany exist only when the inner store has them', async () => {
    const plain = circuitBreaker(new FakeStore());
    expect('getMany' in plain).toBe(false);
    expect('setMany' in plain).toBe(false);
    const inner = memoryStore();
    const b = circuitBreaker(inner);
    expect('getMany' in b).toBe(true);
    expect('setMany' in b).toBe(true);
    await b.setMany?.([{ key: 'a', value: '1', ttlMs: 1_000 }]);
    expect(await b.getMany?.(['a', 'z'])).toEqual(['1', undefined]);
  });

  /* An open circuit rejects both batch calls without reaching the store; one batch is one failure. */
  it('an open circuit rejects getMany with CircuitOpenError', async () => {
    const inner = memoryStore();
    const spy = vi.spyOn(inner, 'getMany').mockRejectedValue(new Error('down'));
    const b = circuitBreaker(inner, { failureThreshold: 1 });
    await expect(b.getMany?.(['a', 'b', 'c'])).rejects.toThrow('down');
    expect(b.state).toBe('open');
    await expect(b.getMany?.(['a'])).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(b.setMany?.([])).rejects.toBeInstanceOf(CircuitOpenError);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
