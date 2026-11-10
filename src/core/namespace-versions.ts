import { randomUUID } from 'node:crypto';
import type { Target } from './engine-io.js';
import { fullKey } from './key-builder.js';

/** 30 days; the version key outlives any data written under its token. */
export const VERSION_KEY_TTL = 2_592_000_000;

export function versionKey(prefix: string | undefined, namespace: string): string {
  return fullKey(prefix, '__version__', namespace);
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

/** Version tokens for opt-in versioned namespaces. Emits nothing; store failures reject. */
export class NamespaceVersions {
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<string>>();
  /** Completed bumps per (store, namespace): a fresh read that saw one finish caches nothing. */
  private readonly bumps = new Map<string, number>();

  constructor(
    private readonly prefix: string | undefined,
    private readonly versioned: ReadonlySet<string>,
    private readonly cacheTtl: number,
  ) {}

  isVersioned(namespace: string | undefined): boolean {
    return namespace !== undefined && this.versioned.has(namespace);
  }

  current(target: Target, namespace: string): Promise<string> {
    const k = `${target.name}\u0000${namespace}`;
    const cached = this.cache.get(k);
    if (cached !== undefined && Date.now() < cached.until) return Promise.resolve(cached.token);
    const running = this.inflight.get(k);
    if (running !== undefined) return running;
    const promise = this.read(target, namespace).then(
      (token) => {
        // A bump while this read was in flight removed the entry; keep the newer token.
        if (this.inflight.get(k) === promise) {
          this.inflight.delete(k);
          this.cache.set(k, { token, until: Date.now() + this.cacheTtl });
        }
        return token;
      },
      (error: unknown) => {
        if (this.inflight.get(k) === promise) this.inflight.delete(k);
        throw error;
      },
    );
    this.inflight.set(k, promise);
    return promise;
  }

  /** The token this instance has cached, even past `cacheTtl`; never reads the store. */
  cached(target: Target, namespace: string): string | undefined {
    return this.cache.get(`${target.name}\u0000${namespace}`)?.token;
  }

  /**
   * Reads the token from the store, bypassing the cache, then caches it for `cacheTtl`.
   * Deletes use it, so they never miss an entry written under another instance's newer token.
   * A bump that completes during the read keeps its token in the cache. Store failures reject.
   */
  async fresh(target: Target, namespace: string): Promise<string> {
    const k = `${target.name}\u0000${namespace}`;
    const bumps = this.bumps.get(k) ?? 0;
    const token = await this.read(target, namespace);
    if ((this.bumps.get(k) ?? 0) === bumps) {
      // An in-flight cached read started earlier; it must not replace this newer token.
      this.inflight.delete(k);
      this.cache.set(k, { token, until: Date.now() + this.cacheTtl });
    }
    return token;
  }

  async bump(target: Target, namespace: string): Promise<void> {
    const token = newVersionToken();
    await target.store.set(versionKey(this.prefix, namespace), token, VERSION_KEY_TTL);
    const k = `${target.name}\u0000${namespace}`;
    this.bumps.set(k, (this.bumps.get(k) ?? 0) + 1);
    this.inflight.delete(k);
    this.cache.set(k, { token, until: Date.now() + this.cacheTtl });
  }

  private async read(target: Target, namespace: string): Promise<string> {
    const key = versionKey(this.prefix, namespace);
    const existing = await target.store.get(key);
    if (existing !== undefined && existing !== '') return existing;
    const created = newVersionToken();
    await target.store.set(key, created, VERSION_KEY_TTL);
    const stored = await target.store.get(key);
    return stored === undefined || stored === '' ? created : stored;
  }
}
