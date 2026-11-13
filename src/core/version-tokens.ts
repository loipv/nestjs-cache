import { randomUUID } from 'node:crypto';
import type { CacheStore } from '../stores/cache-store.interface.js';
import type { Target } from './engine-keys.js';
import { fullKey } from './key-builder.js';

/** What a token versions: a versioned namespace or a cache tag. */
export type TokenKind = 'ns' | 'tag';

/** 30 days; a token key outlives any data written under its token. */
export const VERSION_KEY_TTL = 2_592_000_000;

/**
 * Internal: the most tag tokens one instance keeps cached. Tags are user-controlled and can be
 * high-cardinality (`user:<id>`), so the least recently refreshed are evicted beyond it.
 * Namespace tokens are not capped.
 */
export const MAX_TAG_TOKENS = 10_000;

const KIND_NAMESPACE: Readonly<Record<TokenKind, string>> = { ns: '__version__', tag: '__tag__' };

/**
 * `<prefix>:__version__:<name>` for a namespace (unchanged since 0.4), `<prefix>:__tag__:<name>`
 * for a tag. The name is used as is, without escaping.
 */
export function tokenKey(prefix: string | undefined, kind: TokenKind, name: string): string {
  return fullKey(prefix, KIND_NAMESPACE[kind], name);
}

/** The key prefixes of the tokens under `prefix`: `<prefix>:__version__:`, `<prefix>:__tag__:`. */
export function tokenKeyPrefixes(prefix: string | undefined): string[] {
  return [tokenKey(prefix, 'ns', ''), tokenKey(prefix, 'tag', '')].map((k) => `${k}:`);
}

/** 8 base36 characters derived from a random UUID. */
export function newVersionToken(): string {
  const n = BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`);
  return n.toString(36).padStart(8, '0').slice(-8);
}

interface Cached {
  token: string;
  until: number;
}

/** The tokens of one kind, each map keyed by `<store>\0<name>`. */
interface KindState {
  readonly kind: TokenKind;
  /**
   * Cached tokens, least recently refreshed first. Expired entries stay (a strict store falls
   * back to them when a read fails); for tags only the cap evicts them.
   */
  readonly cache: Map<string, Cached>;
  /** The most entries `cache` keeps. */
  readonly limit: number;
  /**
   * In-flight read-or-create calls (`current`). `fresh` does not register, but it and `bump`
   * drop the slot's entry so an older read cannot replace the newer token.
   */
  readonly inflight: Map<string, Promise<string>>;
  /**
   * In-flight plain reads (`currentMany`), which never create. A read caches its token only
   * while it is still registered here; a bump or a fresh read unregisters it.
   */
  readonly reads: Map<string, Promise<string | undefined>>;
  /**
   * Per slot, the bumps that completed while a `fresh` read of it was in flight (a `fresh` that
   * sees the count change caches nothing). Counted and kept only while `freshes` has the slot.
   */
  readonly bumps: Map<string, number>;
  /** `fresh` reads in flight per slot. */
  readonly freshes: Map<string, number>;
  /**
   * When each slot was last allowed a re-read (`mayRecheck`), oldest first; capped at `limit`.
   */
  readonly rechecked: Map<string, number>;
  /** In-flight re-reads (`recheck`), one per slot; a bump unregisters the slot's. */
  readonly rechecks: Map<string, Promise<string | undefined>>;
}

function newState(kind: TokenKind, limit: number): KindState {
  return {
    kind,
    cache: new Map(),
    limit,
    inflight: new Map(),
    reads: new Map(),
    bumps: new Map(),
    freshes: new Map(),
    rechecked: new Map(),
    rechecks: new Map(),
  };
}

function slot(target: Target, name: string): string {
  return `${target.name}\u0000${name}`;
}

/**
 * Version tokens per (store, kind, name), for versioned namespaces (`'ns'`) and cache tags
 * (`'tag'`). Emits nothing; store failures reject. A token key is read with `getStrict` and
 * written with `setStrict` when the store has them (a tiered store), so a token is never created
 * or changed in L1 alone while L2 is down. An empty token key counts as missing.
 */
export class VersionTokens {
  private readonly kinds: Readonly<Record<TokenKind, KindState>>;

  /** `maxTagTokens` is `MAX_TAG_TOKENS` outside tests. */
  constructor(
    private readonly prefix: string | undefined,
    private readonly cacheTtl: number,
    maxTagTokens = MAX_TAG_TOKENS,
  ) {
    this.kinds = { ns: newState('ns', Infinity), tag: newState('tag', maxTagTokens) };
  }

  /** The bump counts `fresh` reads in flight compare, keyed by `<store>\0<name>`. */
  bumpCounts(kind: TokenKind): ReadonlyMap<string, number> {
    return this.kinds[kind].bumps;
  }

  /**
   * The token of `name`: cached for `cacheTtl`, else read from the store, and created when the
   * key is missing. Concurrent reads of one name share one store read.
   */
  current(target: Target, kind: TokenKind, name: string): Promise<string> {
    const state = this.kinds[kind];
    const k = slot(target, name);
    const cached = state.cache.get(k);
    if (cached !== undefined && Date.now() < cached.until) return Promise.resolve(cached.token);
    const running = state.inflight.get(k);
    if (running !== undefined) return running;
    const promise = this.read(target, kind, name).then(
      (token) => {
        // A bump while this read was in flight removed the entry; keep the newer token.
        if (state.inflight.get(k) === promise) {
          state.inflight.delete(k);
          // An older plain read may have seen the key missing; it must not drop this token.
          state.reads.delete(k);
          this.remember(state, k, token);
        }
        return token;
      },
      (error: unknown) => {
        if (state.inflight.get(k) === promise) state.inflight.delete(k);
        throw error;
      },
    );
    state.inflight.set(k, promise);
    return promise;
  }

  /** The token this instance has cached, even past `cacheTtl`; never reads the store. */
  cached(target: Target, kind: TokenKind, name: string): string | undefined {
    return this.kinds[kind].cache.get(slot(target, name))?.token;
  }

  /**
   * Reads the token from the store (creating it when missing), bypassing the cache, then caches
   * it for `cacheTtl`. A bump that completes during the read keeps its token in the cache.
   */
  async fresh(target: Target, kind: TokenKind, name: string): Promise<string> {
    return (await this.readFresh(target, kind, name, true)) as string;
  }

  /**
   * Whether `name` may be re-read now (spec 3.3 step 3): true at most once per `cacheTtl` per
   * (store, name), and the time is recorded. The record keeps at most as many slots as the
   * token cache (`MAX_TAG_TOKENS` for tags), evicting the oldest first.
   */
  mayRecheck(target: Target, kind: TokenKind, name: string): boolean {
    const state = this.kinds[kind];
    const k = slot(target, name);
    const now = Date.now();
    const last = state.rechecked.get(k);
    if (last !== undefined && now < last + this.cacheTtl) return false;
    state.rechecked.delete(k);
    state.rechecked.set(k, now);
    for (const oldest of state.rechecked.keys()) {
      if (state.rechecked.size <= state.limit) break;
      state.rechecked.delete(oldest);
    }
    return true;
  }

  /**
   * Re-reads the token of `name` from the store, bypassing the cache, for a stamp that differs
   * from the cached token (spec 3.3). Joins the slot's re-read in flight; otherwise starts one
   * when `mayRecheck` allows it, and returns `undefined` (no read) when it does not. Never
   * creates the token: a missing or empty key resolves `undefined` and drops a cached tag
   * token. As with `fresh`, the result is cached unless a bump completed meanwhile; a bump also
   * unregisters the re-read, so no later call joins a read older than the bump. A rejection
   * reaches every waiter and caches nothing.
   */
  recheck(target: Target, kind: TokenKind, name: string): Promise<string | undefined> | undefined {
    const state = this.kinds[kind];
    const k = slot(target, name);
    const running = state.rechecks.get(k);
    if (running !== undefined) return running;
    if (!this.mayRecheck(target, kind, name)) return undefined;
    const read = this.readFresh(target, kind, name, false).finally(() => {
      if (state.rechecks.get(k) === read) state.rechecks.delete(k);
    });
    state.rechecks.set(k, read);
    return read;
  }

  /**
   * The store's token of `name`, bypassing the cache; `create` writes one when the key is
   * missing, else a missing (or empty) key is `undefined`. What it read is cached unless a bump
   * completed during the read; a missing tag key then drops the cached token instead.
   */
  private async readFresh(
    target: Target,
    kind: TokenKind,
    name: string,
    create: boolean,
  ): Promise<string | undefined> {
    const state = this.kinds[kind];
    const k = slot(target, name);
    state.freshes.set(k, (state.freshes.get(k) ?? 0) + 1);
    const bumps = state.bumps.get(k) ?? 0;
    try {
      const token = create
        ? await this.read(target, kind, name)
        : await readToken(target.store, tokenKey(this.prefix, kind, name));
      const found = token !== undefined && token !== '';
      if ((state.bumps.get(k) ?? 0) === bumps) {
        // In-flight reads started earlier; they must not replace this newer token (or, for a
        // missing key, cache the token it replaced). A create in flight is newer: it stays.
        state.reads.delete(k);
        if (found) {
          state.inflight.delete(k);
          this.remember(state, k, token);
        } else if (kind === 'tag') {
          // As in `currentMany`: the tag key is gone, so its token is no fallback any more.
          state.cache.delete(k);
        }
      }
      return found ? token : undefined;
    } finally {
      // The last fresh read of the slot ends: nothing compares its bump count any more.
      const left = (state.freshes.get(k) ?? 0) - 1;
      if (left > 0) {
        state.freshes.set(k, left);
      } else {
        state.freshes.delete(k);
        state.bumps.delete(k);
      }
    }
  }

  /** Writes a new token and caches it; on a failed write the cached token is unchanged. */
  async bump(target: Target, kind: TokenKind, name: string): Promise<void> {
    const token = newVersionToken();
    await writeToken(target.store, tokenKey(this.prefix, kind, name), token);
    const state = this.kinds[kind];
    const k = slot(target, name);
    if (state.freshes.has(k)) state.bumps.set(k, (state.bumps.get(k) ?? 0) + 1);
    state.inflight.delete(k);
    state.reads.delete(k);
    state.rechecks.delete(k);
    this.remember(state, k, token);
  }

  /**
   * The tokens of `names` (deduplicated, in first-occurrence order), `undefined` for a missing
   * or empty key; never creates one. Cached tokens are served without a store call. A name with
   * a plain read already in flight (from another `currentMany`) joins it; the others are read
   * with one `getStrict` each, in parallel, when the store has it, else with one `getMany` (one
   * `get` each without it). A token read is cached unless a bump or a fresh read completed
   * meanwhile, and an older read-or-create still in flight then no longer updates the cache; a
   * missing key is not cached, and for a tag it also drops the cached token. A `current` that
   * caches a token also unregisters a plain read still in flight, so that read cannot undo it.
   * Rejects when any store read rejects, for every waiter on it. The names served from the
   * process cache (not read by this call nor joined to a read) are added to `fromCache`.
   */
  async currentMany(
    target: Target,
    kind: TokenKind,
    names: readonly string[],
    fromCache?: Set<string>,
  ): Promise<Map<string, string | undefined>> {
    const state = this.kinds[kind];
    const result = new Map<string, string | undefined>();
    const pending: (readonly [string, Promise<string | undefined>])[] = [];
    const unread: string[] = [];
    const now = Date.now();
    for (const name of names) {
      if (result.has(name)) continue;
      const k = slot(target, name);
      const cached = state.cache.get(k);
      if (cached !== undefined && now < cached.until) {
        result.set(name, cached.token);
        fromCache?.add(name);
        continue;
      }
      result.set(name, undefined);
      const running = state.reads.get(k);
      if (running === undefined) unread.push(name);
      else pending.push([name, running]);
    }
    const reads = readTokens(
      target.store,
      unread.map((name) => [name, tokenKey(this.prefix, kind, name)] as const),
    );
    for (const [name, raw] of reads) {
      pending.push([name, this.shareRead(state, slot(target, name), raw)]);
    }
    for (const [name, token] of await Promise.all(
      pending.map(async ([name, read]) => [name, await read] as const),
    )) {
      result.set(name, token);
    }
    return result;
  }

  /**
   * `current` for each of `names` (deduplicated), in parallel: missing tokens are created, and
   * reads already in flight are shared. Rejects when any read or create rejects.
   */
  async ensureMany(
    target: Target,
    kind: TokenKind,
    names: readonly string[],
  ): Promise<Map<string, string>> {
    const entries = await Promise.all(
      [...new Set(names)].map(
        async (name) => [name, await this.current(target, kind, name)] as const,
      ),
    );
    return new Map(entries);
  }

  /**
   * `bump` for each of `names` (deduplicated), in parallel. Every name is tried; then the call
   * rejects with the first failing name's error. Successful bumps are cached either way.
   */
  async bumpMany(target: Target, kind: TokenKind, names: readonly string[]): Promise<void> {
    const settled = await Promise.allSettled(
      [...new Set(names)].map((name) => this.bump(target, kind, name)),
    );
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }

  /**
   * Registers the plain read of `k` so concurrent `currentMany` calls join it. On success a token
   * is cached while the read is still registered; `''` becomes `undefined`. A rejection is
   * passed to every waiter and caches nothing.
   */
  private shareRead(
    state: KindState,
    k: string,
    raw: Promise<string | undefined>,
  ): Promise<string | undefined> {
    const read: Promise<string | undefined> = raw.then(
      (value) => {
        const registered = state.reads.get(k) === read;
        if (registered) state.reads.delete(k);
        if (value === undefined || value === '') {
          // The tag key is gone: its token is no fallback any more.
          if (registered && state.kind === 'tag') state.cache.delete(k);
          return undefined;
        }
        if (registered) {
          // As in `fresh`: an older read-or-create in flight must not replace this token.
          state.inflight.delete(k);
          this.remember(state, k, value);
        }
        return value;
      },
      (error: unknown) => {
        if (state.reads.get(k) === read) state.reads.delete(k);
        throw error;
      },
    );
    state.reads.set(k, read);
    return read;
  }

  /** Caches `token` as the most recently refreshed entry, evicting the oldest beyond the cap. */
  private remember(state: KindState, k: string, token: string): void {
    state.cache.delete(k);
    state.cache.set(k, { token, until: Date.now() + this.cacheTtl });
    for (const oldest of state.cache.keys()) {
      if (state.cache.size <= state.limit) break;
      state.cache.delete(oldest);
    }
  }

  /**
   * Reads the token key, creating it when missing; a concurrent creator's token wins. With
   * `setIfAbsent` the create is atomic, so a token written (or bumped) after the read is never
   * overwritten; without it, a bump landing between the read and the write is overwritten by
   * `created` and the entries stamped with the bumped token are orphaned (they read as misses),
   * never read wrongly.
   */
  private async read(target: Target, kind: TokenKind, name: string): Promise<string> {
    const key = tokenKey(this.prefix, kind, name);
    const store = target.store;
    const existing = await readToken(store, key);
    if (existing !== undefined && existing !== '') return existing;
    const created = newVersionToken();
    if (store.setIfAbsent !== undefined) {
      if (await store.setIfAbsent(key, created, VERSION_KEY_TTL)) return created;
    } else {
      await writeToken(store, key, created);
    }
    const stored = await readToken(store, key);
    return stored === undefined || stored === '' ? created : stored;
  }
}

function readToken(store: CacheStore, key: string): Promise<string | undefined> {
  return store.getStrict === undefined ? store.get(key) : store.getStrict(key);
}

/**
 * The read of each `[name, key]` pair: `getStrict` each when the store has it, else one shared
 * `getMany` (one `get` each without it). No call for an empty list.
 */
function readTokens(
  store: CacheStore,
  entries: readonly (readonly [name: string, key: string])[],
): [string, Promise<string | undefined>][] {
  if (entries.length === 0) return [];
  if (store.getStrict === undefined && store.getMany !== undefined) {
    const getMany = store.getMany.bind(store);
    const all = attempt(() => getMany(entries.map(([, key]) => key)));
    return entries.map(([name], i) => [name, all.then((values) => values[i])]);
  }
  // A synchronous throw becomes this entry's rejection, so the reads already started stay handled.
  return entries.map(([name, key]) => [name, attempt(() => readToken(store, key))]);
}

/** `run()`, with a synchronous throw turned into a rejection (by the Promise executor). */
function attempt<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(run());
  });
}

function writeToken(store: CacheStore, key: string, token: string): Promise<void> {
  return store.setStrict === undefined
    ? store.set(key, token, VERSION_KEY_TTL)
    : store.setStrict(key, token, VERSION_KEY_TTL);
}
