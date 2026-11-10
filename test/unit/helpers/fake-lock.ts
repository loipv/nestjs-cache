import type { LockHandle, LockProvider } from '../../../src/stores/cache-store.interface.js';

type LockOp = 'acquire' | 'release';

/** In-memory lock: `held` holds the keys currently locked by anyone. Never waits. */
export class FakeLock implements LockProvider {
  readonly held = new Set<string>();
  readonly acquireCalls: string[] = [];
  readonly acquireTtls: number[] = [];
  readonly releaseCalls: string[] = [];
  private readonly failures = new Map<LockOp, Error[]>();

  failNext(op: LockOp, error: Error = new Error(`${op} failed`)): void {
    const queue = this.failures.get(op) ?? [];
    queue.push(error);
    this.failures.set(op, queue);
  }

  acquire(key: string, ttlMs: number): Promise<LockHandle | undefined> {
    this.acquireCalls.push(key);
    this.acquireTtls.push(ttlMs);
    const error = this.failures.get('acquire')?.shift();
    if (error) return Promise.reject(error);
    if (this.held.has(key)) return Promise.resolve(undefined);
    this.held.add(key);
    let released = false;
    return Promise.resolve({
      release: (): Promise<void> => {
        this.releaseCalls.push(key);
        const failure = this.failures.get('release')?.shift();
        if (failure) return Promise.reject(failure);
        // A second release is a no-op, so a stale handle never frees a later owner's lock.
        if (!released) {
          released = true;
          this.held.delete(key);
        }
        return Promise.resolve();
      },
    });
  }
}
