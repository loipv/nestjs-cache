import type { Target } from './engine-keys.js';
import { tokenKey, VersionTokens } from './version-tokens.js';

export { newVersionToken, VERSION_KEY_TTL } from './version-tokens.js';

export function versionKey(prefix: string | undefined, namespace: string): string {
  return tokenKey(prefix, 'ns', namespace);
}

/**
 * Version tokens for opt-in versioned namespaces: the 0.6 API over `VersionTokens` with kind
 * `'ns'`. Emits nothing; store failures reject (see `VersionTokens`).
 */
export class NamespaceVersions {
  /** Completed bumps per (store, namespace): the `'ns'` counters of `tokens`. */
  private readonly bumps: ReadonlyMap<string, number>;

  /**
   * `tokens` lets the engine share one `VersionTokens` with tags; it must be built with the
   * same `prefix` and `cacheTtl`.
   */
  constructor(
    prefix: string | undefined,
    private readonly versioned: ReadonlySet<string>,
    cacheTtl: number,
    private readonly tokens: VersionTokens = new VersionTokens(prefix, cacheTtl),
  ) {
    this.bumps = tokens.bumpCounts('ns');
  }

  isVersioned(namespace: string | undefined): boolean {
    return namespace !== undefined && this.versioned.has(namespace);
  }

  /** See `VersionTokens.current`. */
  current(target: Target, namespace: string): Promise<string> {
    return this.tokens.current(target, 'ns', namespace);
  }

  /** The token this instance has cached, even past `cacheTtl`; never reads the store. */
  cached(target: Target, namespace: string): string | undefined {
    return this.tokens.cached(target, 'ns', namespace);
  }

  /**
   * Reads the token from the store, bypassing the cache, then caches it for `cacheTtl`.
   * Deletes use it, so they never miss an entry written under another instance's newer token.
   * A bump that completes during the read keeps its token in the cache. Store failures reject.
   */
  fresh(target: Target, namespace: string): Promise<string> {
    return this.tokens.fresh(target, 'ns', namespace);
  }

  bump(target: Target, namespace: string): Promise<void> {
    return this.tokens.bump(target, 'ns', namespace);
  }
}
