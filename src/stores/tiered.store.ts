import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { CacheEventSink, CacheOperation } from '../core/events.js';
import { CacheConfigError } from '../errors.js';
import { CircuitOpenError } from '../resilience/circuit-breaker.store.js';
import type {
  CacheStore,
  InvalidationBus,
  InvalidationMessage,
  LockProvider,
} from './cache-store.interface.js';

/** Options of `tieredStore`. */
export interface TieredStoreOptions {
  /** The local tier, usually `memoryStore()`. */
  l1: CacheStore;
  /** The shared tier, usually `redisStore(...)`; its bus is used unless `invalidation` is set. */
  l2: CacheStore;
  /** Upper bound on how long a value lives in L1. Defaults to 10_000 ms. */
  l1Ttl?: number;
  /** Overrides `l2.invalidation`. */
  invalidation?: InvalidationBus;
}

const DEFAULT_L1_TTL = 10_000;

/**
 * Two-tier store: a fast local L1 in front of a shared L2. Every write, delete and clear is
 * published on the invalidation bus so other instances drop their L1 copies. Failures are reported
 * through the sink given to `bind`; no method rejects except `getStrict` and `setStrict`, which
 * reject when L2 cannot be read or written.
 */
export class TieredStore implements CacheStore {
  /** The L2's lock, when it has one. */
  declare readonly lock?: LockProvider;
  /** Present only when the L2 has `ping`; probes the L2. */
  declare readonly ping?: () => Promise<void>;
  private readonly l1: CacheStore;
  private readonly l2: CacheStore;
  private readonly l1Ttl: number;
  private readonly bus: InvalidationBus | undefined;
  private readonly ownedBus: InvalidationBus | undefined;
  private readonly origin = randomUUID();
  private readonly logger = new Logger('CacheModule');
  private sink: CacheEventSink | undefined;
  private subscribed = false;
  private warned = false;
  private closing: Promise<void> | undefined;
  /**
   * One token per key with an L2 read in flight. Invalidating a key drops its token, so a read
   * that straddles an invalidation does not backfill L1 with the value it read before it.
   */
  private readonly pending = new Map<string, symbol>();

  constructor(options: TieredStoreOptions) {
    const l1Ttl = options.l1Ttl ?? DEFAULT_L1_TTL;
    if (typeof l1Ttl !== 'number' || !Number.isFinite(l1Ttl) || l1Ttl <= 0) {
      throw new CacheConfigError(
        `Invalid tieredStore option l1Ttl: ${String(l1Ttl)} (must be a finite number > 0)`,
      );
    }
    this.l1 = options.l1;
    this.l2 = options.l2;
    if (options.l2.lock !== undefined) this.lock = options.l2.lock;
    if (options.l2.ping !== undefined) {
      const ping = options.l2.ping.bind(options.l2);
      this.ping = () => ping();
    }
    this.l1Ttl = l1Ttl;
    this.ownedBus = options.invalidation;
    this.bus = options.invalidation ?? options.l2.invalidation;
  }

  bind(sink: CacheEventSink): void {
    this.sink = sink;
    this.l1.bind?.(sink);
    this.l2.bind?.(sink);
    if (this.bus === undefined) {
      // A hand-built sink may omit `logLevel`; a missing one means the default level.
      const level = sink.logLevel ?? 'error';
      if (level !== 'off' && !this.warned) {
        this.warned = true;
        this.logger.warn(
          'TieredStore has no invalidation bus: other instances keep stale L1 entries for up to l1Ttl after a write or delete',
        );
      }
      return;
    }
    if (this.subscribed) return;
    this.subscribed = true;
    const bus = this.bus;
    const registrations = [
      () => {
        bus.onReconnect(this.onReconnect);
      },
      () => {
        bus.onError?.(this.onBusError);
      },
    ];
    for (const register of registrations) {
      try {
        register();
      } catch (error) {
        this.report('subscribe', error);
      }
    }
    // Startup must not wait on the bus: subscribe runs in the background.
    void this.attempt('subscribe', () => bus.subscribe(this.onMessage));
  }

  async get(key: string): Promise<string | undefined> {
    const local = await this.readL1(key);
    if (local !== undefined) return local;
    return this.readL2(key, () => this.l2.get(key), this.l1Ttl);
  }

  /**
   * Like `get`, but an L2 failure (including `CircuitOpenError`) is reported as `get` and then
   * rejects with that error instead of counting as a miss. An L1 failure still counts as a miss.
   */
  async getStrict(key: string): Promise<string | undefined> {
    const local = await this.readL1(key);
    if (local !== undefined) return local;
    return this.readL2(key, () => this.l2.get(key), this.l1Ttl, true);
  }

  /**
   * Reads several keys: L1 first, then one L2 read for the misses, backfilling L1 (with `l1Ttl`)
   * only the keys not invalidated meanwhile. A failing tier counts as misses; an L2 failure is
   * reported once for the batch.
   */
  async getMany(keys: readonly string[]): Promise<(string | undefined)[]> {
    if (keys.length === 0) return [];
    let local: (string | undefined)[] = [];
    try {
      local = await readMany(this.l1, keys);
    } catch (error) {
      this.report('get', error);
    }
    const result = keys.map((_, i) => local[i]);
    const missed = keys.filter((_, i) => result[i] === undefined);
    if (missed.length === 0) return result;

    const tokens = new Map<string, symbol>();
    for (const key of missed) {
      const token = Symbol(key);
      tokens.set(key, token);
      this.pending.set(key, token);
    }
    let remote: (string | undefined)[] = [];
    try {
      remote = await readMany(this.l2, missed);
    } catch (error) {
      this.report('get', error);
    }
    const backfill: { key: string; value: string; ttlMs: number }[] = [];
    missed.forEach((key, i) => {
      const current = this.pending.get(key) === tokens.get(key);
      if (current) this.pending.delete(key);
      const value = remote[i];
      if (value === undefined) return;
      if (current) backfill.push({ key, value, ttlMs: this.l1Ttl });
    });
    if (backfill.length > 0) await this.attempt('set', () => writeMany(this.l1, backfill));
    let next = 0;
    return keys.map((_, i) => result[i] ?? remote[next++]);
  }

  /**
   * Writes L2 first, then L1 (each TTL capped at `l1Ttl`), then publishes one message with every
   * key, unless the L2 refused the write because its circuit is open.
   */
  async setMany(entries: readonly { key: string; value: string; ttlMs: number }[]): Promise<void> {
    if (entries.length === 0) return;
    const refused = await this.attempt('set', () => writeMany(this.l2, entries));
    this.forgetKeys(entries.map((e) => e.key));
    const capped = entries.map((e) => ({ ...e, ttlMs: Math.min(e.ttlMs, this.l1Ttl) }));
    await this.attempt('set', () => writeMany(this.l1, capped));
    if (refused instanceof CircuitOpenError) return;
    await this.publish({ origin: this.origin, keys: entries.map((e) => e.key) });
  }

  /**
   * Reads the value and resets its TTL to `ttlMs` on L2 (through `l2.getAndTouch` when it has
   * one, otherwise `l2.get`). L1 is read but never extended; a backfill lives `min(ttlMs, l1Ttl)`.
   */
  async getAndTouch(key: string, ttlMs: number): Promise<string | undefined> {
    const local = await this.readL1(key);
    if (local !== undefined) return local;

    const l2 = this.l2;
    return this.readL2(
      key,
      () => (l2.getAndTouch === undefined ? l2.get(key) : l2.getAndTouch(key, ttlMs)),
      Math.min(ttlMs, this.l1Ttl),
    );
  }

  /** L1 read; a failure is reported as `get` and counts as a miss. */
  private async readL1(key: string): Promise<string | undefined> {
    try {
      return await this.l1.get(key);
    } catch (error) {
      this.report('get', error);
      return undefined;
    }
  }

  /**
   * L2 read after an L1 miss, backfilling L1 unless the key was invalidated meanwhile. A failure
   * is reported as `get` and counts as a miss, or, when `strict`, rejects with the same error.
   */
  private async readL2(
    key: string,
    read: () => Promise<string | undefined>,
    backfillTtl: number,
    strict = false,
  ): Promise<string | undefined> {
    const token = Symbol(key);
    this.pending.set(key, token);
    let remote: string | undefined;
    try {
      remote = await read();
    } catch (error) {
      this.report('get', error);
      if (strict) {
        this.release(key, token);
        throw error;
      }
    }
    // Still ours: no invalidation of this key (and no newer read of it) happened meanwhile.
    const current = this.release(key, token);
    if (remote !== undefined && current) {
      const value = remote;
      await this.attempt('set', () => this.l1.set(key, value, backfillTtl));
    }
    return remote;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    const refused = await this.attempt('set', () => this.l2.set(key, value, ttlMs));
    await this.afterL2Set(key, value, ttlMs, !(refused instanceof CircuitOpenError));
  }

  /**
   * Like `set`, but an L2 failure (including `CircuitOpenError`) is reported as `set` and then
   * rejects with that error; L1 is not written and nothing is published. Once L2 stored the
   * value, it continues as `set` does.
   */
  async setStrict(key: string, value: string, ttlMs: number): Promise<void> {
    try {
      await this.l2.set(key, value, ttlMs);
    } catch (error) {
      this.report('set', error);
      throw error;
    }
    await this.afterL2Set(key, value, ttlMs, true);
  }

  /** The rest of a set once L2 was tried: L1 with `min(ttlMs, l1Ttl)`, then the publish. */
  private async afterL2Set(
    key: string,
    value: string,
    ttlMs: number,
    publish: boolean,
  ): Promise<void> {
    this.pending.delete(key);
    await this.attempt('set', () => this.l1.set(key, value, Math.min(ttlMs, this.l1Ttl)));
    if (publish) await this.publish({ origin: this.origin, keys: [key] });
  }

  async delete(keys: readonly string[]): Promise<void> {
    const refused = await this.attempt('delete', () => this.l2.delete(keys));
    this.forgetKeys(keys);
    await this.attempt('delete', () => this.l1.delete(keys));
    if (refused instanceof CircuitOpenError) return;
    if (keys.length > 0) await this.publish({ origin: this.origin, keys: [...keys] });
  }

  async clear(prefix: string): Promise<void> {
    const refused = await this.attempt('clear', () => this.l2.clear(prefix));
    this.forgetPrefix(prefix);
    await this.attempt('clear', () => this.l1.clear(prefix));
    if (refused instanceof CircuitOpenError) return;
    await this.publish({ origin: this.origin, prefix });
  }

  /** Idempotent. Closes both tiers and a bus passed in options; `l2.invalidation` belongs to `l2`. */
  close(): Promise<void> {
    this.closing ??= this.closeAll();
    return this.closing;
  }

  private async closeAll(): Promise<void> {
    await quietly(() => this.l1.close?.());
    await quietly(() => this.l2.close?.());
    await quietly(() => this.ownedBus?.close());
  }

  private readonly onMessage = (message: InvalidationMessage): void => {
    if (message.origin === this.origin) return;
    if ('keys' in message) {
      this.forgetKeys(message.keys);
      void this.attempt('delete', () => this.l1.delete(message.keys));
    } else {
      this.forgetPrefix(message.prefix);
      void this.attempt('clear', () => this.l1.clear(message.prefix));
    }
  };

  private readonly onReconnect = (): void => {
    // Messages may have been missed while disconnected.
    this.pending.clear();
    void this.attempt('clear', () => this.l1.clear(''));
  };

  /** Errors the bus handles internally, such as a lost subscriber connection. */
  private readonly onBusError = (error: unknown): void => {
    this.report('subscribe', error);
  };

  /** Drops the pending read token of `key` if it is still `token`; true when it was. */
  private release(key: string, token: symbol): boolean {
    const current = this.pending.get(key) === token;
    if (current) this.pending.delete(key);
    return current;
  }

  private forgetKeys(keys: readonly string[]): void {
    for (const key of keys) this.pending.delete(key);
  }

  private forgetPrefix(prefix: string): void {
    for (const key of this.pending.keys()) {
      if (key.startsWith(prefix)) this.pending.delete(key);
    }
  }

  private async publish(message: InvalidationMessage): Promise<void> {
    const bus = this.bus;
    if (bus === undefined) return;
    await this.attempt('publish', () => bus.publish(message));
  }

  /**
   * Runs `fn`, reporting a rejection or a synchronous throw. Never rejects. Returns the caught
   * error, or `undefined` on success.
   */
  private async attempt(operation: CacheOperation, fn: () => Promise<unknown>): Promise<unknown> {
    try {
      await fn();
      return undefined;
    } catch (error) {
      this.report(operation, error);
      return error;
    }
  }

  private report(operation: CacheOperation, error: unknown): void {
    // An open circuit means the store is temporarily absent, not broken.
    if (error instanceof CircuitOpenError) return;
    try {
      this.sink?.emit('error', { operation, error });
    } catch {
      // a failing sink must never reach the caller
    }
  }
}

function readMany(store: CacheStore, keys: readonly string[]): Promise<(string | undefined)[]> {
  return store.getMany === undefined
    ? Promise.all(keys.map((key) => store.get(key)))
    : store.getMany(keys);
}

function writeMany(
  store: CacheStore,
  entries: readonly { key: string; value: string; ttlMs: number }[],
): Promise<unknown> {
  return store.setMany === undefined
    ? Promise.all(entries.map((e) => store.set(e.key, e.value, e.ttlMs)))
    : store.setMany(entries);
}

async function quietly(fn: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await fn();
  } catch {
    // close failures are swallowed; close itself never rejects
  }
}

/** Builds a two-tier store (see `TieredStore`). */
export function tieredStore(options: TieredStoreOptions): TieredStore {
  return new TieredStore(options);
}
