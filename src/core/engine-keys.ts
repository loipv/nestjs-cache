import type { ResolvedCacheOptions } from '../module/cache.options.js';
import type { CacheStore } from '../stores/cache-store.interface.js';
import type { ReportError } from './events.js';
import { fullKey, lockKey } from './key-builder.js';
import type { NamespaceVersions } from './namespace-versions.js';

export interface Target {
  name: string;
  store: CacheStore;
}

/** The data key and the lock key of one entry, carrying the namespace version if any. */
export interface ResolvedKey {
  full: string;
  lock: string;
}

/** Key resolution: the data and lock keys of an entry, with the namespace version if any. */
export class EngineKeys {
  constructor(
    private readonly options: ResolvedCacheOptions,
    private readonly versions: NamespaceVersions,
    private readonly reportError: ReportError,
  ) {}

  /**
   * The keys of `ref` in `target`. A namespace that is not versioned resolves synchronously, so
   * callers await only a promise and the 0.3 path gains no await. A versioned namespace reads
   * its token; on a failure it reports one `version` error and falls back to the last token this
   * process knew for the namespace, or resolves `undefined` when there is none, and the caller
   * then skips the cache.
   */
  resolveKey(
    target: Target,
    ref: { namespace?: string | undefined; key: string },
  ): ResolvedKey | Promise<ResolvedKey | undefined> {
    const { namespace, key } = ref;
    if (namespace === undefined || !this.versions.isVersioned(namespace)) {
      return this.keysOf(namespace, key);
    }
    return this.versionedNamespace(target, namespace).then((resolved) =>
      resolved === undefined ? undefined : this.keysOf(resolved, key),
    );
  }

  /**
   * The keys of every `keys` entry in one namespace, in input order. As `resolveKey`, but one
   * version read serves the whole batch. A failed read reports one `version` error and falls back
   * as `resolveKey` does, or resolves `undefined`.
   */
  resolveKeys(
    target: Target,
    namespace: string | undefined,
    keys: readonly string[],
  ): ResolvedKey[] | Promise<ResolvedKey[] | undefined> {
    if (namespace === undefined || !this.versions.isVersioned(namespace)) {
      return keys.map((key) => this.keysOf(namespace, key));
    }
    return this.versionedNamespace(target, namespace).then((resolved) =>
      resolved === undefined ? undefined : keys.map((key) => this.keysOf(resolved, key)),
    );
  }

  private keysOf(namespace: string | undefined, key: string): ResolvedKey {
    const { prefix } = this.options;
    return { full: fullKey(prefix, namespace, key), lock: lockKey(prefix, namespace, key) };
  }

  /**
   * `<ns>@<v>`. When the version read fails it reports one `version` error. A store with
   * `getStrict` then uses the last token this process knew (even past `cacheTtl`) for this call
   * only, so the next call reads the store again; `undefined` when no token was ever known, and
   * always for a store without `getStrict`. Never rejects. Deletes do not use it.
   */
  private async versionedNamespace(target: Target, namespace: string): Promise<string | undefined> {
    try {
      return `${namespace}@${await this.versions.current(target, namespace)}`;
    } catch (error) {
      this.reportError(target.name, 'version', error);
      // Only stores with getStrict (tiered, or a breaker over one) opt into the fallback.
      if (target.store.getStrict === undefined) return undefined;
      const known = this.versions.cached(target, namespace);
      return known === undefined ? undefined : `${namespace}@${known}`;
    }
  }

  /**
   * The `<ns>@<v>` forms a delete removes: the token read fresh from the store, so an entry
   * another instance wrote after its clear is deleted within `cacheTtl` too, plus any other
   * token this instance had cached (its own writes may sit under it). One version read for the
   * whole call; `undefined` after reporting a `version` error.
   */
  async deleteNamespaces(target: Target, namespace: string): Promise<string[] | undefined> {
    const previous = this.versions.cached(target, namespace);
    let token: string;
    try {
      token = await this.versions.fresh(target, namespace);
    } catch (error) {
      this.reportError(target.name, 'version', error);
      return undefined;
    }
    // A bump during the read leaves its newer token cached: delete under it as well.
    const tokens = new Set([token]);
    for (const other of [previous, this.versions.cached(target, namespace)]) {
      if (other !== undefined) tokens.add(other);
    }
    return [...tokens].map((t) => `${namespace}@${t}`);
  }
}
