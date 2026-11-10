import { vi, type Mock } from 'vitest';
import type { CacheStore } from '../../../src/stores/cache-store.interface.js';

type Op = 'get' | 'set' | 'delete' | 'clear';

export class FakeStore implements CacheStore {
  readonly data = new Map<string, { value: string; ttlMs: number }>();
  readonly calls: { op: Op; args: unknown[] }[] = [];
  bind: Mock = vi.fn();
  close: Mock = vi.fn(() => Promise.resolve(undefined));
  private readonly failures = new Map<Op, Error[]>();

  failNext(op: Op, error: Error = new Error(`${op} failed`)): void {
    const queue = this.failures.get(op) ?? [];
    queue.push(error);
    this.failures.set(op, queue);
  }

  private enter(op: Op, args: unknown[]): Error | undefined {
    this.calls.push({ op, args });
    return this.failures.get(op)?.shift();
  }

  get(key: string): Promise<string | undefined> {
    const error = this.enter('get', [key]);
    if (error) return Promise.reject(error);
    return Promise.resolve(this.data.get(key)?.value);
  }

  set(key: string, value: string, ttlMs: number): Promise<void> {
    const error = this.enter('set', [key, value, ttlMs]);
    if (error) return Promise.reject(error);
    this.data.set(key, { value, ttlMs });
    return Promise.resolve();
  }

  delete(keys: readonly string[]): Promise<void> {
    const error = this.enter('delete', [keys]);
    if (error) return Promise.reject(error);
    for (const key of keys) this.data.delete(key);
    return Promise.resolve();
  }

  clear(prefix: string): Promise<void> {
    const error = this.enter('clear', [prefix]);
    if (error) return Promise.reject(error);
    for (const key of [...this.data.keys()]) {
      if (key.startsWith(prefix)) this.data.delete(key);
    }
    return Promise.resolve();
  }
}
