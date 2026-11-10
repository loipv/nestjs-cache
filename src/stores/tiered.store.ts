import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { CacheEventSink, CacheOperation } from '../core/events.js';
import { CacheConfigError } from '../errors.js';
import type { CacheStore, InvalidationBus, InvalidationMessage } from './cache-store.interface.js';

export interface TieredStoreOptions {
  l1: CacheStore;
  l2: CacheStore;
  /** Upper bound on how long a value lives in L1. Defaults to 10_000 ms. */
  l1Ttl?: number;
  /** Overrides `l2.invalidation`. */
  invalidation?: InvalidationBus;
}

const DEFAULT_L1_TTL = 10_000;

/**
 * Two-tier store: a fast local L1 in front of a shared L2. Every write, delete and clear is
 * published on the invalidation bus so other instances drop their L1 copies. No method rejects;
 * failures are reported through the sink given to `bind`.
 */
export class TieredStore implements CacheStore {
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
    this.l1Ttl = l1Ttl;
    this.ownedBus = options.invalidation;
    this.bus = options.invalidation ?? options.l2.invalidation;
  }

  bind(sink: CacheEventSink): void {
    this.sink = sink;
    this.l1.bind?.(sink);
    this.l2.bind?.(sink);
    if (this.bus === undefined) {
      if (!this.warned) {
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
    let local: string | undefined;
    try {
      local = await this.l1.get(key);
    } catch (error) {
      this.report('get', error);
    }
    if (local !== undefined) return local;

    const token = Symbol(key);
    this.pending.set(key, token);
    let remote: string | undefined;
    try {
      remote = await this.l2.get(key);
    } catch (error) {
      this.report('get', error);
    }
    // Still ours: no invalidation of this key (and no newer read of it) happened meanwhile.
    const current = this.pending.get(key) === token;
    if (current) this.pending.delete(key);
    if (remote !== undefined && current) {
      const value = remote;
      await this.attempt('set', () => this.l1.set(key, value, this.l1Ttl));
    }
    return remote;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.attempt('set', () => this.l2.set(key, value, ttlMs));
    this.pending.delete(key);
    await this.attempt('set', () => this.l1.set(key, value, Math.min(ttlMs, this.l1Ttl)));
    await this.publish({ origin: this.origin, keys: [key] });
  }

  async delete(keys: readonly string[]): Promise<void> {
    await this.attempt('delete', () => this.l2.delete(keys));
    this.forgetKeys(keys);
    await this.attempt('delete', () => this.l1.delete(keys));
    if (keys.length > 0) await this.publish({ origin: this.origin, keys: [...keys] });
  }

  async clear(prefix: string): Promise<void> {
    await this.attempt('clear', () => this.l2.clear(prefix));
    this.forgetPrefix(prefix);
    await this.attempt('clear', () => this.l1.clear(prefix));
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

  /** Runs `fn`, reporting a rejection or a synchronous throw. Never rejects. */
  private async attempt(operation: CacheOperation, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.report(operation, error);
    }
  }

  private report(operation: CacheOperation, error: unknown): void {
    try {
      this.sink?.emit('error', { operation, error });
    } catch {
      // a failing sink must never reach the caller
    }
  }
}

async function quietly(fn: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await fn();
  } catch {
    // close failures are swallowed; close itself never rejects
  }
}

export function tieredStore(options: TieredStoreOptions): TieredStore {
  return new TieredStore(options);
}
