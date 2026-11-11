import { randomUUID } from 'node:crypto';
import type { CacheStore } from '../stores/cache-store.interface.js';
import type { Target } from './engine-keys.js';
import { fullKey } from './key-builder.js';

/** What a token versions: a versioned namespace or a cache tag. */
export type TokenKind = 'ns' | 'tag';

/** 30 days; a token key outlives any data written under its token. */
export const VERSION_KEY_TTL = 2_592_000_000;

const KIND_NAMESPACE: Readonly<Record<TokenKind, string>> = { ns: '__version__', tag: '__tag__' };

/**
 * `<prefix>:__version__:<name>` for a namespace (unchanged since 0.4), `<prefix>:__tag__:<name>`
 * for a tag. The name is used as is, without escaping.
 */
export function tokenKey(prefix: string | undefined, kind: TokenKind, name: string): string {
  return fullKey(prefix, KIND_NAMESPACE[kind], name);
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
  readonly cache: Map<string, Cached>;
  readonly inflight: Map<string, Promise<string>>;
  /** Completed bumps per (store, name): a read that saw one finish caches nothing. */
  readonly bumps: Map<string, number>;
}

function newState(): KindState {
  return { cache: new Map(), inflight: new Map(), bumps: new Map() };
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
  private readonly kinds: Readonly<Record<TokenKind, KindState>> = {
    ns: newState(),
    tag: newState(),
  };

  constructor(
    private readonly prefix: string | undefined,
    private readonly cacheTtl: number,
  ) {}

  /** The completed bump counts of `kind`, keyed by `<store>\0<name>`. */
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
    const state = this.kinds[kind];
    const k = slot(target, name);
    const bumps = state.bumps.get(k) ?? 0;
    const token = await this.read(target, kind, name);
    if ((state.bumps.get(k) ?? 0) === bumps) {
      // An in-flight cached read started earlier; it must not replace this newer token.
      state.inflight.delete(k);
      this.remember(state, k, token);
    }
    return token;
  }

  /** Writes a new token and caches it; on a failed write the cached token is unchanged. */
  async bump(target: Target, kind: TokenKind, name: string): Promise<void> {
    const token = newVersionToken();
    await writeToken(target.store, tokenKey(this.prefix, kind, name), token);
    const state = this.kinds[kind];
    const k = slot(target, name);
    state.bumps.set(k, (state.bumps.get(k) ?? 0) + 1);
    state.inflight.delete(k);
    this.remember(state, k, token);
  }

  /**
   * The tokens of `names` (deduplicated, in first-occurrence order), `undefined` for a missing
   * or empty key; never creates one. Cached tokens are served without a store call. The others
   * are read with one `getStrict` each, in parallel, when the store has it, else with one
   * `getMany` (one `get` each without it), and cached unless a bump completed meanwhile; an
   * older read still in flight then no longer updates the cache.
   * Rejects when any store read rejects.
   */
  async currentMany(
    target: Target,
    kind: TokenKind,
    names: readonly string[],
  ): Promise<Map<string, string | undefined>> {
    const state = this.kinds[kind];
    const result = new Map<string, string | undefined>();
    const missing: string[] = [];
    const now = Date.now();
    for (const name of names) {
      if (result.has(name)) continue;
      const cached = state.cache.get(slot(target, name));
      if (cached !== undefined && now < cached.until) {
        result.set(name, cached.token);
      } else {
        result.set(name, undefined);
        missing.push(name);
      }
    }
    if (missing.length === 0) return result;
    const bumps = missing.map((name) => state.bumps.get(slot(target, name)) ?? 0);
    const values = await readTokens(
      target.store,
      missing.map((name) => tokenKey(this.prefix, kind, name)),
    );
    missing.forEach((name, i) => {
      const token = values[i];
      if (token === undefined || token === '') return;
      result.set(name, token);
      const k = slot(target, name);
      if ((state.bumps.get(k) ?? 0) === bumps[i]) {
        // As in `fresh`: an older in-flight read must not replace this token.
        state.inflight.delete(k);
        this.remember(state, k, token);
      }
    });
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

  private remember(state: KindState, k: string, token: string): void {
    state.cache.set(k, { token, until: Date.now() + this.cacheTtl });
  }

  /** Reads the token key, creating it when missing; a concurrent creator's token wins. */
  private async read(target: Target, kind: TokenKind, name: string): Promise<string> {
    const key = tokenKey(this.prefix, kind, name);
    const existing = await readToken(target.store, key);
    if (existing !== undefined && existing !== '') return existing;
    const created = newVersionToken();
    await writeToken(target.store, key, created);
    const stored = await readToken(target.store, key);
    return stored === undefined || stored === '' ? created : stored;
  }
}

function readToken(store: CacheStore, key: string): Promise<string | undefined> {
  return store.getStrict === undefined ? store.get(key) : store.getStrict(key);
}

function readTokens(store: CacheStore, keys: readonly string[]): Promise<(string | undefined)[]> {
  if (store.getStrict === undefined && store.getMany !== undefined) return store.getMany(keys);
  return Promise.all(keys.map((key) => readToken(store, key)));
}

function writeToken(store: CacheStore, key: string, token: string): Promise<void> {
  return store.setStrict === undefined
    ? store.set(key, token, VERSION_KEY_TTL)
    : store.setStrict(key, token, VERSION_KEY_TTL);
}
