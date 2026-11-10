import { randomUUID } from 'node:crypto';
import type { LockHandle, LockProvider } from './cache-store.interface.js';
import type { RedisClientAdapter } from './redis-client.adapter.js';

/** Lock over Redis `SET NX PX` with a token-checked release. */
export class RedisLock implements LockProvider {
  constructor(
    private readonly adapter: Required<Pick<RedisClientAdapter, 'setIfAbsent' | 'deleteIfEquals'>>,
  ) {}

  /** `key` is the complete lock key, used verbatim. `ttlMs` is rounded up to an integer >= 1, as `ioredisAdapter` rounds its TTLs. */
  async acquire(key: string, ttlMs: number): Promise<LockHandle | undefined> {
    const token = randomUUID();
    const acquired = await this.adapter.setIfAbsent(key, token, Math.max(1, Math.ceil(ttlMs)));
    if (!acquired) return undefined;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await this.adapter.deleteIfEquals(key, token);
      },
    };
  }
}
