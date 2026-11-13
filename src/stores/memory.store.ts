import { CacheConfigError } from '../errors.js';
import type { CacheStore } from './cache-store.interface.js';

interface Entry {
  value: string;
  expiresAt: number;
}

/** Options of `memoryStore`. */
export interface MemoryStoreOptions {
  /** Entries kept before the least recently used one is evicted; an integer >= 1. Default 1 000. */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 1_000;
/** At capacity, expired entries are swept at most this often (ms); otherwise the LRU goes. */
const SWEEP_INTERVAL_MS = 1_000;

/** One LRU on Map insertion order, bounded by entry count. Expiry is lazy; no timers. */
class Partition {
  readonly entries = new Map<string, Entry>();
  private lastSweepAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly maxEntries: number) {}

  /**
   * Removes an expired entry; moves a live one to most recently used and, given `touchTtl`,
   * resets its TTL.
   */
  read(key: string, touchTtl: number | undefined): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    const now = Date.now();
    if (now >= entry.expiresAt) return undefined;
    if (touchTtl !== undefined) entry.expiresAt = now + touchTtl;
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Resets the TTL of a live entry in place; a missing or expired key is left as it is. */
  touch(key: string, ttlMs: number): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    const now = Date.now();
    if (now >= entry.expiresAt) this.entries.delete(key);
    else entry.expiresAt = now + ttlMs;
  }

  write(key: string, entry: Entry): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const now = Date.now();
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
    this.entries.set(key, entry);
  }

  clear(prefix: string): void {
    if (prefix === '') {
      this.entries.clear();
      return;
    }
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

/**
 * In-process LRU store on Map insertion order. Expiry is lazy; no timers.
 *
 * The version tokens of namespaces and tags live in a second LRU with the same `maxEntries`, so
 * data writes never evict them. An evicted token would be re-created with a new value, and every
 * entry of its namespace or tag would then read as a miss.
 */
export class MemoryStore implements CacheStore {
  private readonly data: Partition;
  private readonly tokens: Partition;
  private reservedPrefixes: readonly string[] = [];

  constructor(options: MemoryStoreOptions = {}) {
    const max = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(max) || max < 1) {
      throw new CacheConfigError(`maxEntries must be an integer >= 1, got ${String(max)}`);
    }
    this.data = new Partition(max);
    this.tokens = new Partition(max);
  }

  /** The data entries in LRU order, oldest first. */
  private get entries(): Map<string, Entry> {
    return this.data.entries;
  }

  /**
   * @internal Called by the engine with the token key prefixes of its `prefix`
   * (`<prefix>:__version__:` and `<prefix>:__tag__:`). Keys under them go to the token LRU, and
   * entries already stored under them move there.
   */
  reserveKeyPrefixes(prefixes: readonly string[]): void {
    const added = prefixes.filter((p) => p !== '' && !this.reservedPrefixes.includes(p));
    if (added.length === 0) return;
    this.reservedPrefixes = [...this.reservedPrefixes, ...new Set(added)];
    for (const [key, entry] of this.data.entries) {
      if (added.some((p) => key.startsWith(p))) {
        this.data.entries.delete(key);
        this.tokens.write(key, entry);
      }
    }
  }

  private partitionOf(key: string): Partition {
    for (const prefix of this.reservedPrefixes) {
      if (key.startsWith(prefix)) return this.tokens;
    }
    return this.data;
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.partitionOf(key).read(key, undefined));
  }

  /** Reads the entry and resets its TTL to `ttlMs`; a live hit also becomes most recently used. */
  getAndTouch(key: string, ttlMs: number): Promise<string | undefined> {
    return Promise.resolve(this.partitionOf(key).read(key, ttlMs));
  }

  set(key: string, value: string, ttlMs: number): Promise<void> {
    this.partitionOf(key).write(key, { value, expiresAt: Date.now() + ttlMs });
    return Promise.resolve();
  }

  /** Resets the TTL of the live entries; missing or expired keys are not created. */
  touch(keys: readonly string[], ttlMs: number): Promise<void> {
    for (const key of keys) this.partitionOf(key).touch(key, ttlMs);
    return Promise.resolve();
  }

  /** Writes only when the key is absent or expired, in one synchronous step. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    const partition = this.partitionOf(key);
    if (partition.read(key, undefined) !== undefined) return Promise.resolve(false);
    partition.write(key, { value, expiresAt: Date.now() + ttlMs });
    return Promise.resolve(true);
  }

  getMany(keys: readonly string[]): Promise<(string | undefined)[]> {
    return Promise.resolve(keys.map((key) => this.partitionOf(key).read(key, undefined)));
  }

  /** Writes every entry in one synchronous step, so no other task can interleave between them. */
  setMany(entries: readonly { key: string; value: string; ttlMs: number }[]): Promise<void> {
    for (const { key, value, ttlMs } of entries) void this.set(key, value, ttlMs);
    return Promise.resolve();
  }

  delete(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.partitionOf(key).entries.delete(key);
    return Promise.resolve();
  }

  clear(prefix: string): Promise<void> {
    this.data.clear(prefix);
    this.tokens.clear(prefix);
    return Promise.resolve();
  }
}

/** An in-process LRU store; the default store when `CacheModule` gets no `stores`. */
export function memoryStore(options?: MemoryStoreOptions): MemoryStore {
  return new MemoryStore(options);
}
