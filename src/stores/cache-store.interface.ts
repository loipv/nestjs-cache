import type { CacheEventSink } from '../core/events.js';

export type InvalidationMessage =
  { origin: string; keys: readonly string[] } | { origin: string; prefix: string };

export interface InvalidationBus {
  publish(message: InvalidationMessage): Promise<void>;
  subscribe(handler: (message: InvalidationMessage) => void): Promise<void>;
  onReconnect(handler: () => void): void;
  close(): Promise<void>;
}

export interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  /** An empty prefix clears everything. */
  clear(prefix: string): Promise<void>;
  getAndTouch?(key: string, ttlMs: number): Promise<string | undefined>;
  readonly invalidation?: InvalidationBus;
  bind?(events: CacheEventSink): void;
  close?(): Promise<void>;
}
