import { CacheConfigError } from '../errors.js';
import type { CacheStore } from './cache-store.interface.js';

interface Entry {
  value: string;
  expiresAt: number;
}

export interface MemoryStoreOptions {
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 1_000;
/** At capacity, expired entries are swept at most this often (ms); otherwise the LRU goes. */
const SWEEP_INTERVAL_MS = 1_000;

/** In-process LRU store on Map insertion order. Expiry is lazy; no timers. */
export class MemoryStore implements CacheStore {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private lastSweepAt = Number.NEGATIVE_INFINITY;

  constructor(options: MemoryStoreOptions = {}) {
    const max = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(max) || max < 1) {
      throw new CacheConfigError(`maxEntries must be an integer >= 1, got ${String(max)}`);
    }
    this.maxEntries = max;
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.read(key, undefined));
  }

  /** Reads the entry and resets its TTL to `ttlMs`; a live hit also becomes most recently used. */
  getAndTouch(key: string, ttlMs: number): Promise<string | undefined> {
    return Promise.resolve(this.read(key, ttlMs));
  }

  /**
   * Removes an expired entry; moves a live one to most recently used and, given `touchTtl`,
   * resets its TTL.
   */
  private read(key: string, touchTtl: number | undefined): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    const now = Date.now();
    if (now >= entry.expiresAt) return undefined;
    if (touchTtl !== undefined) entry.expiresAt = now + touchTtl;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string, ttlMs: number): Promise<void> {
    const now = Date.now();
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      // A full scan on every insert at capacity is O(n); between sweeps the LRU head is evicted.
      if (now - this.lastSweepAt >= SWEEP_INTERVAL_MS) {
        this.lastSweepAt = now;
        for (const [k, e] of this.entries) {
          if (now >= e.expiresAt) this.entries.delete(k);
        }
      }
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next();
        if (oldest.done !== true) this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, { value, expiresAt: now + ttlMs });
    return Promise.resolve();
  }

  getMany(keys: readonly string[]): Promise<(string | undefined)[]> {
    return Promise.resolve(keys.map((key) => this.read(key, undefined)));
  }

  /** Writes every entry in one synchronous step, so no other task can interleave between them. */
  setMany(entries: readonly { key: string; value: string; ttlMs: number }[]): Promise<void> {
    for (const { key, value, ttlMs } of entries) void this.set(key, value, ttlMs);
    return Promise.resolve();
  }

  delete(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.entries.delete(key);
    return Promise.resolve();
  }

  clear(prefix: string): Promise<void> {
    if (prefix === '') {
      this.entries.clear();
    } else {
      for (const key of this.entries.keys()) {
        if (key.startsWith(prefix)) this.entries.delete(key);
      }
    }
    return Promise.resolve();
  }
}

export function memoryStore(options?: MemoryStoreOptions): MemoryStore {
  return new MemoryStore(options);
}
