import type { RedisClientAdapter, RedisSubscriberAdapter } from './redis-client.adapter.js';

/**
 * Structural subset of an ioredis client (v5 and v6). Declared by hand so the
 * library never imports ioredis.
 */
export interface IoredisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  getex(key: string, mode: 'PX', ttlMs: number): Promise<string | null>;
  unlink(...keys: string[]): Promise<unknown>;
  scan(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[cursor: string, keys: string[]]>;
  publish(channel: string, message: string): Promise<unknown>;
  duplicate(): IoredisLike;
  subscribe(...channels: string[]): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  quit(): Promise<unknown>;
}

export function ioredisAdapter(client: IoredisLike): RedisClientAdapter {
  return {
    async get(key) {
      return (await client.get(key)) ?? undefined;
    },
    async set(key, value, ttlMs) {
      await client.set(key, value, 'PX', Math.ceil(ttlMs));
    },
    async getex(key, ttlMs) {
      return (await client.getex(key, 'PX', Math.ceil(ttlMs))) ?? undefined;
    },
    async unlink(keys) {
      if (keys.length === 0) return;
      await client.unlink(...keys);
    },
    async scan(cursor, match, count) {
      const [next, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', count);
      return { cursor: next, keys };
    },
    async publish(channel, message) {
      await client.publish(channel, message);
    },
    createSubscriber() {
      return createSubscriber(client.duplicate());
    },
  };
}

function createSubscriber(connection: IoredisLike): RedisSubscriberAdapter {
  const handlers = new Map<string, (message: string) => void>();
  const reconnectHandlers: Array<() => void> = [];
  let readyCount = 0;
  let closing: Promise<void> | undefined;

  connection.on('message', (channel: string, message: string) => {
    handlers.get(channel)?.(message);
  });
  connection.on('ready', () => {
    readyCount += 1;
    if (readyCount > 1) for (const handler of reconnectHandlers) handler();
  });

  return {
    async subscribe(channel, onMessage) {
      handlers.set(channel, onMessage);
      await connection.subscribe(channel);
    },
    onReconnect(handler) {
      reconnectHandlers.push(handler);
    },
    close() {
      closing ??= connection.quit().then(() => undefined);
      return closing;
    },
  };
}

export function isRedisClientAdapter(
  value: IoredisLike | RedisClientAdapter,
): value is RedisClientAdapter {
  return typeof (value as Partial<RedisClientAdapter>).createSubscriber === 'function';
}
