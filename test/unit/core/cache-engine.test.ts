import { brotliCompressSync, gzipSync } from 'node:zlib';
import { compressedSerializer } from '../../../src/serializers/compressed.serializer.js';
import { jsonSerializer, type Serializer } from '../../../src/serializers/json.serializer.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEngine } from '../helpers/engine.js';
import { FakeStore } from '../helpers/fake-store.js';

describe('CacheEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('round-trips a value under the plain key', async () => {
    const { engine, store } = makeEngine();
    await engine.set({ key: 'a' }, { n: 1 });
    expect([...store.data.keys()]).toEqual(['a']);
    expect(await engine.get({ key: 'a' })).toEqual({ n: 1 });
  });

  it('composes prefix, namespace and key', async () => {
    const { engine, store } = makeEngine({ prefix: 'app' });
    await engine.set({ namespace: 'users', key: 'u:1' }, 1);
    expect([...store.data.keys()]).toEqual(['app:users:u:1']);
  });

  it('uses the default TTL, or the given one, for store and envelope', async () => {
    const { engine, store, emitted } = makeEngine();
    await engine.set({ key: 'a' }, 1);
    await engine.set({ key: 'b' }, 1, { ttl: 5_000 });
    expect(store.data.get('a')?.ttlMs).toBe(60_000);
    expect(store.data.get('b')?.ttlMs).toBe(5_000);
    expect(JSON.parse(store.data.get('b')!.value)).toMatchObject({
      storedAt: 1_000_000,
      expiresAt: 1_005_000,
    });
    expect(emitted.at(-1)).toEqual({
      event: 'set',
      payload: { store: 'default', namespace: undefined, key: 'b', ttl: 5_000 },
    });
  });

  it.each([0, '', false, [], null])('treats stored %j as a hit (Review Focus 1)', async (value) => {
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'k' }, value);
    expect(await engine.get({ key: 'k' })).toEqual(value);
    expect(emitted.at(-1)).toEqual({
      event: 'hit',
      payload: { store: 'default', namespace: undefined, key: 'k', stale: false },
    });
  });

  it('a stored undefined is a hit that returns undefined', async () => {
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'k' }, undefined);
    expect(await engine.get({ key: 'k' })).toBeUndefined();
    expect(emitted.at(-1)?.event).toBe('hit');
  });

  it('a missing key is a miss', async () => {
    const { engine, emitted } = makeEngine();
    expect(await engine.get({ key: 'x' })).toBeUndefined();
    expect(emitted.at(-1)).toEqual({
      event: 'miss',
      payload: { store: 'default', namespace: undefined, key: 'x' },
    });
  });

  it('an envelope past expiresAt is a miss even if the store still holds it', async () => {
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'a' }, 1, { ttl: 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(await engine.get({ key: 'a' })).toBeUndefined();
    expect(emitted.at(-1)?.event).toBe('miss');
  });

  it('a failing read is a miss plus an error event', async () => {
    const { engine, store, emitted } = makeEngine();
    const boom = new Error('down');
    store.failNext('get', boom);
    await expect(engine.get({ key: 'a' })).resolves.toBeUndefined();
    expect(emitted).toContainEqual({
      event: 'error',
      payload: { store: 'default', operation: 'get', error: boom },
    });
    expect(emitted.at(-1)?.event).toBe('miss');
  });

  it('a failing write resolves and reports', async () => {
    const { engine, store, emitted } = makeEngine();
    const boom = new Error('down');
    store.failNext('set', boom);
    await expect(engine.set({ key: 'a' }, 1)).resolves.toBeUndefined();
    expect(emitted).toEqual([
      { event: 'error', payload: { store: 'default', operation: 'set', error: boom } },
    ]);
  });

  const isDeserializeError = (e: { event: string; payload: unknown }): boolean =>
    e.event === 'error' && (e.payload as { operation: string }).operation === 'deserialize';

  it.each(['{"v":1,"value":1}', '{"v":"x"}', '{"v":"2","value":1,"storedAt":0}'])(
    'an unreadable envelope %s is a miss, is deleted and reported',
    async (raw) => {
      /* the entry is an object with an own `v`: something this library wrote, now unreadable */
      const { engine, store, emitted } = makeEngine();
      store.data.set('a', { value: raw, ttlMs: 1 });
      expect(await engine.get({ key: 'a' })).toBeUndefined();
      expect(store.data.has('a')).toBe(false);
      expect(store.calls.filter((c) => c.op === 'delete')).toEqual([
        { op: 'delete', args: [['a']] },
      ]);
      expect(emitted.some(isDeserializeError)).toBe(true);
      expect(emitted.at(-1)?.event).toBe('miss');
    },
  );

  it.each([
    'not json',
    '3b241101-e2bb-4255-8caf-4136c566a962',
    '{"foo":1}',
    '42',
    'null',
    '"v"',
    '[{"v":1}]',
    '{"value":1,"storedAt":0}',
  ])('a foreign value %s is a miss and reported, but left in the store', async (raw) => {
    /* keys can be user-controlled: a value this library did not write must never be deleted */
    const { engine, store, emitted } = makeEngine();
    store.data.set('a', { value: raw, ttlMs: 1 });
    expect(await engine.get({ key: 'a' })).toBeUndefined();
    expect(store.data.get('a')?.value).toBe(raw);
    expect(store.calls.filter((c) => c.op === 'delete')).toEqual([]);
    expect(emitted.some(isDeserializeError)).toBe(true);
    expect(emitted.at(-1)?.event).toBe('miss');
  });

  it('an object with an inherited v is not treated as an envelope', async () => {
    /* a custom serializer hands back an object whose `v` comes from its prototype */
    const { engine, store, emitted } = makeEngine({
      serializer: {
        serialize: (e) => JSON.stringify(e),
        deserialize: () => Object.create({ v: 1 }) as never,
      },
    });
    store.data.set('a', { value: '{}', ttlMs: 1 });
    expect(await engine.get({ key: 'a' })).toBeUndefined();
    expect(store.data.has('a')).toBe(true);
    expect(emitted.some(isDeserializeError)).toBe(true);
  });

  it('a deserializer returning a revoked Proxy is a miss, never a rejection', async () => {
    /* every inspection of a revoked Proxy throws, Array.isArray included */
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const { engine, store, emitted } = makeEngine({
      serializer: { serialize: (e) => JSON.stringify(e), deserialize: () => proxy as never },
    });
    store.data.set('a', { value: '{}', ttlMs: 1 });
    await expect(engine.get({ key: 'a' })).resolves.toBeUndefined();
    expect(store.data.has('a')).toBe(true);
    expect(emitted.some(isDeserializeError)).toBe(true);
    expect(emitted.at(-1)?.event).toBe('miss');
  });

  it('swallows a failing cleanup delete after a deserialize failure', async () => {
    const { engine, store, emitted } = makeEngine();
    store.data.set('a', { value: '{"v":1,"value":1}', ttlMs: 1 });
    store.failNext('delete');
    await expect(engine.get({ key: 'a' })).resolves.toBeUndefined();
    expect(emitted.filter((e) => e.event === 'error')).toHaveLength(1);
    expect(store.calls.filter((c) => c.op === 'delete')).toEqual([{ op: 'delete', args: [['a']] }]);
  });

  it('a deserializer returning a non-envelope is handled like a deserialize failure', async () => {
    const { engine, store, emitted } = makeEngine({
      serializer: { serialize: (e) => JSON.stringify(e), deserialize: () => null as never },
    });
    store.data.set('a', { value: '{}', ttlMs: 1 });
    expect(await engine.get({ key: 'a' })).toBeUndefined();
    /* null is not something this library wrote, so the entry stays */
    expect(store.data.has('a')).toBe(true);
    expect(emitted.some(isDeserializeError)).toBe(true);
    expect(emitted.at(-1)?.event).toBe('miss');
  });

  it('a custom deserializer returning an object with a string v deletes it', async () => {
    const { engine, store, emitted } = makeEngine({
      serializer: {
        serialize: (e) => JSON.stringify(e),
        deserialize: (raw) => JSON.parse(raw) as never,
      },
    });
    store.data.set('a', { value: '{"v":"2","value":1,"storedAt":0}', ttlMs: 1 });
    store.data.set('b', { value: '{"foo":1}', ttlMs: 1 });
    expect(await engine.get({ key: 'a' })).toBeUndefined();
    expect(await engine.get({ key: 'b' })).toBeUndefined();
    expect(store.data.has('a')).toBe(false);
    expect(store.data.has('b')).toBe(true);
    expect(emitted.filter(isDeserializeError)).toHaveLength(2);
  });

  const STRING_VERSION = '{"v":"2","value":1,"storedAt":0}';
  const gz = (plain: string): string =>
    `\u0000nc1:gz:${gzipSync(Buffer.from(plain)).toString('base64')}`;
  const br = (plain: string): string =>
    `\u0000nc1:br:${brotliCompressSync(Buffer.from(plain)).toString('base64')}`;

  describe('a newer envelope (v > 1) is a miss that is not deleted (D-01)', () => {
    const NEWER = '{"v":2,"value":1,"storedAt":0}';

    it.each(['get', 'getOrSet', 'sliding', 'getMany'] as const)(
      'is kept and reported through %s',
      async (path) => {
        const store = new FakeStore();
        Object.assign(store, {
          getAndTouch: (key: string): Promise<string | undefined> =>
            Promise.resolve(store.data.get(key)?.value),
          getMany: (keys: readonly string[]): Promise<(string | undefined)[]> =>
            Promise.resolve(keys.map((k) => store.data.get(k)?.value)),
        });
        store.data.set('a', { value: NEWER, ttlMs: 1 });
        const { engine, emitted } = makeEngine({ stores: { default: store } });
        const deletes = vi.spyOn(store, 'delete');
        const touches = vi.spyOn(store as unknown as { getAndTouch: () => unknown }, 'getAndTouch');
        const loader = vi.fn(async () => 'fresh');
        if (path === 'get') expect(await engine.get({ key: 'a' })).toBeUndefined();
        if (path === 'sliding') {
          expect(await engine.get({ key: 'a' }, { strategy: 'sliding' })).toBeUndefined();
        }
        if (path === 'getMany') expect(await engine.getMany({}, ['a'])).toEqual([undefined]);
        if (path === 'getOrSet') expect(await engine.getOrSet({ key: 'a' }, loader)).toBe('fresh');
        expect(loader).toHaveBeenCalledTimes(path === 'getOrSet' ? 1 : 0);
        expect(touches).toHaveBeenCalledTimes(path === 'sliding' ? 1 : 0);
        expect(deletes).not.toHaveBeenCalled();
        expect(store.calls.filter((c) => c.op === 'delete')).toEqual([]);
        expect(emitted.some(isDeserializeError)).toBe(true);
      },
    );

    it('is kept under compressedSerializer, plain and compressed', async () => {
      const { engine, store } = makeEngine({ serializer: compressedSerializer() });
      store.data.set('plain', { value: NEWER, ttlMs: 1 });
      store.data.set('gzip', { value: gz(NEWER), ttlMs: 1 });
      store.data.set('brotli', { value: br(NEWER), ttlMs: 1 });
      expect(await engine.get({ key: 'plain' })).toBeUndefined();
      expect(await engine.get({ key: 'gzip' })).toBeUndefined();
      expect(await engine.get({ key: 'brotli' })).toBeUndefined();
      expect(store.calls.filter((c) => c.op === 'delete')).toEqual([]);
    });
  });

  it('a custom deserializer that throws never deletes, whatever the raw value', async () => {
    /* only the built-in JSON serializer's own validation is looked behind */
    const { engine, store, emitted } = makeEngine({
      serializer: {
        serialize: (e) => JSON.stringify(e),
        deserialize: () => {
          throw new Error('cannot decode');
        },
      },
    });
    store.data.set('a', { value: '{"v":2,"value":1,"storedAt":0}', ttlMs: 1 });
    expect(await engine.get({ key: 'a' })).toBeUndefined();
    expect(store.data.has('a')).toBe(true);
    expect(emitted.some(isDeserializeError)).toBe(true);
  });

  it('a corrupt compressed payload is one deserialize error and a miss', async () => {
    /* the compressed serializer's throw takes the normal deserialize path and deletes nothing */
    const { engine, store, emitted } = makeEngine({ serializer: compressedSerializer() });
    store.data.set('a', { value: '\u0000nc1:gz:bm90IGd6aXA=', ttlMs: 1 });
    expect(await engine.get({ key: 'a' })).toBeUndefined();
    expect(emitted.filter(isDeserializeError)).toHaveLength(1);
    expect(store.data.has('a')).toBe(true);
  });

  it.each([
    ['compressedSerializer()', () => compressedSerializer()],
    [
      'compressedSerializer({ inner: jsonSerializer })',
      () => compressedSerializer({ inner: jsonSerializer }),
    ],
    [
      'compressedSerializer({ algorithm: brotli })',
      () => compressedSerializer({ algorithm: 'brotli' }),
    ],
  ])(
    'a foreign-version envelope is deleted under compressedSerializer(jsonSerializer), both uncompressed and compressed (%s)',
    async (_, make) => {
      /* Spec 4: an entry of another envelope version is the library's own, plain or behind a
         gzip/brotli prefix, so it is deleted as under jsonSerializer; a foreign value is not. */
      const { engine, store, emitted } = makeEngine({ serializer: make() });
      const raws = {
        plain: STRING_VERSION,
        gzip: gz(STRING_VERSION),
        brotli: br(STRING_VERSION),
        corrupt: gz('{"v":1,"value":1}'),
        foreignPlain: '{"foo":1}',
        foreignGzip: gz('{"foo":1}'),
        notJson: gz('not json'),
      };
      for (const [key, raw] of Object.entries(raws)) store.data.set(key, { value: raw, ttlMs: 1 });
      for (const key of Object.keys(raws)) expect(await engine.get({ key })).toBeUndefined();
      expect([...store.data.keys()].sort()).toEqual(['foreignGzip', 'foreignPlain', 'notJson']);
      expect(emitted.filter(isDeserializeError)).toHaveLength(Object.keys(raws).length);
    },
  );

  it('a decompression error is never treated as a foreign envelope (no delete)', async () => {
    /* Spec 4: a prefixed value that cannot be decompressed within maxDecompressedBytes (too
       large, truncated, bad base64, unknown algorithm) is left in the store, even when its
       content would be an envelope of another version. */
    const padded = `{"v":2,"value":"${'a'.repeat(500)}","storedAt":0}`;
    const { engine, store, emitted } = makeEngine({
      serializer: compressedSerializer({ maxDecompressedBytes: 256 }),
    });
    const whole = gzipSync(Buffer.from(STRING_VERSION));
    const raws = {
      tooLarge: gz(padded),
      tooLargeBrotli: br(padded),
      truncated: `\u0000nc1:gz:${whole.subarray(0, whole.length - 6).toString('base64')}`,
      badBase64: '\u0000nc1:gz:!!!not base64!!!',
      unknownAlgorithm: `\u0000nc1:zz:${whole.toString('base64')}`,
    };
    for (const [key, raw] of Object.entries(raws)) store.data.set(key, { value: raw, ttlMs: 1 });
    for (const key of Object.keys(raws)) expect(await engine.get({ key })).toBeUndefined();
    expect(store.data.size).toBe(Object.keys(raws).length);
    expect(store.calls.filter((c) => c.op === 'delete')).toEqual([]);
    expect(emitted.filter(isDeserializeError)).toHaveLength(Object.keys(raws).length);
  });

  it('a custom inner serializer keeps the 0.8 behaviour (no delete)', async () => {
    /* Spec 4: the marker is set only over the built-in jsonSerializer. A custom inner that
       throws, even one that delegates to jsonSerializer, never leads to a delete. */
    const delegating: Serializer = {
      serialize: (e) => jsonSerializer.serialize(e),
      deserialize: (raw) => jsonSerializer.deserialize(raw),
    };
    for (const inner of [delegating, { ...jsonSerializer }]) {
      const { engine, store, emitted } = makeEngine({
        serializer: compressedSerializer({ inner }),
      });
      store.data.set('plain', { value: STRING_VERSION, ttlMs: 1 });
      store.data.set('gzip', { value: gz(STRING_VERSION), ttlMs: 1 });
      expect(await engine.get({ key: 'plain' })).toBeUndefined();
      expect(await engine.get({ key: 'gzip' })).toBeUndefined();
      expect([...store.data.keys()]).toEqual(['plain', 'gzip']);
      expect(emitted.filter(isDeserializeError)).toHaveLength(2);
    }
  });

  it('a serializer that throws on write resolves and reports a set error', async () => {
    const boom = new Error('cannot serialize');
    const { engine, store, emitted } = makeEngine({
      serializer: {
        serialize: () => {
          throw boom;
        },
        deserialize: () => null as never,
      },
    });
    await expect(engine.set({ key: 'a' }, 1)).resolves.toBeUndefined();
    expect(store.data.size).toBe(0);
    expect(emitted).toEqual([
      { event: 'error', payload: { store: 'default', operation: 'set', error: boom } },
    ]);
  });

  it('with jitter, envelope expiresAt matches the TTL passed to the store', async () => {
    const { engine, store } = makeEngine({ defaults: { jitter: 0.5 } });
    vi.spyOn(Math, 'random').mockReturnValue(0.3);
    await engine.set({ key: 'a' }, 1, { ttl: 1_001 });
    const entry = store.data.get('a')!;
    const envelope = JSON.parse(entry.value) as { storedAt: number; expiresAt: number };
    expect(entry.ttlMs).not.toBe(1_001);
    expect(envelope.expiresAt).toBe(envelope.storedAt + entry.ttlMs);
  });

  it('delete maps keys through prefix and namespace', async () => {
    const { engine, store, emitted } = makeEngine({ prefix: 'app' });
    await engine.delete({ namespace: 'users' }, ['a', 'b']);
    expect(store.calls.at(-1)).toEqual({ op: 'delete', args: [['app:users:a', 'app:users:b']] });
    expect(emitted.at(-1)).toEqual({
      event: 'delete',
      payload: { store: 'default', namespace: 'users', keys: ['a', 'b'] },
    });
  });

  it('delete with no keys does not touch the store', async () => {
    const { engine, store } = makeEngine();
    await engine.delete({}, []);
    expect(store.calls).toEqual([]);
  });

  it('a failing delete or clear resolves and reports', async () => {
    const { engine, store, emitted } = makeEngine();
    store.failNext('delete');
    store.failNext('clear');
    await expect(engine.delete({}, ['a'])).resolves.toBeUndefined();
    await expect(engine.clear('users')).resolves.toBeUndefined();
    const ops = emitted.map((e) => [e.event, (e.payload as { operation?: string }).operation]);
    expect(ops).toEqual([
      ['error', 'delete'],
      ['error', 'clear'],
    ]);
  });

  it('clear removes the namespace prefix', async () => {
    const { engine, store, emitted } = makeEngine({ prefix: 'app' });
    await engine.clear('users');
    expect(store.calls.at(-1)).toEqual({ op: 'clear', args: ['app:users:'] });
    expect(emitted.at(-1)).toEqual({
      event: 'clear',
      payload: { store: 'default', namespace: 'users' },
    });
  });

  it('routes to a named store and rejects unknown names', async () => {
    const sessions = new FakeStore();
    const { engine, store, emitted } = makeEngine({
      stores: { default: new FakeStore(), sessions },
    });
    await engine.set({ store: 'sessions', key: 'a' }, 1);
    expect(sessions.data.has('a')).toBe(true);
    expect(store.data.size).toBe(0);
    emitted.length = 0;
    await expect(engine.get({ store: 'nope', key: 'a' })).rejects.toThrow(
      /Unknown cache store "nope"\. Configured stores: default, sessions/,
    );
    expect(emitted).toEqual([]);
    expect(engine.hasStore('sessions')).toBe(true);
    expect(engine.hasStore('nope')).toBe(false);
    expect(engine.storeNames()).toEqual(['default', 'sessions']);
  });

  it('applies jitter and always passes an integer TTL of at least 1 (Review Focus 4)', async () => {
    const { engine, store } = makeEngine({ defaults: { jitter: 0.5 } });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await engine.set({ key: 'low' }, 1, { ttl: 60_000 });
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
    await engine.set({ key: 'high' }, 1, { ttl: 60_000 });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await engine.set({ key: 'tiny' }, 1, { ttl: 1 });
    vi.spyOn(Math, 'random').mockReturnValue(0.3);
    await engine.set({ key: 'odd' }, 1, { ttl: 1_001 });
    expect(store.data.get('low')?.ttlMs).toBe(30_000);
    expect(store.data.get('high')?.ttlMs).toBe(75_000);
    expect(store.data.get('tiny')?.ttlMs).toBe(1);
    expect(Number.isInteger(store.data.get('odd')?.ttlMs)).toBe(true);
  });

  it('put follows the @CachePut table', async () => {
    const { engine, store } = makeEngine();
    const ref = { key: 'a' };
    await engine.put(ref, { n: 1 });
    expect(store.data.has('a')).toBe(true);
    await engine.put(ref, { n: 2 }, { unless: () => true });
    expect(await engine.get(ref)).toEqual({ n: 1 });
    await engine.put(ref, null);
    expect(store.data.has('a')).toBe(false);
    await engine.put(ref, null, { cacheNull: true });
    expect(store.data.get('a')?.ttlMs).toBe(30_000);
    await engine.put(ref, undefined, { cacheNull: true, nullTtl: 7 });
    expect(store.data.get('a')?.ttlMs).toBe(7);
  });

  it('put reports a throwing unless and stores nothing', async () => {
    const { engine, store, emitted } = makeEngine();
    const boom = new Error('bad predicate');
    await engine.put({ key: 'a' }, 1, {
      unless: () => {
        throw boom;
      },
    });
    expect(store.data.size).toBe(0);
    expect(emitted).toEqual([
      { event: 'error', payload: { store: 'default', operation: 'set', error: boom } },
    ]);
  });

  it('reportError emits an error event with store "default" when none is given', () => {
    const { engine, emitted } = makeEngine();
    const error = new Error('x');
    engine.reportError(undefined, 'key', error);
    expect(emitted).toEqual([
      { event: 'error', payload: { store: 'default', operation: 'key', error } },
    ]);
  });
});
