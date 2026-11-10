import { randomUUID } from 'node:crypto';
import type { LockHandle, LockProvider } from './cache-store.interface.js';
import type { RedisClientAdapter } from './redis-client.adapter.js';

/** Deletes the key only when it still holds our token. */
export const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** Lock over Redis `SET NX PX` with a token-checked release. */
export class RedisLock implements LockProvider {
  constructor(
    private readonly adapter: Required<Pick<RedisClientAdapter, 'setIfAbsent' | 'deleteIfEquals'>>,
  ) {}

  async acquire(key: string, ttlMs: number): Promise<LockHandle | undefined> {
    const lockKey = `lock:${key}`;
    const token = randomUUID();
    const acquired = await this.adapter.setIfAbsent(lockKey, token, Math.max(1, Math.round(ttlMs)));
    if (!acquired) return undefined;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await this.adapter.deleteIfEquals(lockKey, token);
      },
    };
  }
}
