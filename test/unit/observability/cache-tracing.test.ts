import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import { CacheLogger } from '../../../src/module/cache.logger.js';
import { CacheTracing, resolveTracingOptions } from '../../../src/observability/cache-tracing.js';
import type {
  CacheTracingOptions,
  SpanLike,
  SpanOptionsLike,
  TracerLike,
} from '../../../src/observability/tracing.types.js';
import { FakeTracer } from '../helpers/fake-tracer.js';

const BASE = { store: 'default', namespace: 'users' };

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('CacheTracing', () => {
  let tracer: FakeTracer;
  let logger: CacheLogger;
  let storeError: MockInstance<CacheLogger['storeError']>;
  let tracing: CacheTracing;

  beforeEach(() => {
    tracer = new FakeTracer();
    logger = new CacheLogger('error');
    storeError = vi.spyOn(logger, 'storeError').mockImplementation(() => undefined);
    tracing = new CacheTracing(logger);
  });

  afterEach(() => {
    tracer.reset();
    tracer.assertAllEnded();
    vi.restoreAllMocks();
  });

  describe('use and options', () => {
    it('is off until use, then on', () => {
      expect(tracing.enabled).toBe(false);
      tracing.use({ tracer });
      expect(tracing.enabled).toBe(true);
    });

    it('rejects a second registration', () => {
      tracing.use({ tracer });
      expect(() => {
        tracing.use({ tracer });
      }).toThrow(new CacheConfigError('CacheTracingModule is already registered'));
    });

    it.each([
      ['no tracer', {}, 'tracer'],
      ['a tracer without methods', { tracer: {} }, 'tracer'],
      ['a tracer without startSpan', { tracer: { startActiveSpan: () => undefined } }, 'tracer'],
      ['a non-boolean recordKeys', { tracer: new FakeTracer(), recordKeys: 'yes' }, 'recordKeys'],
      ['undefined', undefined, 'tracer'],
    ])('rejects %s', (_label, options, field) => {
      let thrown: unknown;
      try {
        resolveTracingOptions(options);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CacheConfigError);
      expect((thrown as Error).message).toContain(`option ${field}`);
      expect(() => {
        tracing.use(options as CacheTracingOptions);
      }).toThrow(CacheConfigError);
      expect(tracing.enabled).toBe(false);
    });

    it('defaults recordKeys to false', () => {
      expect(resolveTracingOptions({ tracer })).toEqual({ tracer, recordKeys: false });
      expect(resolveTracingOptions({ tracer, recordKeys: true })).toEqual({
        tracer,
        recordKeys: true,
      });
    });
  });

  describe('tracing off', () => {
    it('span, child and root call fn once, return its promise, and never touch a tracer', async () => {
      const fn = vi.fn(() => Promise.resolve(7));
      const promise = Promise.resolve(8);
      expect(tracing.span('cache.get', BASE, () => promise)).toBe(promise);
      expect(tracing.child('cache.load', () => promise)).toBe(promise);
      expect(tracing.root(BASE, () => promise)).toBe(promise);
      await expect(tracing.span('cache.get', BASE, fn)).resolves.toBe(7);
      expect(fn).toHaveBeenCalledOnce();
      tracing.hit(false);
      tracing.miss();
      tracing.result('bypass');
      tracing.set('cache.written', true);
      tracing.key('k');
      tracing.error('get', new Error('x'));
      tracing.lockSpan().end(true);
      expect(tracer.calls).toBe(0);
      expect(storeError).not.toHaveBeenCalled();
    });
  });

  describe('tracing on', () => {
    beforeEach(() => {
      tracing.use({ tracer });
    });

    it('starts the main span with the store and namespace attributes', async () => {
      await expect(tracing.span('cache.get', BASE, () => Promise.resolve(1))).resolves.toBe(1);
      const span = tracer.span('cache.get');
      expect(span.attributes).toEqual({ 'cache.store': 'default', 'cache.namespace': 'users' });
      expect(span.parent).toBeUndefined();
      expect(span.status).toBeUndefined();
      await tracing.span('cache.clear', { store: 'memory' }, () => Promise.resolve());
      expect(tracer.span('cache.clear').attributes).toEqual({ 'cache.store': 'memory' });
    });

    it('nests spans and children under the active span', async () => {
      let user: ReturnType<FakeTracer['startSpan']> | undefined;
      await tracing.span('cache.getOrSet', BASE, async () => {
        await tick();
        await tracing.child('cache.load', async () => {
          await tick();
          user = tracer.startSpan('db.query');
          user.end();
        });
        await tracing.span('cache.get', BASE, async () => {
          await tick();
          tracing.miss();
        });
        tracing.hit(false);
      });
      const main = tracer.span('cache.getOrSet');
      const load = tracer.span('cache.load');
      expect(load.parent).toBe(main);
      expect(load.attributes).toEqual({});
      expect(tracer.span('db.query').parent).toBe(load);
      expect(user).toBe(tracer.span('db.query'));
      expect(tracer.span('cache.get').parent).toBe(main);
      expect(tracer.span('cache.get').attributes['cache.result']).toBe('miss');
      expect(main.attributes['cache.result']).toBe('hit');
    });

    it('a rejection marks the main span ERROR and rethrows', async () => {
      const error = new Error('boom');
      await expect(tracing.span('cache.get', BASE, () => Promise.reject(error))).rejects.toBe(
        error,
      );
      const span = tracer.span('cache.get');
      expect(span.status).toEqual({ code: 2 });
      expect(span.exceptions).toEqual([error]);
    });

    it('a synchronous throw marks the span ERROR, ends it and is rethrown synchronously', () => {
      const error = new Error('sync');
      expect(() =>
        tracing.span('cache.get', BASE, () => {
          throw error;
        }),
      ).toThrow(error);
      expect(tracer.span('cache.get').status).toEqual({ code: 2 });
      expect(tracer.span('cache.get').exceptions).toEqual([error]);
      expect(storeError).not.toHaveBeenCalled();
    });

    it('a child rejection marks the child and the main span ERROR, recording it once', async () => {
      const error = new Error('load failed');
      await expect(
        tracing.span('cache.getOrSet', BASE, () =>
          tracing.child('cache.load', () => Promise.reject(error)),
        ),
      ).rejects.toBe(error);
      for (const name of ['cache.load', 'cache.getOrSet']) {
        expect(tracer.span(name).status).toEqual({ code: 2 });
        expect(tracer.span(name).exceptions).toEqual([error]);
      }
    });

    it('a child whose error the main call swallows still marks both ERROR', async () => {
      const error = new Error('load failed');
      await tracing.span('cache.getOrSet', BASE, async () => {
        await tracing.child('cache.load', () => Promise.reject(error)).catch(() => undefined);
      });
      expect(tracer.span('cache.load').status).toEqual({ code: 2 });
      expect(tracer.span('cache.getOrSet').status).toEqual({ code: 2 });
    });

    it('a child throwing synchronously marks both ERROR and rethrows synchronously', async () => {
      const error = new Error('sync load');
      await tracing.span('cache.getOrSet', BASE, async () => {
        expect(() =>
          tracing.child('cache.load', () => {
            throw error;
          }),
        ).toThrow(error);
      });
      expect(tracer.span('cache.load').status).toEqual({ code: 2 });
      expect(tracer.span('cache.getOrSet').status).toEqual({ code: 2 });
    });

    it('child and recorders outside a scope are untraced', async () => {
      await expect(tracing.child('cache.load', () => Promise.resolve(3))).resolves.toBe(3);
      tracing.hit(true);
      tracing.miss();
      tracing.result('bypass');
      tracing.set('cache.written', false);
      tracing.key('k');
      tracing.error('get', new Error('x'));
      tracing.lockSpan().end(true);
      expect(tracer.spans()).toEqual([]);
      expect(tracer.calls).toBe(0);
    });

    it('single scope: hit, stale, miss and bypass set cache.result, the last one wins', async () => {
      const results: unknown[] = [];
      for (const record of [
        () => {
          tracing.hit(false);
        },
        () => {
          tracing.hit(true);
        },
        () => {
          tracing.miss();
        },
        () => {
          tracing.result('bypass');
        },
        () => {
          tracing.miss();
          tracing.hit(false);
        },
      ]) {
        await tracing.span('cache.get', BASE, async () => {
          record();
        });
        results.push(tracer.spans('cache.get').at(-1)!.attributes['cache.result']);
      }
      expect(results).toEqual(['hit', 'stale', 'miss', 'bypass', 'hit']);
    });

    it('batch scope: counts hits, stale and misses and sets them when the span ends', async () => {
      await tracing.span(
        'cache.getMany',
        BASE,
        async () => {
          tracing.hit(false);
          tracing.hit(true);
          tracing.miss();
          tracing.hit(false);
          await tick();
          expect(tracer.span('cache.getMany').attributes['cache.hits']).toBeUndefined();
        },
        'batch',
      );
      expect(tracer.span('cache.getMany').attributes).toEqual({
        'cache.store': 'default',
        'cache.namespace': 'users',
        'cache.hits': 2,
        'cache.stale': 1,
        'cache.misses': 1,
      });
    });

    it('batch scope without any hit or miss sets no counters', async () => {
      await tracing.span('cache.setMany', BASE, () => Promise.resolve(), 'batch');
      expect(tracer.span('cache.setMany').attributes).toEqual({
        'cache.store': 'default',
        'cache.namespace': 'users',
      });
    });

    it('batch counters are also set when the batch rejects', async () => {
      await expect(
        tracing.span(
          'cache.getOrSetMany',
          BASE,
          async () => {
            tracing.miss();
            throw new Error('x');
          },
          'batch',
        ),
      ).rejects.toThrow('x');
      expect(tracer.span('cache.getOrSetMany').attributes['cache.misses']).toBe(1);
      expect(tracer.span('cache.getOrSetMany').status).toEqual({ code: 2 });
    });

    it('set writes an attribute on the current span', async () => {
      await tracing.span('cache.set', BASE, async () => {
        tracing.set('cache.written', false);
      });
      expect(tracer.span('cache.set').attributes['cache.written']).toBe(false);
    });

    it('root starts cache.refresh as a root span linked to the current span, in its own scope', async () => {
      let refresh: Promise<void> | undefined;
      await tracing.span('cache.getOrSet', BASE, async () => {
        tracing.hit(true);
        refresh = tracing.root(BASE, async () => {
          await tick();
          tracing.miss();
          await tracing.child('cache.load', () => Promise.resolve());
        });
      });
      await refresh;
      const main = tracer.span('cache.getOrSet');
      const root = tracer.span('cache.refresh');
      expect(root.root).toBe(true);
      expect(root.parent).toBeUndefined();
      expect(root.links).toEqual([{ context: main.spanContext() }]);
      expect(root.attributes).toEqual({
        'cache.store': 'default',
        'cache.namespace': 'users',
        'cache.result': 'miss',
      });
      expect(main.attributes['cache.result']).toBe('stale');
      expect(tracer.span('cache.load').parent).toBe(root);
    });

    it('root outside a scope has no links', async () => {
      await tracing.root({ store: 'default' }, () => Promise.resolve());
      expect(tracer.span('cache.refresh').links).toEqual([]);
      expect(tracer.span('cache.refresh').root).toBe(true);
    });

    it('a failed refresh load marks cache.refresh ERROR but not the triggering span', async () => {
      const error = new Error('refresh load failed');
      let refresh: Promise<void> | undefined;
      await tracing.span('cache.getOrSet', BASE, async () => {
        refresh = tracing.root(BASE, async () => {
          await tick();
          await tracing.child('cache.load', () => Promise.reject(error)).catch(() => undefined);
          tracing.error('refresh', error);
        });
      });
      await refresh;
      expect(tracer.span('cache.getOrSet').status).toBeUndefined();
      expect(tracer.span('cache.getOrSet').exceptions).toEqual([]);
      expect(tracer.span('cache.refresh').status).toEqual({ code: 2 });
      expect(tracer.span('cache.load').status).toEqual({ code: 2 });
    });

    it('recorders after the scope ended never touch the ended span', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let late: Promise<void> | undefined;
      await tracing.span('cache.getOrSet', BASE, async () => {
        // Runs in the scope's async context, after the span ended.
        late = gate.then(() => {
          tracing.miss();
          tracing.result('bypass');
          tracing.set('cache.written', true);
          tracing.error('refresh', new Error('late'));
          tracing.lockSpan().end(true);
        });
      });
      const callsAfterEnd = tracer.calls;
      release();
      await late;
      expect(tracer.calls).toBe(callsAfterEnd);
      expect(tracer.span('cache.getOrSet').exceptions).toEqual([]);
      expect(tracer.spans('cache.lock')).toEqual([]);
    });

    it('lockSpan starts cache.lock under the active span and ends it once', async () => {
      await tracing.span('cache.getOrSet', BASE, async () => {
        const acquired = tracing.lockSpan();
        await tick();
        acquired.end(true);
        acquired.end(false);
        tracing.lockSpan().end(false);
        tracing.lockSpan().end(undefined);
      });
      const locks = tracer.spans('cache.lock');
      expect(locks.map((s) => s.parent)).toEqual([
        tracer.span('cache.getOrSet'),
        tracer.span('cache.getOrSet'),
        tracer.span('cache.getOrSet'),
      ]);
      expect(locks.map((s) => s.attributes['cache.lock.acquired'])).toEqual([
        true,
        false,
        undefined,
      ]);
      expect(locks[2]!.attributes).toEqual({});
    });

    it('error records the exception and a cache.error event, leaving the status unset', async () => {
      const error = new Error('read failed');
      await tracing.span('cache.get', BASE, async () => {
        tracing.error('get', error);
      });
      const span = tracer.span('cache.get');
      expect(span.exceptions).toEqual([error]);
      expect(span.events).toEqual([
        { name: 'cache.error', attributes: { 'cache.error.operation': 'get' } },
      ]);
      expect(span.status).toBeUndefined();
    });

    it('key is not recorded without recordKeys', async () => {
      await tracing.span('cache.get', BASE, async () => {
        tracing.key('app:users:k');
      });
      expect(tracer.span('cache.get').attributes['cache.key']).toBeUndefined();
    });

    it('a traced call adds no tick: the caller gets the promise fn returned', async () => {
      const resolved = Promise.resolve(1);
      expect(tracing.span('cache.get', BASE, () => resolved)).toBe(resolved);
      const rejected = Promise.reject(new Error('r'));
      expect(tracing.span('cache.get', BASE, () => rejected)).toBe(rejected);
      await expect(rejected).rejects.toThrow('r');
      const loaded = Promise.resolve(2);
      let fromChild: Promise<number> | undefined;
      let fromRoot: Promise<number> | undefined;
      await tracing.span('cache.getOrSet', BASE, async () => {
        fromChild = tracing.child('cache.load', () => loaded);
        fromRoot = tracing.root(BASE, () => loaded);
      });
      expect(fromChild).toBe(loaded);
      expect(fromRoot).toBe(loaded);
      await loaded;
    });

    it('a traced call settles in the same tick as an untraced one', async () => {
      const off = new CacheTracing();
      const order: string[] = [];
      const run = async (): Promise<void> => {
        await Promise.resolve();
      };
      const done = Promise.all([
        off.span('cache.get', BASE, run).then(() => order.push('off')),
        tracing.span('cache.get', BASE, run).then(() => order.push('on')),
        run().then(() => order.push('plain')),
      ]);
      await done;
      expect(order).toEqual(['off', 'on', 'plain']);
    });

    it('the span has ended (and the error is recorded) before the caller resumes', async () => {
      await tracing.span('cache.get', BASE, async () => {
        tracing.hit(false);
      });
      expect(tracer.span('cache.get').endCount).toBe(1);
      const error = new Error('x');
      try {
        await tracing.span('cache.set', BASE, () => Promise.reject(error));
      } catch {
        expect(tracer.span('cache.set').endCount).toBe(1);
        expect(tracer.span('cache.set').status).toEqual({ code: 2 });
      }
      await tracing.span('cache.getOrSet', BASE, async () => {
        await tracing
          .child('cache.load', () => Promise.reject(error))
          .catch(() => {
            expect(tracer.span('cache.load').endCount).toBe(1);
            expect(tracer.span('cache.getOrSet').status).toEqual({ code: 2 });
          });
      });
    });

    it('child after the scope ended is untraced', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let late: Promise<never> | undefined;
      await tracing.span('cache.getOrSet', BASE, async () => {
        // Runs in the scope's async context, after the span ended.
        late = gate.then(() =>
          tracing.child('cache.load', () => Promise.reject(new Error('late'))),
        );
      });
      const calls = tracer.calls;
      release();
      await expect(late).rejects.toThrow('late');
      expect(tracer.spans('cache.load')).toEqual([]);
      expect(tracer.calls).toBe(calls);
      expect(tracer.span('cache.getOrSet').status).toBeUndefined();
    });

    it('two concurrent spans keep separate scopes', async () => {
      const first = tracing.span('cache.getOrSet', BASE, async () => {
        await tick();
        tracing.hit(false);
        await tick();
        tracing.error('get', new Error('first'));
      });
      const second = tracing.span('cache.getOrSet', { store: 'other' }, async () => {
        tracing.miss();
        await tick();
        await tick();
        tracing.set('cache.written', true);
      });
      await Promise.all([first, second]);
      const [a, b] = tracer.spans('cache.getOrSet');
      expect(a!.attributes).toEqual({
        'cache.store': 'default',
        'cache.namespace': 'users',
        'cache.result': 'hit',
      });
      expect(a!.exceptions).toHaveLength(1);
      expect(b!.attributes).toEqual({
        'cache.store': 'other',
        'cache.result': 'miss',
        'cache.written': true,
      });
      expect(b!.exceptions).toEqual([]);
    });
  });

  describe('recordKeys', () => {
    it('key records the full key, or a copy of the key list', async () => {
      tracing.use({ tracer, recordKeys: true });
      const keys = ['app:a', 'app:b'];
      await tracing.span('cache.get', BASE, async () => {
        tracing.key('app:users:k');
      });
      await tracing.span(
        'cache.getMany',
        BASE,
        async () => {
          tracing.key(keys);
        },
        'batch',
      );
      keys.push('app:c');
      expect(tracer.span('cache.get').attributes['cache.key']).toBe('app:users:k');
      expect(tracer.span('cache.getMany').attributes['cache.key']).toEqual(['app:a', 'app:b']);
    });
  });

  describe('a throwing tracer', () => {
    beforeEach(() => {
      tracing.use({ tracer });
    });

    it('startActiveSpan throwing before fn: fn runs once untraced and the error is logged', async () => {
      tracer.failOn('startActiveSpan', 'before');
      const fn = vi.fn(async () => {
        tracing.hit(false);
        return 5;
      });
      await expect(tracing.span('cache.get', BASE, fn)).resolves.toBe(5);
      expect(fn).toHaveBeenCalledOnce();
      expect(storeError).toHaveBeenCalledExactlyOnceWith('default', 'tracing', expect.any(Error));
      expect(tracer.spans()).toEqual([]);
    });

    it('startActiveSpan throwing after fn: fn is not called again and the span still ends', async () => {
      tracer.failOn('startActiveSpan', 'after');
      const fn = vi.fn(() => Promise.resolve(6));
      await expect(tracing.span('cache.get', BASE, fn)).resolves.toBe(6);
      expect(fn).toHaveBeenCalledOnce();
      expect(storeError).toHaveBeenCalledWith('default', 'tracing', expect.any(Error));
      expect(tracer.span('cache.get').endCount).toBe(1);
    });

    it('startActiveSpan throwing after fn keeps a user rejection', async () => {
      tracer.failOn('startActiveSpan', 'after');
      const error = new Error('user');
      await expect(tracing.span('cache.get', BASE, () => Promise.reject(error))).rejects.toBe(
        error,
      );
    });

    it('a child whose startActiveSpan throws runs the loader once untraced', async () => {
      const load = vi.fn(() => Promise.resolve('v'));
      await tracing.span('cache.getOrSet', BASE, async () => {
        tracer.failOn('startActiveSpan', 'before');
        await expect(tracing.child('cache.load', load)).resolves.toBe('v');
      });
      expect(load).toHaveBeenCalledOnce();
      expect(storeError).toHaveBeenCalledExactlyOnceWith('default', 'tracing', expect.any(Error));
    });

    it('root whose startActiveSpan throws runs the refresh once untraced', async () => {
      tracer.failOn('startActiveSpan', 'before');
      const refresh = vi.fn(() => Promise.resolve());
      await tracing.root(BASE, refresh);
      expect(refresh).toHaveBeenCalledOnce();
      expect(storeError).toHaveBeenCalledExactlyOnceWith('default', 'tracing', expect.any(Error));
    });

    it('end throwing after fn ran: fn is not called again and the result is returned', async () => {
      tracer.failOn('end', 'after');
      const fn = vi.fn(() => Promise.resolve(9));
      await expect(tracing.span('cache.get', BASE, fn)).resolves.toBe(9);
      expect(fn).toHaveBeenCalledOnce();
      expect(storeError).toHaveBeenCalledExactlyOnceWith('default', 'tracing', expect.any(Error));
    });

    it('end throwing on a rejection keeps the user error', async () => {
      tracer.failOn('end', 'after');
      const error = new Error('user');
      await expect(tracing.span('cache.get', BASE, () => Promise.reject(error))).rejects.toBe(
        error,
      );
    });

    it('throwing span methods never reach the caller', async () => {
      for (const method of [
        'setAttribute',
        'addEvent',
        'recordException',
        'setStatus',
        'spanContext',
      ] as const) {
        tracer.failOn(method, 'after');
      }
      tracer.failOn('startSpan', 'before');
      const error = new Error('load');
      let refresh: Promise<void> | undefined;
      await expect(
        tracing.span(
          'cache.getOrSet',
          BASE,
          async () => {
            tracing.hit(false);
            tracing.miss();
            tracing.result('bypass');
            tracing.set('cache.written', true);
            tracing.error('get', new Error('x'));
            tracing.lockSpan().end(true);
            refresh = tracing.root(BASE, () => Promise.resolve());
            await tracing.child('cache.load', () => Promise.reject(error));
          },
          'batch',
        ),
      ).rejects.toBe(error);
      await refresh;
      expect(storeError).toHaveBeenCalled();
      for (const call of storeError.mock.calls) expect(call[1]).toBe('tracing');
      expect(tracer.span('cache.refresh').links).toEqual([]);
    });

    it('a refresh whose tracer fails runs outside the triggering scope', async () => {
      let refresh: Promise<void> | undefined;
      await tracing.span('cache.getOrSet', BASE, async () => {
        tracer.failOn('startActiveSpan', 'before');
        refresh = tracing.root(BASE, async () => {
          tracing.miss();
          tracing.error('refresh', new Error('swallowed'));
          await tracing.child('cache.load', () => Promise.reject(new Error('load')));
        });
        await refresh.catch(() => undefined);
        tracer.reset();
      });
      const main = tracer.span('cache.getOrSet');
      expect(main.exceptions).toEqual([]);
      expect(main.events).toEqual([]);
      expect(main.status).toBeUndefined();
      expect(main.attributes['cache.result']).toBeUndefined();
      expect(tracer.spans('cache.load')).toEqual([]);
    });

    it('a tracer that calls its callback late never runs fn twice and ends the late span', async () => {
      const inner = new FakeTracer();
      let late: Promise<unknown> | undefined;
      const deferring: TracerLike = {
        startActiveSpan<F extends (span: SpanLike) => unknown>(
          name: string,
          options: SpanOptionsLike,
          fn: F,
        ): ReturnType<F> {
          late = Promise.resolve().then(() => inner.startActiveSpan(name, options, fn));
          return undefined as ReturnType<F>;
        },
        startSpan: (name, options) => inner.startSpan(name, options),
      };
      const deferred = new CacheTracing(logger);
      deferred.use({ tracer: deferring });
      const fn = vi.fn(() => Promise.resolve(4));
      await expect(deferred.span('cache.get', BASE, fn)).resolves.toBe(4);
      await late;
      expect(fn).toHaveBeenCalledOnce();
      expect(inner.span('cache.get').endCount).toBe(1);
      expect(inner.span('cache.get').attributes['cache.result']).toBeUndefined();
      inner.assertAllEnded();
    });

    it('a tracer that calls its callback twice runs fn once and ends both spans', async () => {
      const inner = new FakeTracer();
      const twice: TracerLike = {
        startActiveSpan<F extends (span: SpanLike) => unknown>(
          name: string,
          options: SpanOptionsLike,
          fn: F,
        ): ReturnType<F> {
          inner.startActiveSpan(name, options, fn);
          return inner.startActiveSpan(name, options, fn);
        },
        startSpan: (name, options) => inner.startSpan(name, options),
      };
      const doubled = new CacheTracing(logger);
      doubled.use({ tracer: twice });
      const fn = vi.fn(() => Promise.resolve(5));
      await expect(doubled.span('cache.get', BASE, fn)).resolves.toBe(5);
      expect(fn).toHaveBeenCalledOnce();
      expect(inner.spans('cache.get').map((s) => s.endCount)).toEqual([1, 1]);
      inner.assertAllEnded();
    });

    it('without a logger, tracer errors are swallowed silently', async () => {
      const silent = new CacheTracing();
      silent.use({ tracer });
      tracer.failOn('startActiveSpan', 'before');
      await expect(silent.span('cache.get', BASE, () => Promise.resolve(1))).resolves.toBe(1);
    });
  });
});
