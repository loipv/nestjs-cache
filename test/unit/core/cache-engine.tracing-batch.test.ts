import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheModuleOptions } from '../../../src/module/cache.options.js';
import { makeEngine } from '../helpers/engine.js';
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

function children(tracer: FakeTracer, parent: FakeSpan): string[] {
  return tracer
    .spans()
    .filter((span) => span.parent === parent)
    .map((span) => span.name);
}

function mapOf(keys: readonly string[]): Map<string, string> {
  return new Map(keys.map((key) => [key, `new${key}`]));
}

describe('CacheEngine tracing: batch calls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const tracer of tracers) tracer.assertAllEnded();
    tracers = [];
  });

  it('each batch call has its span with cache.store, cache.namespace and cache.keys', async () => {
    const { engine, tracer } = traced();
    await engine.getMany({ namespace: 'ns' }, ['a', 'b', 'a', '']);
    await engine.setMany({ namespace: 'ns' }, [
      ['a', 1],
      ['b', 2],
      ['a', 3],
    ]);
    await engine.getOrSetMany({ namespace: 'ns' }, ['a', 'c', 'c'], async (missing) =>
      mapOf(missing),
    );
    const roots = tracer.spans().filter((span) => span.parent === undefined);
    expect(roots.map((span) => span.name)).toEqual([
      'cache.getMany',
      'cache.setMany',
      'cache.getOrSetMany',
    ]);
    for (const span of roots) {
      expect(span.attributes).toMatchObject({ 'cache.store': 'default', 'cache.namespace': 'ns' });
    }
    // The input length, duplicates (and empty keys) included.
    expect(roots.map((span) => span.attributes['cache.keys'])).toEqual([4, 3, 3]);
    expect(tracer.span('cache.setMany').attributes).not.toHaveProperty('cache.hits');
  });

  it('getMany counts hits, stale hits and misses', async () => {
    const { engine, tracer } = traced();
    await engine.set({ key: 'a' }, 'A', { ttl: 1_000 });
    await engine.set({ key: 'b' }, 'B', { ttl: 1_000 });
    await engine.set({ key: 's' }, 'S', SWR);
    vi.setSystemTime(150);
    expect(await engine.getMany({}, ['a', 's', 'b', 'm'], SWR)).toEqual(['A', 'S', 'B', undefined]);
    const span = tracer.span('cache.getMany');
    expect(span.attributes).toMatchObject({ 'cache.hits': 2, 'cache.stale': 1, 'cache.misses': 1 });
    expect(span.attributes).not.toHaveProperty('cache.result');
  });

  it('a batch call inside a traced single-key call counts into its own span', async () => {
    const { engine, tracer } = traced();
    await engine.set({ key: 'a' }, 'A');
    await engine.getOrSet({ key: 'outer' }, async () => {
      await engine.getMany({}, ['a', 'm']);
      return 'v';
    });
    const outer = tracer.span('cache.getOrSet');
    const batch = tracer.span('cache.getMany');
    expect(batch.parent).toBe(tracer.span('cache.load'));
    expect(batch.attributes).toMatchObject({
      'cache.hits': 1,
      'cache.stale': 0,
      'cache.misses': 1,
    });
    expect(outer.attributes['cache.result']).toBe('miss');
    expect(outer.attributes).not.toHaveProperty('cache.hits');
  });

  it('getOrSetMany misses give one cache.load under cache.getOrSetMany', async () => {
    const { engine, tracer } = traced();
    await engine.set({ key: 'a' }, 'A');
    const loader = vi.fn(async (missing: string[]) => mapOf(missing));
    expect(await engine.getOrSetMany({}, ['a', 'b', 'c', 'b'], loader)).toEqual([
      'A',
      'newb',
      'newc',
      'newb',
    ]);
    expect(loader).toHaveBeenCalledOnce();
    const main = tracer.span('cache.getOrSetMany');
    expect(children(tracer, main)).toEqual(['cache.load']);
    expect(main.attributes).toMatchObject({
      'cache.keys': 4,
      'cache.hits': 1,
      'cache.stale': 0,
      'cache.misses': 2,
    });
    expect(tracer.span('cache.load').status).toBeUndefined();
  });

  it('getMany and getOrSetMany over no keys carry zero counters; setMany carries none', async () => {
    const { engine, tracer } = traced();
    expect(await engine.getMany({}, [])).toEqual([]);
    expect(await engine.getMany({}, ['', ''])).toEqual([undefined, undefined]);
    const loader = vi.fn(async (missing: string[]) => mapOf(missing));
    expect(await engine.getOrSetMany({}, [], loader)).toEqual([]);
    expect(await engine.getOrSetMany({}, [''], loader)).toEqual([undefined]);
    await engine.setMany({}, []);
    expect(loader).not.toHaveBeenCalled();
    const zero = { 'cache.hits': 0, 'cache.stale': 0, 'cache.misses': 0 };
    for (const span of [...tracer.spans('cache.getMany'), ...tracer.spans('cache.getOrSetMany')]) {
      expect(span.attributes).toMatchObject(zero);
    }
    const write = tracer.span('cache.setMany');
    for (const counter of Object.keys(zero)) expect(write.attributes).not.toHaveProperty(counter);
  });

  it('a getOrSetMany whose misses all join another call has no cache.load of its own', async () => {
    const { engine, tracer } = traced();
    const loader = vi.fn(
      (missing: string[]) =>
        new Promise<Map<string, string>>((resolve) => {
          setTimeout(() => {
            resolve(mapOf(missing));
          }, 10);
        }),
    );
    const both = Promise.all([
      engine.getOrSetMany({}, ['a', 'b'], loader),
      engine.getOrSetMany({}, ['b', 'a'], loader),
    ]);
    await vi.runAllTimersAsync();
    expect(await both).toEqual([
      ['newa', 'newb'],
      ['newb', 'newa'],
    ]);
    expect(loader).toHaveBeenCalledOnce();
    const [owner, joiner] = tracer.spans('cache.getOrSetMany');
    expect(tracer.span('cache.load').parent).toBe(owner);
    expect(children(tracer, owner!)).toEqual(['cache.load']);
    expect(children(tracer, joiner!)).toEqual([]);
    expect(joiner!.attributes).toMatchObject({
      'cache.hits': 0,
      'cache.stale': 0,
      'cache.misses': 2,
    });
  });

  it('a span started by the batch loader is under cache.load', async () => {
    const { engine, tracer } = traced();
    await engine.getOrSetMany({}, ['a'], async (missing) =>
      tracer.startActiveSpan('db.query', {}, (span) => {
        span.end();
        return mapOf(missing);
      }),
    );
    expect(tracer.span('db.query').parent).toBe(tracer.span('cache.load'));
  });

  it('stale keys give one cache.refresh root linked to cache.getOrSetMany, with its own load', async () => {
    const { engine, tracer } = traced();
    await engine.set({ namespace: 'ns', key: 'a' }, 'oldA', SWR);
    await engine.set({ namespace: 'ns', key: 'b' }, 'oldB', SWR);
    vi.setSystemTime(150);
    const loader = vi.fn(async (missing: string[]) => mapOf(missing));
    expect(await engine.getOrSetMany({ namespace: 'ns' }, ['a', 'c', 'b'], loader, SWR)).toEqual([
      'oldA',
      'newc',
      'oldB',
    ]);
    await vi.runAllTimersAsync();
    expect(loader).toHaveBeenCalledTimes(2);
    const main = tracer.span('cache.getOrSetMany');
    const refresh = tracer.span('cache.refresh');
    expect(refresh.root).toBe(true);
    expect(refresh.parent).toBeUndefined();
    expect(refresh.links).toEqual([
      { context: { traceId: main.traceId, spanId: main.spanId, traceFlags: 1 } },
    ]);
    expect(refresh.attributes).toEqual({ 'cache.store': 'default', 'cache.namespace': 'ns' });
    expect(children(tracer, main)).toEqual(['cache.load']);
    expect(children(tracer, refresh)).toEqual(['cache.load']);
    expect(main.attributes).toMatchObject({ 'cache.hits': 0, 'cache.stale': 2, 'cache.misses': 1 });
  });

  it('a stale key already refreshing starts no new cache.refresh', async () => {
    const { engine, tracer } = traced();
    await engine.set({ key: 'a' }, 'oldA', SWR);
    vi.setSystemTime(150);
    const loader = vi.fn(
      (missing: string[]) =>
        new Promise<Map<string, string>>((resolve) => {
          setTimeout(() => {
            resolve(mapOf(missing));
          }, 50);
        }),
    );
    expect(await engine.getOrSetMany({}, ['a'], loader, SWR)).toEqual(['oldA']);
    expect(await engine.getOrSetMany({}, ['a'], loader, SWR)).toEqual(['oldA']);
    await vi.runAllTimersAsync();
    expect(loader).toHaveBeenCalledOnce();
    expect(tracer.spans('cache.getOrSetMany')).toHaveLength(2);
    expect(tracer.spans('cache.refresh')).toHaveLength(1);
  });

  it('a refresh outliving its softTimeout window ends after cache.getOrSetMany, apart from it', async () => {
    const { engine, tracer } = traced();
    await engine.set({ key: 'a' }, 'oldA', SWR);
    vi.setSystemTime(150);
    const failure = new Error('late refresh failure');
    const loader = () =>
      new Promise<Map<string, string>>((_, reject) => {
        setTimeout(() => {
          reject(failure);
        }, 50);
      });
    const result = engine.getOrSetMany({}, ['a'], loader, { ...SWR, softTimeout: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toEqual(['oldA']);
    const main = tracer.span('cache.getOrSetMany');
    const refresh = tracer.span('cache.refresh');
    expect(main.endCount).toBe(1);
    expect(refresh.endCount).toBe(0);
    await vi.runAllTimersAsync();
    expect(refresh.endCount).toBe(1);
    expect(refresh.status).toEqual(ERROR);
    expect(main.exceptions).toEqual([]);
    expect(main.status).toBeUndefined();
    expect(main.writesAfterEnd).toEqual([]);
  });

  it('a failed batch refresh is recorded on cache.refresh only', async () => {
    const { engine, tracer } = traced();
    await engine.set({ key: 'a' }, 'oldA', SWR);
    vi.setSystemTime(150);
    const failure = new Error('refresh failed');
    expect(await engine.getOrSetMany({}, ['a'], () => Promise.reject(failure), SWR)).toEqual([
      'oldA',
    ]);
    await vi.runAllTimersAsync();
    const main = tracer.span('cache.getOrSetMany');
    const refresh = tracer.span('cache.refresh');
    // Recorded once, though it is both the failed child's error and a swallowed refresh error.
    expect(refresh.exceptions).toEqual([failure]);
    expect(refresh.events.map((event) => event.name)).toEqual(['cache.error']);
    expect(refresh.status).toEqual(ERROR);
    expect(tracer.span('cache.load').status).toEqual(ERROR);
    expect(tracer.span('cache.load').exceptions).toEqual([failure]);
    expect(tracer.span('cache.load').parent).toBe(refresh);
    expect(main.exceptions).toEqual([]);
    expect(main.status).toBeUndefined();
  });

  it('a loader that omits a key ends every span once', async () => {
    const { engine, tracer } = traced();
    await engine.set({ key: 's' }, 'oldS', SWR);
    vi.setSystemTime(150);
    // Omits every key it is asked for except 'a'.
    const loader = async (missing: string[]) =>
      new Map(missing.filter((key) => key === 'a').map((key) => [key, 'A']));
    expect(await engine.getOrSetMany({}, ['a', 'b', 's'], loader, SWR)).toEqual([
      'A',
      undefined,
      'oldS',
    ]);
    await vi.runAllTimersAsync();
    expect(tracer.spans().map((span) => span.name)).toEqual([
      'cache.set',
      'cache.getOrSetMany',
      'cache.load',
      'cache.refresh',
      'cache.load',
    ]);
    for (const span of tracer.spans()) expect(span.endCount).toBe(1);
  });

  it('a loader resolving a non-Map: cache.load and the main span have ERROR', async () => {
    const { engine, tracer } = traced();
    const loader = async () => ({ a: 1 }) as unknown as ReadonlyMap<string, number>;
    const rejection = engine.getOrSetMany({}, ['a'], loader);
    await expect(rejection).rejects.toThrow(TypeError);
    const error = await rejection.catch((e: unknown) => e);
    const main = tracer.span('cache.getOrSetMany');
    const load = tracer.span('cache.load');
    expect(load.parent).toBe(main);
    expect(load.status).toEqual(ERROR);
    expect(load.exceptions).toEqual([error]);
    expect(main.status).toEqual(ERROR);
    expect(main.exceptions).toEqual([error]);
  });

  it('a synchronous batch loader throw: cache.load and the main span have ERROR', async () => {
    const { engine, tracer } = traced();
    const boom = new Error('sync');
    await expect(
      engine.getOrSetMany({}, ['a'], () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(tracer.span('cache.load').status).toEqual(ERROR);
    expect(tracer.span('cache.getOrSetMany').status).toEqual(ERROR);
    expect(tracer.span('cache.getOrSetMany').exceptions).toEqual([boom]);
  });

  it('a version failure loads every key under cache.load and sets no cache.key', async () => {
    const { engine, tracer, store } = traced({ namespaces: { ns: { versioned: true } } }, true);
    store.failNext('get');
    expect(
      await engine.getOrSetMany({ namespace: 'ns' }, ['a', 'b'], async (missing) => mapOf(missing)),
    ).toEqual(['newa', 'newb']);
    const main = tracer.span('cache.getOrSetMany');
    expect(children(tracer, main)).toEqual(['cache.load']);
    expect(main.attributes).not.toHaveProperty('cache.key');
  });

  it('recordKeys false sets no cache.key on batch spans', async () => {
    const { engine, tracer } = traced({ prefix: 'app' });
    await engine.getMany({ namespace: 'ns' }, ['a']);
    await engine.setMany({ namespace: 'ns' }, [['a', 1]]);
    await engine.getOrSetMany({ namespace: 'ns' }, ['b'], async (missing) => mapOf(missing));
    for (const span of tracer.spans()) expect(span.attributes).not.toHaveProperty('cache.key');
  });

  it('recordKeys true sets cache.key to the full keys, deduped, without empty keys', async () => {
    const { engine, tracer } = traced({ prefix: 'app' }, true);
    await engine.getMany({ namespace: 'ns' }, ['a', 'b', 'a', '']);
    await engine.setMany({ namespace: 'ns' }, [
      ['a', 1],
      ['c', 2],
    ]);
    await engine.getOrSetMany({ namespace: 'ns' }, ['b', 'd'], async (missing) => mapOf(missing));
    const key = (name: string) => tracer.span(name).attributes['cache.key'];
    expect(key('cache.getMany')).toEqual(['app:ns:a', 'app:ns:b']);
    expect(key('cache.setMany')).toEqual(['app:ns:a', 'app:ns:c']);
    expect(key('cache.getOrSetMany')).toEqual(['app:ns:b', 'app:ns:d']);
    expect(tracer.span('cache.load').attributes).not.toHaveProperty('cache.key');
  });

  it('a CacheConfigError from validation ends the batch span with ERROR', async () => {
    const { engine, tracer } = traced();
    await expect(engine.getMany({}, 'a' as unknown as string[])).rejects.toThrow('Invalid keys');
    await expect(engine.setMany({}, null as unknown as [string, number][])).rejects.toThrow(
      'Invalid entries',
    );
    await expect(
      engine.getOrSetMany({}, ['a'], async () => new Map(), { lock: true }),
    ).rejects.toThrow('Invalid lock');
    for (const name of ['cache.getMany', 'cache.setMany', 'cache.getOrSetMany']) {
      expect(tracer.span(name).status).toEqual(ERROR);
      expect(tracer.span(name).attributes).not.toHaveProperty('cache.keys');
    }
  });
});
