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

/** A TagStore with `getStrict`, like a tiered store; its tag reads fail with `failTags` too. */
class StrictStore extends TagStore {
  readonly strictReads: string[] = [];

  getStrict(key: string): Promise<string | undefined> {
    this.strictReads.push(key);
    if (this.failTags && key.startsWith('app:__tag__:')) {
      return Promise.reject(new Error('strict tag read failed'));
    }
    return Promise.resolve(this.data.get(key)?.value);
  }
}

/** A FakeStore with `getMany` and `getAndTouch`, each call recorded. */
class BatchStore extends FakeStore {
  readonly manyReads: string[][] = [];
  readonly touches: string[] = [];

  getMany(keys: readonly string[]): Promise<(string | undefined)[]> {
    this.manyReads.push([...keys]);
    return Promise.resolve(keys.map((key) => this.data.get(key)?.value));
  }

  getAndTouch(key: string, ttlMs: number): Promise<string | undefined> {
    this.touches.push(key);
    const entry = this.data.get(key);
    if (entry !== undefined) entry.ttlMs = ttlMs;
    return Promise.resolve(entry?.value);
  }
}

/** A FakeStore whose writes of the named tag keys fail, each with its own error. */
class FailingWrites extends FakeStore {
  readonly failing = new Map<string, Error>();

  override set(key: string, value: string, ttlMs: number): Promise<void> {
    const error = this.failing.get(key);
    if (error !== undefined) return Promise.reject(error);
    return super.set(key, value, ttlMs);
  }
}

function events(emitted: { event: string; payload: unknown }[]) {
  return emitted.map((e) =>
    e.event === 'error' ? `error:${(e.payload as { operation: string }).operation}` : e.event,
  );
}

describe('CacheEngine tags: the read path and invalidateTags', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a matching stamp is a hit', async () => {
    /* An entry whose tag tokens all match is served as usual: a hit, the loader never runs. */
    const { engine, emitted } = setup();
    await engine.set({ key: 'k' }, 'v', { tags: ['user:7', 'org:1'] });
    emitted.length = 0;
    const loader = vi.fn(async () => 'other');
    expect(await engine.get({ key: 'k' })).toBe('v');
    expect(await engine.getOrSet({ key: 'k' }, loader, { tags: ['user:7'] })).toBe('v');
    expect(loader).not.toHaveBeenCalled();
    expect(events(emitted)).toEqual(['hit', 'hit']);
  });

  it('a bumped tag makes the entry a miss and getOrSet reloads', async () => {
    /* invalidateTags gives the tag a new token: the stored stamp no longer matches, so get is a
       miss (the entry is left in the store) and getOrSet loads and writes a new stamp. */
    const { engine, store, emitted, token } = setup();
    await engine.getOrSet({ key: 'k' }, async () => 'one', { tags: ['user:7'] });
    const before = token('user:7');
    await engine.invalidateTags(['user:7']);
    expect(token('user:7')).not.toBe(before);
    emitted.length = 0;
    expect(await engine.get({ key: 'k' })).toBeUndefined();
    expect(store.data.has('app:k')).toBe(true);
    const loader = vi.fn(async () => 'two');
    expect(await engine.getOrSet({ key: 'k' }, loader, { tags: ['user:7'] })).toBe('two');
    expect(loader).toHaveBeenCalledOnce();
    expect(envelopeOf(store, 'app:k')).toMatchObject({
      value: 'two',
      tags: { 'user:7': token('user:7') },
    });
    expect(events(emitted)).toEqual(['miss', 'miss', 'load', 'set']);
    expect(await engine.get({ key: 'k' })).toBe('two');
  });

  it('the invalidating instance sees its own invalidation immediately even with a long cacheTtl', async () => {
    /* Review Focus 2: with cacheTtl 60 s, getOrSet -> invalidateTags -> getOrSet on the same
       instance calls the loader again: the bump caches the new token at once. */
    const store = new FakeStore();
    const { engine } = makeEngine({
      prefix: 'app',
      versioning: { cacheTtl: 60_000 },
      stores: { default: store },
    });
    const loader = vi.fn(async () => 'v');
    await engine.getOrSet({ key: 'k' }, loader, { tags: ['user:7'] });
    await engine.getOrSet({ key: 'k' }, loader, { tags: ['user:7'] });
    expect(loader).toHaveBeenCalledOnce();
    await engine.invalidateTags(['user:7']);
    await engine.getOrSet({ key: 'k' }, loader, { tags: ['user:7'] });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('a missing tag version key is a miss and the read creates no token', async () => {
    /* Review Focus 3: the tag key was deleted (clear, TTL). Once the cached token expires, the
       entry is a miss on every read path, and no read writes the tag key back. */
    const { engine, store, emitted } = setup();
    await engine.set({ key: 'k' }, 'v', { tags: ['t'] });
    await engine.setMany({}, [['m', 'w']], { tags: ['t'] });
    store.data.delete('app:__tag__:t');
    vi.setSystemTime(1_001);
    emitted.length = 0;
    const setsBefore = store.calls.filter((c) => c.op === 'set').length;
    expect(await engine.get({ key: 'k' })).toBeUndefined();
    expect(await engine.getMany({}, ['k', 'm'])).toEqual([undefined, undefined]);
    expect(events(emitted)).toEqual(['miss', 'miss', 'miss']);
    expect(store.calls.filter((c) => c.op === 'set')).toHaveLength(setsBefore);
    expect(store.data.has('app:__tag__:t')).toBe(false);
    // An untagged reload replaces the entry and still creates no token.
    expect(await engine.getOrSet({ key: 'k' }, async () => 'new')).toBe('new');
    expect(store.data.has('app:__tag__:t')).toBe(false);
    expect(envelopeOf(store, 'app:k')).not.toHaveProperty('tags');
  });

  it('swr: a stale entry whose tag was bumped is a hard miss, not served stale', async () => {
    /* A stale swr entry is normally served while it refreshes. After its tag is invalidated
       it is a miss: getOrSet awaits the load and returns the new value. */
    const { engine, emitted } = setup();
    const options = { ttl: 100, strategy: 'swr' as const, staleTtl: 1_000, tags: ['t'] };
    await engine.getOrSet({ key: 'k' }, async () => 'one', options);
    vi.setSystemTime(150);
    await engine.invalidateTags(['t']);
    emitted.length = 0;
    expect(await engine.get({ key: 'k' }, options)).toBeUndefined();
    expect(await engine.getOrSet({ key: 'k' }, async () => 'two', options)).toBe('two');
    expect(events(emitted)).toEqual(['miss', 'miss', 'load', 'set']);
    expect(await engine.getOrSetMany({}, ['k'], async () => new Map(), options)).toEqual(['two']);
  });

  it('sliding (getAndTouch) checks tags too', async () => {
    /* A sliding read goes through getAndTouch; an entry whose tag was bumped is still a miss
       for get, getMany and getOrSet. */
    const store = new BatchStore();
    const { engine, emitted } = setup(store);
    const options = { strategy: 'sliding' as const, tags: ['t'] };
    await engine.set({ key: 'k' }, 'v', options);
    expect(await engine.get({ key: 'k' }, options)).toBe('v');
    await engine.invalidateTags(['t']);
    emitted.length = 0;
    store.touches.length = 0;
    expect(await engine.get({ key: 'k' }, options)).toBeUndefined();
    expect(await engine.getMany({}, ['k'], options)).toEqual([undefined]);
    expect(await engine.getOrSet({ key: 'k' }, async () => 'new', options)).toBe('new');
    expect(store.touches).toEqual(['app:k', 'app:k', 'app:k']);
    expect(events(emitted)).toEqual(['miss', 'miss', 'miss', 'load', 'set']);
  });

  it('getMany gathers the tags of all entries and calls currentMany once', async () => {
    /* A batch read checks every tagged entry with one currentMany call over the union of their
       tags; untagged entries need none. Only the entries with a bumped tag are misses, and
       getOrSetMany loads just those. */
    const store = new BatchStore();
    const { engine } = setup(store);
    await engine.setMany(
      {},
      [
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ],
      { tags: (_, key) => [key, 'shared'] },
    );
    await engine.set({ key: 'u' }, 4);
    await engine.invalidateTags(['b']);
    const currentMany = vi.spyOn(engine.tokens, 'currentMany');
    expect(await engine.getMany({}, ['a', 'b', 'c', 'u'])).toEqual([1, undefined, 3, 4]);
    expect(currentMany).toHaveBeenCalledOnce();
    expect(new Set(currentMany.mock.calls[0]?.[2])).toEqual(new Set(['a', 'b', 'c', 'shared']));
    currentMany.mockClear();
    const loader = vi.fn(async (missing: string[]) => new Map(missing.map((k) => [k, 9])));
    expect(await engine.getOrSetMany({}, ['a', 'b', 'c', 'u'], loader)).toEqual([1, 9, 3, 4]);
    expect(loader).toHaveBeenCalledExactlyOnceWith(['b']);
    expect(currentMany).toHaveBeenCalledOnce();
    currentMany.mockClear();
    expect(await engine.getMany({}, ['u'])).toEqual([4]);
    expect(currentMany).not.toHaveBeenCalled();
  });

  it('cached tokens mean no extra store reads', async () => {
    /* While the tag tokens are cached (cacheTtl), a tagged hit costs exactly the data read:
       one get for get, one getMany for getMany, and no getStrict at all. */
    const strict = new StrictStore();
    const single = setup(strict);
    await single.engine.set({ key: 'k' }, 'v', { tags: ['t', 'u'] });
    strict.calls.length = 0;
    strict.strictReads.length = 0;
    expect(await single.engine.get({ key: 'k' })).toBe('v');
    expect(await single.engine.getOrSet({ key: 'k' }, async () => 'x', { tags: ['t'] })).toBe('v');
    expect(strict.calls).toEqual([
      { op: 'get', args: ['app:k'] },
      { op: 'get', args: ['app:k'] },
    ]);
    expect(strict.strictReads).toEqual([]);

    const batch = new BatchStore();
    const many = setup(batch);
    await many.engine.setMany(
      {},
      [
        ['a', 1],
        ['b', 2],
      ],
      { tags: (_, key) => [key] },
    );
    batch.calls.length = 0;
    batch.manyReads.length = 0;
    expect(await many.engine.getMany({}, ['a', 'b'])).toEqual([1, 2]);
    expect(batch.manyReads).toEqual([['app:a', 'app:b']]);
    expect(batch.calls).toEqual([]);
  });

  it('a token read failure reports one version error; a getStrict store falls back to the last known tokens; otherwise the entry is a miss and getOrSet loads without writing', async () => {
    /* Spec 3.2 step 4 and D3. Without getStrict, a failed token read makes every tagged entry
       of the call a miss (one `version` error per call) and the load writes nothing, so no
       second error is caused by taking tokens. A getStrict store compares with the tokens this
       process last knew, even past cacheTtl; a tag it never knew is such a miss too. */
    const plain = new TagStore();
    const p = setup(plain);
    await p.engine.set({ key: 'k' }, 'old', { tags: ['t'] });
    await p.engine.set({ key: 'j' }, 'old', { tags: ['u'] });
    vi.setSystemTime(1_001);
    plain.failTags = true;
    p.emitted.length = 0;
    expect(await p.engine.get({ key: 'k' })).toBeUndefined();
    const loader = vi.fn(async () => 'new');
    expect(await p.engine.getOrSet({ key: 'k' }, loader, { tags: ['t'] })).toBe('new');
    expect(await p.engine.getOrSet({ key: 'k' }, loader)).toBe('new');
    expect(loader).toHaveBeenCalledTimes(2);
    expect(await p.engine.getMany({}, ['k', 'j'])).toEqual([undefined, undefined]);
    const many = vi.fn(async (missing: string[]) => new Map(missing.map((key) => [key, 'L'])));
    expect(await p.engine.getOrSetMany({}, ['k', 'j', 'x'], many)).toEqual(['L', 'L', 'L']);
    expect(many).toHaveBeenCalledExactlyOnceWith(['k', 'j', 'x']);
    expect(events(p.emitted)).toEqual([
      ...['error:version', 'miss'],
      ...['error:version', 'miss', 'load'],
      ...['error:version', 'miss', 'load'],
      ...['error:version', 'miss', 'miss'],
      ...['error:version', 'miss', 'miss', 'miss', 'load', 'set'],
    ]);
    // The unverified entries were not written over; the plain miss was.
    expect(envelopeOf(plain, 'app:k')?.value).toBe('old');
    expect(envelopeOf(plain, 'app:j')?.value).toBe('old');
    expect(envelopeOf(plain, 'app:x')?.value).toBe('L');

    const strict = new StrictStore();
    const s = setup(strict);
    await s.engine.set({ key: 'k' }, 'v', { tags: ['t'] });
    await s.engine.set({ key: 'gone' }, 'v', { tags: ['g'] });
    await s.engine.invalidateTags(['g']);
    vi.setSystemTime(2_002);
    strict.failTags = true;
    s.emitted.length = 0;
    expect(await s.engine.get({ key: 'k' })).toBe('v');
    expect(await s.engine.get({ key: 'gone' })).toBeUndefined();
    expect(await s.engine.getMany({}, ['k', 'gone'])).toEqual(['v', undefined]);
    expect(events(s.emitted)).toEqual([
      ...['error:version', 'hit'],
      ...['error:version', 'miss'],
      ...['error:version', 'hit', 'miss'],
    ]);

    // Another instance on the same store never knew the token: a miss, loaded without a write.
    const other = makeEngine({ prefix: 'app', stores: { default: strict } });
    const otherLoader = vi.fn(async () => 'theirs');
    expect(await other.engine.getOrSet({ key: 'k' }, otherLoader)).toBe('theirs');
    expect(otherLoader).toHaveBeenCalledOnce();
    expect(envelopeOf(strict, 'app:k')?.value).toBe('v');
    expect(events(other.emitted)).toEqual(['error:version', 'miss', 'load']);
  });

  it('invalidateTags is per store', async () => {
    /* Review Focus 1: the same tag in two stores has two tokens; invalidating it in one store
       leaves the other store's entry a hit. */
    const other = new FakeStore();
    const { engine } = makeEngine({ prefix: 'app', stores: { default: new FakeStore(), other } });
    await engine.set({ key: 'k' }, 'a', { tags: ['user:7'] });
    await engine.set({ store: 'other', key: 'k' }, 'b', { tags: ['user:7'] });
    await engine.invalidateTags(['user:7']);
    expect(await engine.get({ key: 'k' })).toBeUndefined();
    expect(await engine.get({ store: 'other', key: 'k' })).toBe('b');
    await engine.set({ key: 'k' }, 'a', { tags: ['user:7'] });
    await engine.invalidateTags(['user:7'], 'other');
    expect(await engine.get({ key: 'k' })).toBe('a');
    expect(await engine.get({ store: 'other', key: 'k' })).toBeUndefined();
  });

  it("invalidateTags(['a:b','ключ']) affects exactly those tags", async () => {
    /* Review Focus 5: tag text is not escaped. Tags that share a part with the invalidated ones
       (`a`, `b`, `a:b:c`, `ключ2`) keep their tokens. */
    const { engine } = setup();
    const tags = ['a:b', 'ключ', 'a', 'b', 'a:b:c', 'ключ2'];
    for (const tag of tags) await engine.set({ key: tag }, tag, { tags: [tag] });
    await engine.invalidateTags(['a:b', 'ключ']);
    const values = await Promise.all(tags.map(async (tag) => engine.get({ key: tag })));
    expect(values).toEqual([undefined, undefined, 'a', 'b', 'a:b:c', 'ключ2']);
  });

  it('a tag spanning two namespaces is invalidated in both', async () => {
    /* A tag belongs to the store: entries in a plain and a versioned namespace that carry it
       both become misses. */
    const store = new FakeStore();
    const { engine } = makeEngine({
      prefix: 'app',
      namespaces: { v: { versioned: true } },
      stores: { default: store },
    });
    await engine.set({ namespace: 'n', key: 'k' }, 1, { tags: ['t'] });
    await engine.set({ namespace: 'v', key: 'k' }, 2, { tags: ['t'] });
    await engine.set({ namespace: 'v', key: 'j' }, 3, { tags: ['u'] });
    await engine.invalidateTags(['t']);
    expect(await engine.get({ namespace: 'n', key: 'k' })).toBeUndefined();
    expect(await engine.getMany({ namespace: 'v' }, ['k', 'j'])).toEqual([undefined, 3]);
  });

  it('a token write failure: invalidateTags tries every tag, then rejects with the first error, and emits version errors', async () => {
    /* Spec 3.4: every tag is bumped; the failing ones keep their old token. The call reports
       one `version` error and rejects with the first failing tag's error (input order). */
    const store = new FailingWrites();
    const { engine, emitted, token } = setup(store);
    for (const tag of ['a', 'b', 'c', 'd']) await engine.set({ key: tag }, tag, { tags: [tag] });
    const before = { b: token('b'), c: token('c') };
    const first = new Error('b write failed');
    store.failing.set('app:__tag__:b', first);
    store.failing.set('app:__tag__:c', new Error('c write failed'));
    emitted.length = 0;
    await expect(engine.invalidateTags(['a', 'b', 'c', 'd'])).rejects.toBe(first);
    expect(emitted).toEqual([
      { event: 'error', payload: { store: 'default', operation: 'version', error: first } },
    ]);
    expect({ b: token('b'), c: token('c') }).toEqual(before);
    const values = await Promise.all(['a', 'b', 'c', 'd'].map((key) => engine.get({ key })));
    expect(values).toEqual([undefined, 'b', 'c', undefined]);
  });
});
