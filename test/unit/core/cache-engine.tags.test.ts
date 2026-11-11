import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheEnvelope } from '../../../src/core/envelope.js';
import { makeEngine } from '../helpers/engine.js';
import { FakeLock } from '../helpers/fake-lock.js';
import { FakeStore } from '../helpers/fake-store.js';

/** A FakeStore whose tag token reads can be made to fail. */
class TagStore extends FakeStore {
  failTags = false;

  override get(key: string): Promise<string | undefined> {
    if (this.failTags && key.startsWith('app:__tag__:')) {
      return Promise.reject(new Error('tag read failed'));
    }
    return super.get(key);
  }
}

function setup(store: FakeStore = new FakeStore()) {
  const made = makeEngine({ prefix: 'app', stores: { default: store } });
  const target = { name: 'default', store: made.store };
  const token = (tag: string): string | undefined => made.engine.tokens.cached(target, 'tag', tag);
  const errors = () =>
    made.emitted.filter((e) => e.event === 'error').map((e) => e.payload as { operation: string });
  return { ...made, target, token, errors };
}

function envelopeOf(store: FakeStore, key: string): CacheEnvelope | undefined {
  const raw = store.data.get(key)?.value;
  return raw === undefined ? undefined : (JSON.parse(raw) as CacheEnvelope);
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function manyTags(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `t${String(i)}`);
}

describe('CacheEngine tags: the write path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('set with tags writes a stamp of the current tokens', async () => {
    /* set creates a token per tag (de-duplicated, in first-occurrence order) and stamps the
       envelope with exactly the tokens this instance now holds, which are the stored ones. */
    const { engine, store, token } = setup();
    await engine.set({ key: 'k' }, 1, { tags: ['user:7', 'org:1', 'user:7'] });
    const stamp = envelopeOf(store, 'app:k')?.tags;
    expect(stamp).toEqual({ 'user:7': token('user:7'), 'org:1': token('org:1') });
    expect(Object.keys(stamp ?? {})).toEqual(['user:7', 'org:1']);
    expect(token('user:7')).toMatch(/^[0-9a-z]{8}$/);
    expect(store.data.get('app:__tag__:user:7')?.value).toBe(token('user:7'));
    expect(store.data.get('app:__tag__:org:1')?.value).toBe(token('org:1'));
    expect(await engine.get({ key: 'k' })).toBe(1);
  });

  it('set with a tag function passes it the value', async () => {
    /* On set the value is known, so a tag function runs with it before the write. */
    const { engine, store, token } = setup();
    const tags = vi.fn((value: unknown) => [`user:${String((value as { id: number }).id)}`]);
    await engine.set({ key: 'k' }, { id: 7 }, { tags });
    expect(tags).toHaveBeenCalledExactlyOnceWith({ id: 7 });
    expect(envelopeOf(store, 'app:k')?.tags).toEqual({ 'user:7': token('user:7') });
  });

  it('a tag with a separator, a percent sign, unicode or __proto__ round-trips as an own key', async () => {
    /* Tag text is not escaped: the stamp keys are the tags, read back by the JSON serializer
       as own properties (a `__proto__` tag never touches the prototype). */
    const { engine, store, token } = setup();
    const tags = ['a:b', '50%', 'ключ', '__proto__'];
    await engine.set({ key: 'k' }, 1, { tags });
    const stamp = envelopeOf(store, 'app:k')?.tags ?? {};
    expect(Object.keys(stamp)).toEqual(tags);
    for (const tag of tags)
      expect(Object.getOwnPropertyDescriptor(stamp, tag)?.value).toBe(token(tag));
    expect(Object.getPrototypeOf(stamp)).toBe(Object.prototype);
    expect(store.data.has('app:__tag__:ключ')).toBe(true);
  });

  it('entries without tags carry no tags field', async () => {
    /* Every write path without `tags`, and with an empty list, stores the 0.6 envelope and
       never touches a tag token key. */
    const { engine, store } = setup();
    const loader = async (): Promise<string> => 'v';
    const many = async (missing: string[]) => new Map(missing.map((k) => [k, k]));
    await engine.set({ key: 'a' }, 1);
    await engine.set({ key: 'b' }, 1, { tags: [] });
    await engine.getOrSet({ key: 'c' }, loader);
    await engine.getOrSet({ key: 'd' }, loader, { tags: [] });
    await engine.put({ key: 'e' }, 'v', { tags: () => [] });
    await engine.setMany({}, [['f', 1]]);
    await engine.setMany({}, [['g', 1]], { tags: () => [] });
    await engine.getOrSetMany({}, ['h'], many);
    await engine.getOrSetMany({}, ['i'], many, { tags: [] });
    for (const key of 'abcdefghi') {
      const raw = store.data.get(`app:${key}`)?.value;
      expect(raw).toBeDefined();
      expect(JSON.parse(raw ?? '{}')).not.toHaveProperty('tags');
    }
    expect(store.calls.some((c) => String(c.args[0]).includes('__tag__'))).toBe(false);
  });

  it('array tags take tokens before the loader runs', async () => {
    /* getOrSet takes the token of an array tag before calling the loader. A bump during the
       load does not change the stamp: the entry is written with the pre-bump token, so the
       invalidation that raced the load is not lost. */
    const { engine, store, target, token } = setup();
    const started = deferred();
    const gate = deferred();
    const pending = engine.getOrSet(
      { key: 'k' },
      async () => {
        started.resolve();
        await gate.promise;
        return 'v';
      },
      { tags: ['user:7'] },
    );
    await started.promise;
    const before = token('user:7');
    expect(before).toBeDefined();
    await engine.tokens.bump(target, 'tag', 'user:7');
    expect(token('user:7')).not.toBe(before);
    gate.resolve();
    expect(await pending).toBe('v');
    expect(envelopeOf(store, 'app:k')?.tags).toEqual({ 'user:7': before });
  });

  it('function tags run after the load with the value and only when the entry is written', async () => {
    /* A tag function gets the loaded value. When `unless` vetoes the write, or an empty value
       is not cached, the function is never called and no token is created. */
    const { engine, store, token } = setup();
    const tags = vi.fn((value: string) => [`v:${value}`]);
    expect(await engine.getOrSet({ key: 'k' }, async () => 'x', { tags })).toBe('x');
    expect(tags).toHaveBeenCalledExactlyOnceWith('x');
    expect(envelopeOf(store, 'app:k')?.tags).toEqual({ 'v:x': token('v:x') });

    tags.mockClear();
    const unless = vi.fn(() => true);
    expect(await engine.getOrSet({ key: 'u' }, async () => 'y', { tags, unless })).toBe('y');
    expect(unless).toHaveBeenCalledOnce();
    expect(tags).not.toHaveBeenCalled();
    expect(store.data.has('app:u')).toBe(false);

    const nullTags = vi.fn(() => ['n']);
    expect(await engine.getOrSet({ key: 'n' }, async () => null, { tags: nullTags })).toBeNull();
    expect(nullTags).not.toHaveBeenCalled();
    expect(store.data.has('app:__tag__:n')).toBe(false);

    const cached = vi.fn(() => ['n']);
    await engine.getOrSet({ key: 'm' }, async () => null, { tags: cached, cacheNull: true });
    expect(cached).toHaveBeenCalledExactlyOnceWith(null);
    expect(envelopeOf(store, 'app:m')).toMatchObject({ nil: 'null', tags: { n: token('n') } });
  });

  it('put stamps the entry with array or function tags, after unless', async () => {
    /* The @CachePut path: the value is known, tags are computed once the write is decided. */
    const { engine, store, token } = setup();
    await engine.put({ key: 'a' }, 'x', { tags: ['p'] });
    expect(envelopeOf(store, 'app:a')?.tags).toEqual({ p: token('p') });
    const tags = vi.fn((value: string) => [value]);
    await engine.put({ key: 'b' }, 'q', { tags });
    expect(tags).toHaveBeenCalledExactlyOnceWith('q');
    expect(envelopeOf(store, 'app:b')?.tags).toEqual({ q: token('q') });
    const skipped = vi.fn(() => ['s']);
    await engine.put({ key: 'c' }, 'r', { tags: skipped, unless: () => true });
    expect(skipped).not.toHaveBeenCalled();
    expect(store.data.has('app:c')).toBe(false);
  });

  it('an invalid tag value reports one tag error and skips the write, and the caller still gets the value', async () => {
    /* An empty tag, a non-array result, a throwing callback or more than 32 tags each give one
       `tag` error; nothing is written (no entry, no token) and the call resolves normally. */
    const { engine, store, errors } = setup();
    const invalid: (readonly string[] | ((value: unknown) => readonly string[]))[] = [
      ['ok', ''],
      () => 'nope' as unknown as string[],
      () => {
        throw new Error('callback failed');
      },
      manyTags(33),
      5 as unknown as string[],
    ];
    for (const [i, tags] of invalid.entries()) {
      const before = errors().length;
      expect(await engine.getOrSet({ key: `g${String(i)}` }, async () => 'v', { tags })).toBe('v');
      await engine.set({ key: `s${String(i)}` }, 'v', { tags });
      await engine.put({ key: `p${String(i)}` }, 'v', { tags });
      expect(
        errors()
          .slice(before)
          .map((e) => e.operation),
      ).toEqual(['tag', 'tag', 'tag']);
    }
    const thrown = errors()[6] as unknown as { store: string; error: unknown };
    expect(thrown.store).toBe('default');
    expect(thrown.error).toEqual(new Error('callback failed'));
    expect([...store.data.keys()]).toEqual([]);
  });

  it('32 unique tags are written; 33 give one tag error and no write; duplicates do not count', async () => {
    /* Review Focus 4: the limit is counted after de-duplication. */
    const { engine, store, errors } = setup();
    const tags = manyTags(32);
    await engine.set({ key: 'ok' }, 1, { tags: [...tags, ...tags] });
    expect(Object.keys(envelopeOf(store, 'app:ok')?.tags ?? {})).toEqual(tags);
    await engine.set({ key: 'over' }, 1, { tags: manyTags(33) });
    expect(store.data.has('app:over')).toBe(false);
    expect(store.data.has('app:__tag__:t32')).toBe(false);
    expect(errors().map((e) => e.operation)).toEqual(['tag']);
  });

  it('ensureMany failure reports one version error and skips the write', async () => {
    /* A failing token read is a `version` error (not `tag`): the entry is not written and
       every caller still gets its value. */
    const store = new TagStore();
    const { engine, errors } = setup(store);
    store.failTags = true;
    const many = async (missing: string[]) => new Map(missing.map((k) => [k, k]));
    expect(await engine.getOrSet({ key: 'a' }, async () => 'v', { tags: ['t', 'u'] })).toBe('v');
    expect(await engine.getOrSet({ key: 'b' }, async () => 'v', { tags: () => ['t'] })).toBe('v');
    await engine.set({ key: 'c' }, 1, { tags: ['t'] });
    await engine.put({ key: 'd' }, 1, { tags: ['t'] });
    await engine.setMany(
      {},
      [
        ['e', 1],
        ['f', 2],
      ],
      { tags: (_, key) => [key] },
    );
    expect(await engine.getOrSetMany({}, ['g', 'h'], many, { tags: ['t'] })).toEqual(['g', 'h']);
    expect(await engine.getOrSetMany({}, ['i'], many, { tags: () => ['t'] })).toEqual(['i']);
    expect(errors().map((e) => e.operation)).toEqual(Array(7).fill('version'));
    expect([...store.data.keys()]).toEqual([]);
  });

  it('a version failure before the load still runs the loader once', async () => {
    /* With array tags the tokens are taken first; their failure is reported and the loader
       runs as usual, its value returned without a write. */
    const store = new TagStore();
    const { engine, errors, emitted } = setup(store);
    store.failTags = true;
    const loader = vi.fn(async () => 'v');
    expect(await engine.getOrSet({ key: 'a' }, loader, { tags: ['t'] })).toBe('v');
    expect(loader).toHaveBeenCalledOnce();
    expect(errors().map((e) => e.operation)).toEqual(['version']);
    expect(emitted.map((e) => e.event)).toEqual(['miss', 'error', 'load']);
  });

  it('setMany and getOrSetMany stamp each entry, with function tags receiving (value, key)', async () => {
    /* Batch tag functions get each entry's value and key; array tags stamp every entry with
       the same tokens. Entries vetoed by unless never call the function. */
    const { engine, store, token } = setup();
    const setTags = vi.fn((value: unknown, key: string) => [`k:${key}`, `v:${String(value)}`]);
    await engine.setMany(
      { namespace: 'n' },
      [
        ['a', 1],
        ['b', 2],
      ],
      { tags: setTags },
    );
    expect(setTags.mock.calls).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(envelopeOf(store, 'app:n:a')?.tags).toEqual({
      'k:a': token('k:a'),
      'v:1': token('v:1'),
    });
    expect(envelopeOf(store, 'app:n:b')?.tags).toEqual({
      'k:b': token('k:b'),
      'v:2': token('v:2'),
    });

    const loadTags = vi.fn((value: string, key: string) => [`k:${key}`, value]);
    const loader = async (missing: string[]) => new Map(missing.map((k) => [k, `L${k}`]));
    expect(
      await engine.getOrSetMany({}, ['c', 'd', 'e'], loader, {
        tags: loadTags,
        unless: (value) => value === 'Le',
      }),
    ).toEqual(['Lc', 'Ld', 'Le']);
    expect(loadTags.mock.calls).toEqual([
      ['Lc', 'c'],
      ['Ld', 'd'],
    ]);
    expect(envelopeOf(store, 'app:c')?.tags).toEqual({ 'k:c': token('k:c'), Lc: token('Lc') });
    expect(envelopeOf(store, 'app:d')?.tags).toEqual({ 'k:d': token('k:d'), Ld: token('Ld') });
    expect(store.data.has('app:e')).toBe(false);

    await engine.setMany({}, [['f', 1]], { tags: ['shared'] });
    await engine.getOrSetMany({}, ['g'], loader, { tags: ['shared'] });
    expect(envelopeOf(store, 'app:f')?.tags).toEqual({ shared: token('shared') });
    expect(envelopeOf(store, 'app:g')?.tags).toEqual({ shared: token('shared') });
  });

  it('getOrSetMany array tags take tokens before the batch loader runs', async () => {
    /* As getOrSet: a bump while the batch loader is pending leaves the pre-bump token in
       every stamp. */
    const { engine, store, target, token } = setup();
    const started = deferred();
    const gate = deferred();
    const pending = engine.getOrSetMany(
      {},
      ['a', 'b'],
      async (missing) => {
        started.resolve();
        await gate.promise;
        return new Map(missing.map((k) => [k, k]));
      },
      { tags: ['user:7'] },
    );
    await started.promise;
    const before = token('user:7');
    expect(before).toBeDefined();
    await engine.tokens.bump(target, 'tag', 'user:7');
    gate.resolve();
    expect(await pending).toEqual(['a', 'b']);
    expect(envelopeOf(store, 'app:a')?.tags).toEqual({ 'user:7': before });
    expect(envelopeOf(store, 'app:b')?.tags).toEqual({ 'user:7': before });
  });

  it('a batch writes the entries with valid tags and reports invalid ones once', async () => {
    /* Two entries with invalid tags are one `tag` error; they are not written, the others are.
       An entry whose function returns no tags is written untagged. */
    const { engine, store, errors, token } = setup();
    const tags = (value: unknown, key: string): readonly string[] => {
      if (key === 'x') throw new Error('bad');
      if (key === 'y') return [''];
      return value === 0 ? [] : [key];
    };
    await engine.setMany(
      {},
      [
        ['a', 1],
        ['x', 1],
        ['y', 1],
        ['z', 0],
      ],
      { tags },
    );
    expect(errors().map((e) => e.operation)).toEqual(['tag']);
    expect(envelopeOf(store, 'app:a')?.tags).toEqual({ a: token('a') });
    expect(store.data.has('app:x')).toBe(false);
    expect(store.data.has('app:y')).toBe(false);
    expect(envelopeOf(store, 'app:z')).not.toHaveProperty('tags');

    const loader = async (missing: string[]) => new Map(missing.map((k) => [k, 1]));
    expect(await engine.getOrSetMany({}, ['b', 'x'], loader, { tags })).toEqual([1, 1]);
    expect(errors().map((e) => e.operation)).toEqual(['tag', 'tag']);
    expect(envelopeOf(store, 'app:b')?.tags).toEqual({ b: token('b') });
    expect(store.data.has('app:x')).toBe(false);
  });

  it('a version failure in a batch skips only the tagged entries', async () => {
    /* One `version` error for the call; an entry whose function returned no tags needs no
       token and is still written. */
    const store = new TagStore();
    const { engine, errors } = setup(store);
    store.failTags = true;
    await engine.setMany(
      {},
      [
        ['a', 1],
        ['b', 0],
      ],
      { tags: (value, key) => (value === 0 ? [] : [key]) },
    );
    expect(errors().map((e) => e.operation)).toEqual(['version']);
    expect(store.data.has('app:a')).toBe(false);
    expect(envelopeOf(store, 'app:b')).not.toHaveProperty('tags');
  });

  it('an swr refresh stamps the reloaded entry', async () => {
    /* The background refresh is a load like any other: its write carries the tags, here
       taken from the refreshed value. */
    const { engine, store, token } = setup();
    const options = {
      ttl: 100,
      strategy: 'swr' as const,
      staleTtl: 1_000,
      tags: (value: string) => [`v:${value}`],
    };
    await engine.getOrSet({ key: 'k' }, async () => 'one', options);
    vi.setSystemTime(150);
    expect(await engine.getOrSet({ key: 'k' }, async () => 'two', options)).toBe('one');
    await vi.runAllTimersAsync();
    const envelope = envelopeOf(store, 'app:k');
    expect(envelope?.value).toBe('two');
    expect(envelope?.tags).toEqual({ 'v:two': token('v:two') });
  });

  it('a locked load takes array tokens once it holds the lock', async () => {
    /* The lock path runs the same load: the lock is acquired first, then the tag token is
       read, then the loader runs, and the write carries that token. */
    const lock = new FakeLock();
    const store = Object.assign(new FakeStore(), { lock });
    const { engine, token } = setup(store);
    const order: string[] = [];
    const acquire = lock.acquire.bind(lock);
    vi.spyOn(lock, 'acquire').mockImplementation((key, ttl) => {
      order.push('lock');
      return acquire(key, ttl);
    });
    const get = store.get.bind(store);
    vi.spyOn(store, 'get').mockImplementation((key) => {
      if (key.includes('__tag__')) order.push('token');
      return get(key);
    });
    const loader = async (): Promise<string> => {
      order.push('load');
      return 'v';
    };
    expect(await engine.getOrSet({ key: 'k' }, loader, { tags: ['t'], lock: true })).toBe('v');
    // A missing token is read, created, then read back: collapse the repeats.
    expect(order.filter((step, i) => step !== order[i - 1])).toEqual(['lock', 'token', 'load']);
    expect(envelopeOf(store, 'app:k')?.tags).toEqual({ t: token('t') });
  });
});
