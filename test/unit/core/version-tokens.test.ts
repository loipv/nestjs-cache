import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TAG_TOKENS,
  VERSION_KEY_TTL,
  VersionTokens,
  tokenKey,
} from '../../../src/core/version-tokens.js';
import { FakeStore } from '../helpers/fake-store.js';

const TOKEN = /^[0-9a-z]{8}$/;

function setup(cacheTtl = 1000): {
  store: FakeStore;
  tokens: VersionTokens;
  target: { name: string; store: FakeStore };
} {
  const store = new FakeStore();
  return { store, tokens: new VersionTokens('app', cacheTtl), target: { name: 'default', store } };
}

function ops(store: FakeStore, op: string, key?: string): number {
  return store.calls.filter((c) => c.op === op && (key === undefined || c.args[0] === key)).length;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('VersionTokens', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tag tokens live under __tag__ and namespace tokens under __version__', async () => {
    /* tokenKey keeps the 0.4 namespace key and puts tags in __tag__; a namespace and a tag of
       the same name get separate keys and separate tokens. */
    expect(tokenKey('app', 'ns', 'users')).toBe('app:__version__:users');
    expect(tokenKey(undefined, 'ns', 'users')).toBe('__version__:users');
    expect(tokenKey('app', 'tag', 'users')).toBe('app:__tag__:users');
    expect(tokenKey(undefined, 'tag', 'users')).toBe('__tag__:users');
    const { store, tokens, target } = setup();
    const ns = await tokens.current(target, 'ns', 'users');
    const tag = await tokens.current(target, 'tag', 'users');
    expect(ns).toMatch(TOKEN);
    expect(tag).toMatch(TOKEN);
    expect(ns).not.toBe(tag);
    expect(store.data.get('app:__version__:users')).toEqual({ value: ns, ttlMs: VERSION_KEY_TTL });
    expect(store.data.get('app:__tag__:users')).toEqual({ value: tag, ttlMs: VERSION_KEY_TTL });
    expect(tokens.cached(target, 'ns', 'users')).toBe(ns);
    expect(tokens.cached(target, 'tag', 'users')).toBe(tag);
    /* A tag bump leaves the namespace token alone. */
    await tokens.bump(target, 'tag', 'users');
    expect(tokens.cached(target, 'ns', 'users')).toBe(ns);
    expect(tokens.cached(target, 'tag', 'users')).not.toBe(tag);
    expect(await tokens.fresh(target, 'ns', 'users')).toBe(ns);
  });

  it('currentMany serves cached tokens without touching the store', async () => {
    /* Both tags are cached by ensureMany; currentMany within cacheTtl makes 0 store calls,
       strict or not. */
    const { store, tokens, target } = setup();
    const getStrict = vi.fn((key: string) => Promise.resolve(store.data.get(key)?.value));
    const getMany = vi.fn((keys: readonly string[]) =>
      Promise.resolve(keys.map((key) => store.data.get(key)?.value)),
    );
    const ensured = await tokens.ensureMany(target, 'tag', ['a', 'b']);
    store.calls.length = 0;
    const strict = { name: 'default', store: Object.assign(store, { getStrict, getMany }) };
    vi.advanceTimersByTime(999);
    const current = await tokens.currentMany(strict, 'tag', ['a', 'b', 'a']);
    expect(current).toEqual(ensured);
    expect([...current.keys()]).toEqual(['a', 'b']);
    expect(store.calls).toEqual([]);
    expect(getStrict).not.toHaveBeenCalled();
    expect(getMany).not.toHaveBeenCalled();
  });

  it('currentMany reads missing names with getStrict in parallel when available, else one getMany', async () => {
    /* Strict store: one getStrict per missing name, all started before any resolves, and a
       cached name is not read. Plain store with getMany: one getMany for every missing name.
       Plain store without either: one get per missing name. Read tokens are cached. */
    const strictSetup = setup();
    const store = strictSetup.store;
    store.data.set('app:__tag__:a', { value: 'aaaaaaaa', ttlMs: 1 });
    store.data.set('app:__tag__:b', { value: 'bbbbbbbb', ttlMs: 1 });
    store.data.set('app:__tag__:c', { value: 'cccccccc', ttlMs: 1 });
    await strictSetup.tokens.current(strictSetup.target, 'tag', 'c');
    const gates = new Map<string, ReturnType<typeof deferred<string | undefined>>>();
    const getStrict = vi.fn((key: string) => {
      const gate = deferred<string | undefined>();
      gates.set(key, gate);
      return gate.promise;
    });
    const strict = { name: 'default', store: Object.assign(store, { getStrict }) };
    const pending = strictSetup.tokens.currentMany(strict, 'tag', ['a', 'b', 'c']);
    await Promise.resolve();
    expect(getStrict.mock.calls).toEqual([['app:__tag__:a'], ['app:__tag__:b']]);
    for (const [key, gate] of gates) gate.resolve(store.data.get(key)?.value);
    expect(await pending).toEqual(
      new Map([
        ['a', 'aaaaaaaa'],
        ['b', 'bbbbbbbb'],
        ['c', 'cccccccc'],
      ]),
    );
    expect(strictSetup.tokens.cached(strict, 'tag', 'a')).toBe('aaaaaaaa');

    const plain = setup();
    plain.store.data.set('app:__tag__:a', { value: 'aaaaaaaa', ttlMs: 1 });
    const getMany = vi.fn((keys: readonly string[]) =>
      Promise.resolve(keys.map((key) => plain.store.data.get(key)?.value)),
    );
    const many = { name: 'default', store: Object.assign(plain.store, { getMany }) };
    expect(await plain.tokens.currentMany(many, 'tag', ['a', 'b'])).toEqual(
      new Map([
        ['a', 'aaaaaaaa'],
        ['b', undefined],
      ]),
    );
    expect(getMany.mock.calls).toEqual([[['app:__tag__:a', 'app:__tag__:b']]]);
    expect(plain.store.calls).toEqual([]);

    const bare = setup();
    bare.store.data.set('app:__tag__:b', { value: 'bbbbbbbb', ttlMs: 1 });
    expect(await bare.tokens.currentMany(bare.target, 'tag', ['a', 'b'])).toEqual(
      new Map([
        ['a', undefined],
        ['b', 'bbbbbbbb'],
      ]),
    );
    expect(bare.store.calls.map((c) => [c.op, c.args[0]])).toEqual([
      ['get', 'app:__tag__:a'],
      ['get', 'app:__tag__:b'],
    ]);
    /* An empty list makes no call. */
    expect(await bare.tokens.currentMany(bare.target, 'tag', [])).toEqual(new Map());
    expect(bare.store.calls).toHaveLength(2);
  });

  it("currentMany never creates a token and maps '' to undefined", async () => {
    /* A missing key and an empty one both map to undefined, nothing is written, and neither
       is cached: the next call reads the store again. A rejected read rejects the call. */
    const { store, tokens, target } = setup();
    store.data.set('app:__tag__:empty', { value: '', ttlMs: 1 });
    const current = await tokens.currentMany(target, 'tag', ['missing', 'empty']);
    expect(current).toEqual(
      new Map([
        ['missing', undefined],
        ['empty', undefined],
      ]),
    );
    expect(ops(store, 'set')).toBe(0);
    expect(tokens.cached(target, 'tag', 'missing')).toBeUndefined();
    expect(tokens.cached(target, 'tag', 'empty')).toBeUndefined();
    await tokens.currentMany(target, 'tag', ['missing']);
    expect(ops(store, 'get', 'app:__tag__:missing')).toBe(2);

    store.failNext('get');
    await expect(tokens.currentMany(target, 'tag', ['missing', 'empty'])).rejects.toThrow(
      'get failed',
    );
    const getMany = vi.fn(() => Promise.reject(new Error('getMany failed')));
    const many = { name: 'default', store: Object.assign(store, { getMany }) };
    await expect(tokens.currentMany(many, 'tag', ['x'])).rejects.toThrow('getMany failed');
    const getStrict = vi.fn(() => Promise.reject(new Error('l2 down')));
    const strict = { name: 'default', store: Object.assign(store, { getStrict }) };
    await expect(tokens.currentMany(strict, 'tag', ['x', 'y'])).rejects.toThrow('l2 down');
    expect(ops(store, 'set')).toBe(0);
  });

  it('currentMany does not cache a token read while a bump or a fresh read completed', async () => {
    /* The read is held until a bump has finished: it returns the old token it saw, and the
       cache keeps the bump's newer token. The same holds for a fresh read finishing first. */
    const { store, tokens } = setup();
    store.data.set('app:__tag__:a', { value: 'old12345', ttlMs: 1 });
    const gates: ReturnType<typeof deferred<undefined>>[] = [];
    const getStrict = vi.fn(async (key: string) => {
      const seen = store.data.get(key)?.value;
      const gate = deferred<undefined>();
      gates.push(gate);
      await gate.promise;
      return seen;
    });
    const strict = { name: 'default', store: Object.assign(store, { getStrict }) };
    const pending = tokens.currentMany(strict, 'tag', ['a']);
    await tokens.bump(strict, 'tag', 'a');
    const bumped = store.data.get('app:__tag__:a')?.value;
    gates[0]?.resolve(undefined);
    expect((await pending).get('a')).toBe('old12345');
    expect(tokens.cached(strict, 'tag', 'a')).toBe(bumped);

    vi.advanceTimersByTime(1000);
    const again = tokens.currentMany(strict, 'tag', ['a']);
    store.data.set('app:__tag__:a', { value: 'new12345', ttlMs: 1 });
    const fresh = tokens.fresh(strict, 'tag', 'a');
    gates[2]?.resolve(undefined);
    expect(await fresh).toBe('new12345');
    gates[1]?.resolve(undefined);
    expect((await again).get('a')).toBe(bumped);
    expect(tokens.cached(strict, 'tag', 'a')).toBe('new12345');
  });

  it('a currentMany read keeps its token over an older in-flight current read', async () => {
    /* A current read saw the old token and is still in flight when another instance changes
       the key; currentMany reads the new token, and the older read finishing later must not
       replace it in the cache. */
    const { store, tokens, target } = setup();
    store.data.set('app:__tag__:a', { value: 'old12345', ttlMs: 1 });
    const gate = deferred<undefined>();
    const realGet = store.get.bind(store);
    let held = true;
    store.get = (key: string) => {
      const seen = store.data.get(key)?.value;
      if (!held) return realGet(key);
      held = false;
      return gate.promise.then(() => seen);
    };
    const slow = tokens.current(target, 'tag', 'a');
    store.data.set('app:__tag__:a', { value: 'new12345', ttlMs: 1 });
    expect((await tokens.currentMany(target, 'tag', ['a'])).get('a')).toBe('new12345');
    gate.resolve(undefined);
    expect(await slow).toBe('old12345');
    expect(tokens.cached(target, 'tag', 'a')).toBe('new12345');
  });

  it('ensureMany creates tokens for missing names and shares in-flight reads with current', async () => {
    /* `a` exists, `b` is missing. A current read of `b` is in flight when ensureMany starts:
       `b` is read, created and read back once, `a` is read once, and both are cached. */
    const { store, tokens, target } = setup();
    store.data.set('app:__tag__:a', { value: 'aaaaaaaa', ttlMs: 1 });
    const inflight = tokens.current(target, 'tag', 'b');
    const ensured = await tokens.ensureMany(target, 'tag', ['a', 'b', 'b']);
    const b = await inflight;
    expect(b).toMatch(TOKEN);
    expect(ensured).toEqual(
      new Map([
        ['a', 'aaaaaaaa'],
        ['b', b],
      ]),
    );
    expect(ops(store, 'get', 'app:__tag__:a')).toBe(1);
    expect(ops(store, 'get', 'app:__tag__:b')).toBe(2);
    expect(ops(store, 'set', 'app:__tag__:b')).toBe(1);
    expect(store.data.get('app:__tag__:b')).toEqual({ value: b, ttlMs: VERSION_KEY_TTL });
    expect(await tokens.currentMany(target, 'tag', ['a', 'b'])).toEqual(ensured);
    expect(store.calls).toHaveLength(4);

    /* A failing read rejects the whole call. */
    store.failNext('get');
    await expect(tokens.ensureMany(target, 'tag', ['c'])).rejects.toThrow('get failed');
  });

  it('bumpMany writes every name, caches the new tokens and rejects with the first error after trying all', async () => {
    /* All three tags are written with a new token and the 30 day ttl, through setStrict when
       the store has it; the new tokens are served from the cache. With two failing writes,
       every name is still tried, the call rejects with the first name's error, the failed
       names keep their old token and the successful one is cached. */
    const { store, tokens, target } = setup();
    const before = await tokens.ensureMany(target, 'tag', ['a', 'b', 'c']);
    store.calls.length = 0;
    await tokens.bumpMany(target, 'tag', ['a', 'b', 'c', 'a']);
    expect(store.calls.map((c) => [c.op, c.args[0], c.args[2]])).toEqual([
      ['set', 'app:__tag__:a', VERSION_KEY_TTL],
      ['set', 'app:__tag__:b', VERSION_KEY_TTL],
      ['set', 'app:__tag__:c', VERSION_KEY_TTL],
    ]);
    const after = await tokens.currentMany(target, 'tag', ['a', 'b', 'c']);
    for (const name of ['a', 'b', 'c']) {
      expect(after.get(name)).toMatch(TOKEN);
      expect(after.get(name)).not.toBe(before.get(name));
      expect(after.get(name)).toBe(store.data.get(`app:__tag__:${name}`)?.value);
    }
    expect(ops(store, 'get')).toBe(0);

    const first = new Error('first');
    const second = new Error('second');
    const setStrict = vi.fn((key: string, value: string, ttlMs: number) => {
      if (key === 'app:__tag__:a') return Promise.reject(first);
      if (key === 'app:__tag__:c') return Promise.reject(second);
      store.data.set(key, { value, ttlMs });
      return Promise.resolve();
    });
    const strict = { name: 'default', store: Object.assign(store, { setStrict }) };
    await expect(tokens.bumpMany(strict, 'tag', ['a', 'b', 'c'])).rejects.toBe(first);
    expect(setStrict.mock.calls.map((c) => c[0])).toEqual([
      'app:__tag__:a',
      'app:__tag__:b',
      'app:__tag__:c',
    ]);
    expect(ops(store, 'set')).toBe(3);
    expect(tokens.cached(strict, 'tag', 'a')).toBe(after.get('a'));
    expect(tokens.cached(strict, 'tag', 'c')).toBe(after.get('c'));
    expect(tokens.cached(strict, 'tag', 'b')).not.toBe(after.get('b'));
    expect(tokens.cached(strict, 'tag', 'b')).toBe(store.data.get('app:__tag__:b')?.value);
  });

  it("tag names with ':' '%' and unicode round-trip into distinct keys", async () => {
    /* Tag text is used as is (no escaping): each name gets its own key, a bump of one leaves
       the others alone, and currentMany returns each name's own token. */
    const names = ['a:b', 'a', 'b', 'a%3Ab', '50%', 'ключ', '鍵'];
    expect(names.map((name) => tokenKey('app', 'tag', name))).toEqual([
      'app:__tag__:a:b',
      'app:__tag__:a',
      'app:__tag__:b',
      'app:__tag__:a%3Ab',
      'app:__tag__:50%',
      'app:__tag__:ключ',
      'app:__tag__:鍵',
    ]);
    const { store, tokens, target } = setup();
    const ensured = await tokens.ensureMany(target, 'tag', names);
    expect(new Set(ensured.values()).size).toBe(names.length);
    await tokens.bumpMany(target, 'tag', ['a:b', 'ключ']);
    vi.advanceTimersByTime(1000);
    const current = await tokens.currentMany(target, 'tag', names);
    for (const name of names) {
      expect(current.get(name)).toBe(store.data.get(tokenKey('app', 'tag', name))?.value);
      const bumped = name === 'a:b' || name === 'ключ';
      expect(current.get(name) === ensured.get(name)).toBe(!bumped);
    }
  });

  it('concurrent currentMany calls for the same cold tag issue one store read', async () => {
    /* 50 parallel currentMany calls for one uncached tag: one getStrict on a strict store, one
       getMany on a plain store; every caller gets the token, which is then cached. */
    const { store, tokens } = setup();
    store.data.set('app:__tag__:a', { value: 'aaaaaaaa', ttlMs: 1 });
    const getStrict = vi.fn((key: string) => Promise.resolve(store.data.get(key)?.value));
    const strict = { name: 'default', store: Object.assign(store, { getStrict }) };
    const results = await Promise.all(
      Array.from({ length: 50 }, () => tokens.currentMany(strict, 'tag', ['a'])),
    );
    expect(results.map((r) => r.get('a'))).toEqual(Array.from({ length: 50 }, () => 'aaaaaaaa'));
    expect(getStrict).toHaveBeenCalledOnce();
    expect(tokens.cached(strict, 'tag', 'a')).toBe('aaaaaaaa');

    const plain = setup();
    plain.store.data.set('app:__tag__:a', { value: 'aaaaaaaa', ttlMs: 1 });
    const getMany = vi.fn((keys: readonly string[]) =>
      Promise.resolve(keys.map((key) => plain.store.data.get(key)?.value)),
    );
    const many = { name: 'default', store: Object.assign(plain.store, { getMany }) };
    const plainResults = await Promise.all(
      Array.from({ length: 50 }, () => plain.tokens.currentMany(many, 'tag', ['a'])),
    );
    expect(new Set(plainResults.map((r) => r.get('a')))).toEqual(new Set(['aaaaaaaa']));
    expect(getMany.mock.calls).toEqual([[['app:__tag__:a']]]);
    expect(plain.store.calls).toEqual([]);
  });

  it('overlapping currentMany calls share reads for the common names only', async () => {
    /* [a, b] and then [b, c] while the first read is in flight: the second call joins the
       read of b and reads only c, so the store sees getMany([a, b]) and getMany([c]). */
    const { store, tokens } = setup();
    store.data.set('app:__tag__:a', { value: 'aaaaaaaa', ttlMs: 1 });
    store.data.set('app:__tag__:b', { value: 'bbbbbbbb', ttlMs: 1 });
    const gates: ReturnType<typeof deferred<undefined>>[] = [];
    const getMany = vi.fn(async (keys: readonly string[]) => {
      const gate = deferred<undefined>();
      gates.push(gate);
      await gate.promise;
      return keys.map((key) => store.data.get(key)?.value);
    });
    const target = { name: 'default', store: Object.assign(store, { getMany }) };
    const first = tokens.currentMany(target, 'tag', ['a', 'b']);
    const second = tokens.currentMany(target, 'tag', ['b', 'c']);
    expect(getMany.mock.calls).toEqual([[['app:__tag__:a', 'app:__tag__:b']], [['app:__tag__:c']]]);
    for (const gate of gates) gate.resolve(undefined);
    expect(await first).toEqual(
      new Map([
        ['a', 'aaaaaaaa'],
        ['b', 'bbbbbbbb'],
      ]),
    );
    expect(await second).toEqual(
      new Map([
        ['b', 'bbbbbbbb'],
        ['c', undefined],
      ]),
    );
    expect([...(await second).keys()]).toEqual(['b', 'c']);
  });

  it('a missing tag (undefined) is not cached', async () => {
    /* Concurrent reads of a missing tag share one read and all see undefined; nothing is
       cached, so a token created afterwards (by another instance) is seen by the next call. */
    const { store, tokens, target } = setup();
    const [x, y] = await Promise.all([
      tokens.currentMany(target, 'tag', ['a']),
      tokens.currentMany(target, 'tag', ['a']),
    ]);
    expect(x.get('a')).toBeUndefined();
    expect(y.get('a')).toBeUndefined();
    expect(ops(store, 'get', 'app:__tag__:a')).toBe(1);
    expect(tokens.cached(target, 'tag', 'a')).toBeUndefined();
    store.data.set('app:__tag__:a', { value: 'aaaaaaaa', ttlMs: 1 });
    expect((await tokens.currentMany(target, 'tag', ['a'])).get('a')).toBe('aaaaaaaa');
    expect(ops(store, 'get', 'app:__tag__:a')).toBe(2);
  });

  it('a rejected read rejects every waiter and is not cached', async () => {
    /* One getStrict rejects: the three concurrent callers sharing it all reject with that
       error, nothing is cached, and the next call reads the store again. */
    const { store, tokens } = setup();
    store.data.set('app:__tag__:a', { value: 'aaaaaaaa', ttlMs: 1 });
    const boom = new Error('l2 down');
    const getStrict = vi
      .fn((key: string) => Promise.resolve(store.data.get(key)?.value))
      .mockImplementationOnce(() => Promise.reject(boom));
    const target = { name: 'default', store: Object.assign(store, { getStrict }) };
    const waiters = Array.from({ length: 3 }, () => tokens.currentMany(target, 'tag', ['a']));
    for (const waiter of waiters) await expect(waiter).rejects.toBe(boom);
    expect(getStrict).toHaveBeenCalledOnce();
    expect(tokens.cached(target, 'tag', 'a')).toBeUndefined();
    expect((await tokens.currentMany(target, 'tag', ['a'])).get('a')).toBe('aaaaaaaa');
    expect(getStrict).toHaveBeenCalledTimes(2);
  });

  it('currentMany does not join an in-flight create', async () => {
    /* A current call is creating the missing token: currentMany issues its own plain read
       instead of joining the create, sees no token, and writes nothing itself. */
    const { store, tokens, target } = setup();
    const creating = tokens.current(target, 'tag', 'a');
    const current = await tokens.currentMany(target, 'tag', ['a']);
    expect(current.get('a')).toBeUndefined();
    const created = await creating;
    expect(ops(store, 'get', 'app:__tag__:a')).toBe(3);
    expect(ops(store, 'set', 'app:__tag__:a')).toBe(1);
    expect(tokens.cached(target, 'tag', 'a')).toBe(created);
  });

  it('the tag token cache never exceeds MAX_TAG_TOKENS and evicts the least recently refreshed first', async () => {
    /* Production cap is 10 000; the constructor seam sets 3. Tags a, b, c are cached, then a is
       refreshed by a bump, so d evicts b (the least recently refreshed), and e then evicts c.
       Namespace tokens are never capped. */
    expect(MAX_TAG_TOKENS).toBe(10_000);
    const store = new FakeStore();
    const target = { name: 'default', store };
    const tokens = new VersionTokens('app', 1000, 3);
    const cachedTags = (names: string[]): string[] =>
      names.filter((name) => tokens.cached(target, 'tag', name) !== undefined);
    await tokens.ensureMany(target, 'tag', ['a', 'b', 'c']);
    await tokens.bump(target, 'tag', 'a');
    await tokens.ensureMany(target, 'tag', ['d']);
    expect(cachedTags(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'c', 'd']);
    store.data.set('app:__tag__:e', { value: 'eeeeeeee', ttlMs: 1 });
    await tokens.currentMany(target, 'tag', ['e']);
    expect(cachedTags(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'd', 'e']);
    await tokens.ensureMany(target, 'tag', ['f', 'g', 'h', 'i']);
    expect(cachedTags(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])).toEqual(['g', 'h', 'i']);

    const namespaces = ['n1', 'n2', 'n3', 'n4', 'n5'];
    for (const ns of namespaces) await tokens.current(target, 'ns', ns);
    expect(namespaces.filter((ns) => tokens.cached(target, 'ns', ns) !== undefined)).toEqual(
      namespaces,
    );
  });

  it('an expired tag token is kept as a fallback until evicted by the cap', async () => {
    /* Long past cacheTtl the token is still known to cached(); a failing currentMany read leaves
       it in place; only the cap evicts it. */
    const store = new FakeStore();
    const target = { name: 'default', store };
    const tokens = new VersionTokens('app', 1000, 2);
    const token = await tokens.current(target, 'tag', 'a');
    vi.advanceTimersByTime(60_000);
    expect(tokens.cached(target, 'tag', 'a')).toBe(token);
    store.failNext('get');
    await expect(tokens.currentMany(target, 'tag', ['a'])).rejects.toThrow('get failed');
    expect(tokens.cached(target, 'tag', 'a')).toBe(token);
    await tokens.ensureMany(target, 'tag', ['b', 'c']);
    expect(tokens.cached(target, 'tag', 'a')).toBeUndefined();
  });

  it('a tag read as missing removes its cached token', async () => {
    /* The tag key was deleted (clear or TTL): once the cached token expires, currentMany reads
       undefined and drops the cached token, for an empty key as well. A missing namespace read
       through currentMany keeps its token (namespace behaviour is unchanged). */
    const { store, tokens, target } = setup();
    await tokens.ensureMany(target, 'tag', ['a', 'b']);
    await tokens.current(target, 'ns', 'n');
    store.data.delete('app:__tag__:a');
    store.data.set('app:__tag__:b', { value: '', ttlMs: 1 });
    store.data.delete('app:__version__:n');
    vi.advanceTimersByTime(1000);
    expect(await tokens.currentMany(target, 'tag', ['a', 'b'])).toEqual(
      new Map([
        ['a', undefined],
        ['b', undefined],
      ]),
    );
    expect(tokens.cached(target, 'tag', 'a')).toBeUndefined();
    expect(tokens.cached(target, 'tag', 'b')).toBeUndefined();
    expect((await tokens.currentMany(target, 'ns', ['n'])).get('n')).toBeUndefined();
    expect(tokens.cached(target, 'ns', 'n')).toBeDefined();
  });

  it('bump counters do not accumulate per tag', async () => {
    /* 100 distinct tags bumped with no fresh read in flight leave no counter. A bump during a
       fresh read is counted while that read is in flight (the bump's token wins), and the
       counter is removed when the last fresh read of the tag ends. */
    const { store, tokens, target } = setup();
    const names = Array.from({ length: 100 }, (_, i) => `user:${String(i)}`);
    await tokens.bumpMany(target, 'tag', names);
    await tokens.bump(target, 'ns', 'n');
    expect(tokens.bumpCounts('tag').size).toBe(0);
    expect(tokens.bumpCounts('ns').size).toBe(0);

    store.data.set('app:__tag__:a', { value: 'old12345', ttlMs: 1 });
    const realGet = store.get.bind(store);
    const holdNext = (fail: boolean): ReturnType<typeof deferred<undefined>> => {
      const gate = deferred<undefined>();
      store.get = (key: string) => {
        store.get = realGet;
        const seen = store.data.get(key)?.value;
        return gate.promise.then(() => {
          if (fail) throw new Error('get failed');
          return seen;
        });
      };
      return gate;
    };
    const gate = holdNext(false);
    const fresh = tokens.fresh(target, 'tag', 'a');
    await tokens.bump(target, 'tag', 'a');
    expect(tokens.bumpCounts('tag').get('default\u0000a')).toBe(1);
    const bumped = store.data.get('app:__tag__:a')?.value;
    gate.resolve(undefined);
    expect(await fresh).toBe('old12345');
    expect(tokens.cached(target, 'tag', 'a')).toBe(bumped);
    expect(tokens.bumpCounts('tag').size).toBe(0);

    /* A rejected fresh read removes the counter as well. */
    const failGate = holdNext(true);
    const failing = tokens.fresh(target, 'tag', 'a');
    await tokens.bump(target, 'tag', 'a');
    expect(tokens.bumpCounts('tag').size).toBe(1);
    failGate.resolve(undefined);
    await expect(failing).rejects.toThrow('get failed');
    expect(tokens.bumpCounts('tag').size).toBe(0);

    /* Overlapping fresh reads: the counter stays until the last one ends, so the older read
       (which saw the token before the bump) still caches nothing. */
    const slowGate = holdNext(false);
    const slow = tokens.fresh(target, 'tag', 'a');
    const before = store.data.get('app:__tag__:a')?.value;
    await tokens.bump(target, 'tag', 'a');
    const latest = store.data.get('app:__tag__:a')?.value;
    expect(await tokens.fresh(target, 'tag', 'a')).toBe(latest);
    expect(tokens.bumpCounts('tag').get('default\u0000a')).toBe(1);
    slowGate.resolve(undefined);
    expect(await slow).toBe(before);
    expect(tokens.cached(target, 'tag', 'a')).toBe(latest);
    expect(tokens.bumpCounts('tag').size).toBe(0);
  });
});
