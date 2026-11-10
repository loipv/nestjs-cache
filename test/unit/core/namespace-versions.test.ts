import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NamespaceVersions,
  VERSION_KEY_TTL,
  newVersionToken,
  versionKey,
} from '../../../src/core/namespace-versions.js';
import { CacheConfigError } from '../../../src/errors.js';
import { resolveOptions } from '../../../src/module/cache.options.js';
import { FakeStore } from '../helpers/fake-store.js';

const TOKEN = /^[0-9a-z]{8}$/;

function setup(cacheTtl = 1000): { store: FakeStore; versions: NamespaceVersions } {
  return {
    store: new FakeStore(),
    versions: new NamespaceVersions('app', new Set(['users']), cacheTtl),
  };
}

describe('NamespaceVersions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds the version key and tokens', () => {
    /* Version keys live in the reserved __version__ namespace; tokens are 8 base36 chars. */
    expect(versionKey('app', 'users')).toBe('app:__version__:users');
    expect(versionKey(undefined, 'users')).toBe('__version__:users');
    for (let i = 0; i < 200; i++) expect(newVersionToken()).toMatch(TOKEN);
  });

  it('isVersioned is true only for configured names', () => {
    /* Exact match only; sub-namespaces and undefined are not versioned. */
    const { versions } = setup();
    expect(versions.isVersioned('users')).toBe(true);
    expect(versions.isVersioned('users:admin')).toBe(false);
    expect(versions.isVersioned(undefined)).toBe(false);
  });

  it('reads the version once and caches it for cacheTtl', async () => {
    /* Two calls within cacheTtl hit the store once; after cacheTtl a second get happens. */
    const { store, versions } = setup();
    const target = { name: 'default', store };
    store.data.set('app:__version__:users', { value: 'abc12345', ttlMs: 1 });
    expect(await versions.current(target, 'users')).toBe('abc12345');
    expect(await versions.current(target, 'users')).toBe('abc12345');
    expect(store.calls.filter((c) => c.op === 'get')).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    await versions.current(target, 'users');
    expect(store.calls.filter((c) => c.op === 'get')).toHaveLength(2);
  });

  it('concurrent cold reads share one store read', async () => {
    /* 100 parallel current calls with an empty cache cause exactly one get. */
    const { store, versions } = setup();
    store.data.set('app:__version__:users', { value: 'abc12345', ttlMs: 1 });
    const target = { name: 'default', store };
    const results = await Promise.all(
      Array.from({ length: 100 }, () => versions.current(target, 'users')),
    );
    expect(new Set(results)).toEqual(new Set(['abc12345']));
    expect(store.calls.filter((c) => c.op === 'get')).toHaveLength(1);
  });

  it('a missing version key is created and read back', async () => {
    /* get undefined -> set token with 30d ttl -> get again; the read-back value wins. */
    const { store, versions } = setup();
    const target = { name: 'default', store };
    const gets: (string | undefined)[] = [];
    const realGet = store.get.bind(store);
    store.get = async (key: string) => {
      const v = await realGet(key);
      gets.push(v);
      return v;
    };
    const token = await versions.current(target, 'users');
    const set = store.calls.find((c) => c.op === 'set');
    expect(set?.args[0]).toBe('app:__version__:users');
    expect(set?.args[1]).toMatch(TOKEN);
    expect(set?.args[2]).toBe(2_592_000_000);
    expect(VERSION_KEY_TTL).toBe(2_592_000_000);
    expect(gets).toEqual([undefined, set?.args[1]]);
    expect(token).toBe(set?.args[1]);

    /* A concurrent creator that wins the race: the read-back token is used. */
    const other = setup();
    const t2 = { name: 'default', store: other.store };
    const origSet = other.store.set.bind(other.store);
    other.store.set = async (k: string, v: string, ttl: number) => {
      await origSet(k, v, ttl);
      await origSet(k, 'winner12', ttl);
    };
    expect(await other.versions.current(t2, 'users')).toBe('winner12');
  });

  it('bump writes a new token and caches it at once', async () => {
    /* After bump, current returns the new token without a get, and it differs from before. */
    const { store, versions } = setup();
    const target = { name: 'default', store };
    const before = await versions.current(target, 'users');
    const gets = store.calls.filter((c) => c.op === 'get').length;
    await versions.bump(target, 'users');
    const after = await versions.current(target, 'users');
    expect(after).toMatch(TOKEN);
    expect(after).not.toBe(before);
    expect(store.data.get('app:__version__:users')).toEqual({
      value: after,
      ttlMs: VERSION_KEY_TTL,
    });
    expect(store.calls.filter((c) => c.op === 'get')).toHaveLength(gets);
  });

  it('a failing read rejects and caches nothing', async () => {
    /* A rejected cold read rejects every waiter; the next call reads again. */
    const { store, versions } = setup();
    const target = { name: 'default', store };
    store.data.set('app:__version__:users', { value: 'abc12345', ttlMs: 1 });
    store.failNext('get');
    const a = versions.current(target, 'users');
    const b = versions.current(target, 'users');
    await expect(a).rejects.toThrow('get failed');
    await expect(b).rejects.toThrow('get failed');
    expect(await versions.current(target, 'users')).toBe('abc12345');
    expect(store.calls.filter((c) => c.op === 'get')).toHaveLength(2);
  });

  it('a failing bump rejects and keeps the cached token', async () => {
    /* A failed set leaves the previously cached token in place. */
    const { store, versions } = setup();
    const target = { name: 'default', store };
    const before = await versions.current(target, 'users');
    store.failNext('set');
    await expect(versions.bump(target, 'users')).rejects.toThrow('set failed');
    expect(await versions.current(target, 'users')).toBe(before);
  });

  it('a bump during an in-flight read is not overwritten by the older read', async () => {
    /* The stale read result must not replace the bumped token in the cache. */
    const { store, versions } = setup();
    const target = { name: 'default', store };
    store.data.set('app:__version__:users', { value: 'old12345', ttlMs: 1 });
    const pending = versions.current(target, 'users');
    await versions.bump(target, 'users');
    await pending;
    const now = await versions.current(target, 'users');
    expect(now).toBe(store.data.get('app:__version__:users')?.value);
  });

  it('fresh always reads the store and refreshes the cache', async () => {
    /* Another instance changed the token: current keeps serving the cached one, fresh reads
       the store anyway, and current then serves the fresh token without a get. */
    const { store, versions } = setup();
    const target = { name: 'default', store };
    const gets = (): number => store.calls.filter((c) => c.op === 'get').length;
    expect(versions.cached(target, 'users')).toBeUndefined();
    store.data.set('app:__version__:users', { value: 'old12345', ttlMs: 1 });
    expect(await versions.current(target, 'users')).toBe('old12345');
    store.data.set('app:__version__:users', { value: 'new12345', ttlMs: 1 });
    expect(await versions.current(target, 'users')).toBe('old12345');
    expect(versions.cached(target, 'users')).toBe('old12345');
    expect(gets()).toBe(1);
    vi.advanceTimersByTime(500);
    expect(await versions.fresh(target, 'users')).toBe('new12345');
    expect(gets()).toBe(2);
    expect(versions.cached(target, 'users')).toBe('new12345');
    /* The refreshed entry lives cacheTtl from the fresh read. */
    vi.advanceTimersByTime(999);
    expect(await versions.current(target, 'users')).toBe('new12345');
    expect(gets()).toBe(2);
    vi.advanceTimersByTime(1);
    await versions.current(target, 'users');
    expect(gets()).toBe(3);
  });

  it('fresh creates a missing version key and reads it back', async () => {
    /* Same as current: set a new token with the 30 day ttl, then get it again. */
    const { store, versions } = setup();
    const target = { name: 'default', store };
    const token = await versions.fresh(target, 'users');
    expect(token).toMatch(TOKEN);
    expect(store.calls.map((c) => c.op)).toEqual(['get', 'set', 'get']);
    expect(store.data.get('app:__version__:users')).toEqual({
      value: token,
      ttlMs: VERSION_KEY_TTL,
    });
  });

  it('a fresh read racing a bump keeps the bumped token', async () => {
    /* The fresh read started before the bump finished after it: the cache keeps the bumped
       token, and current serves it without another get. */
    const { store, versions } = setup();
    const target = { name: 'default', store };
    store.data.set('app:__version__:users', { value: 'old12345', ttlMs: 1 });
    const pending = versions.fresh(target, 'users');
    await versions.bump(target, 'users');
    expect(await pending).toBe('old12345');
    const bumped = store.data.get('app:__version__:users')?.value;
    expect(versions.cached(target, 'users')).toBe(bumped);
    const gets = store.calls.filter((c) => c.op === 'get').length;
    expect(await versions.current(target, 'users')).toBe(bumped);
    expect(store.calls.filter((c) => c.op === 'get')).toHaveLength(gets);
  });

  it('a failing fresh read rejects and keeps the cached token', async () => {
    /* The store rejects: fresh rejects and the cache is left as it was. */
    const { store, versions } = setup();
    const target = { name: 'default', store };
    store.data.set('app:__version__:users', { value: 'abc12345', ttlMs: 1 });
    await versions.current(target, 'users');
    store.failNext('get');
    await expect(versions.fresh(target, 'users')).rejects.toThrow('get failed');
    expect(versions.cached(target, 'users')).toBe('abc12345');
  });
});

describe('versioning options', () => {
  it('defaults', () => {
    /* No namespaces means an empty set and a 1s version cache. */
    const r = resolveOptions();
    expect(r.versionedNamespaces.size).toBe(0);
    expect(r.versionCacheTtl).toBe(1000);
  });

  it('collects only namespaces with versioned: true', () => {
    /* versioned:false and omitted flags are not versioned. */
    const r = resolveOptions({
      namespaces: { users: { versioned: false }, posts: { versioned: true }, tags: {} },
      versioning: { cacheTtl: 50 },
    });
    expect([...r.versionedNamespaces]).toEqual(['posts']);
    expect(r.versionCacheTtl).toBe(50);
  });

  it.each([
    [{ namespaces: 5 }, 'Invalid cache option namespaces: 5 (must be an object)'],
    [{ namespaces: { a: 5 } }, 'Invalid cache option namespaces.a: 5 (must be an object)'],
    [
      { namespaces: { a: { versioned: 'x' } } },
      'Invalid cache option namespaces.a.versioned: x (must be a boolean)',
    ],
    [
      { namespaces: { __a: { versioned: true } } },
      'Invalid cache option namespaces: __a (names starting with "__" are reserved)',
    ],
    [{ versioning: 5 }, 'Invalid cache option versioning: 5 (must be an object)'],
    [
      { versioning: { cacheTtl: 0 } },
      'Invalid cache option versioning.cacheTtl: 0 (must be a finite number between 1 and 2147483647)',
    ],
    [
      { versioning: { cacheTtl: 2147483648 } },
      'Invalid cache option versioning.cacheTtl: 2147483648 (must be a finite number between 1 and 2147483647)',
    ],
    [
      { versioning: { cacheTtl: NaN } },
      'Invalid cache option versioning.cacheTtl: NaN (must be a finite number between 1 and 2147483647)',
    ],
  ])('rejects %j', (options, message) => {
    /* Each invalid shape throws CacheConfigError with the exact message. */
    expect(() => resolveOptions(options as never)).toThrow(new CacheConfigError(message));
  });
});
