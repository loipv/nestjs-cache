import type { RedisClientAdapter, RedisSubscriberAdapter } from './redis-client.adapter.js';

/**
 * Structural subset of an ioredis client (v5 and v6). Declared by hand so the
 * library never imports ioredis.
 */
export interface IoredisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  set(key: string, value: string, mode: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
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
  ping(): Promise<unknown>;
  duplicate(): IoredisLike;
  subscribe(...channels: string[]): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  quit(): Promise<unknown>;
  /** Optional. Closes the connection at once; used when `quit` does not settle in time. */
  disconnect?(): void;
}

/** Deletes the key only when it still holds the caller's token (the `RedisLock` release). */
export const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** How long `close` waits for QUIT before it drops the subscriber connection. */
const CLOSE_TIMEOUT_MS = 1_000;

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
    async setIfAbsent(key, value, ttlMs) {
      return (await client.set(key, value, 'PX', ttlMs, 'NX')) === 'OK';
    },
    async deleteIfEquals(key, value) {
      return (await client.eval(RELEASE_SCRIPT, 1, key, value)) === 1;
    },
    async ping() {
      await client.ping();
    },
    async publish(channel, message) {
      await client.publish(channel, message);
    },
    createSubscriber() {
      return createSubscriber(client.duplicate());
    },
  };
}

interface Subscription {
  status: 'pending' | 'ok' | 'failed';
  done: Promise<void>;
}

/** Calls every handler; a throwing handler never reaches the others or the ioredis emitter. */
function notifyAll<A extends unknown[]>(
  handlers: readonly ((...args: A) => void)[],
  ...args: A
): void {
  for (const handler of handlers) {
    try {
      handler(...args);
    } catch {
      // swallowed: this runs inside ioredis event listeners
    }
  }
}

function createSubscriber(connection: IoredisLike): RedisSubscriberAdapter {
  const handlers = new Map<string, (message: string) => void>();
  /**
   * The latest SUBSCRIBE per channel. ioredis restores a channel on reconnect only once a
   * SUBSCRIBE was confirmed, so channels whose SUBSCRIBE failed are sent again on 'ready'.
   */
  const subscriptions = new Map<string, Subscription>();
  const reconnectHandlers: Array<() => void> = [];
  const errorHandlers: Array<(error: unknown) => void> = [];
  let readyCount = 0;
  let closing: Promise<void> | undefined;

  const send = (channel: string): Promise<void> => {
    const subscription: Subscription = { status: 'pending', done: Promise.resolve() };
    // The executor turns a synchronous throw into a rejection, so nothing throws into ioredis.
    const sent = new Promise((resolve) => {
      resolve(connection.subscribe(channel));
    });
    subscription.done = sent.then(
      () => {
        subscription.status = 'ok';
      },
      (error: unknown) => {
        subscription.status = 'failed';
        throw error;
      },
    );
    subscriptions.set(channel, subscription);
    return subscription.done;
  };

  // Without an 'error' listener ioredis prints "Unhandled error event" on every failed reconnect.
  connection.on('error', (error: unknown) => {
    notifyAll(errorHandlers, error);
  });
  connection.on('message', (channel: string, message: string) => {
    handlers.get(channel)?.(message);
  });
  connection.on('ready', () => {
    readyCount += 1;
    if (readyCount > 1) notifyAll(reconnectHandlers);
    if (closing !== undefined) return;
    for (const [channel, subscription] of subscriptions) {
      if (subscription.status !== 'failed') continue;
      // Messages published while the channel was not subscribed are lost: treat it as a reconnect.
      send(channel).then(
        () => {
          notifyAll(reconnectHandlers);
        },
        (error: unknown) => {
          notifyAll(errorHandlers, error);
        },
      );
    }
  });

  return {
    subscribe(channel, onMessage) {
      handlers.set(channel, onMessage);
      const current = subscriptions.get(channel);
      if (current !== undefined && current.status !== 'failed') return current.done;
      return send(channel);
    },
    onReconnect(handler) {
      reconnectHandlers.push(handler);
    },
    onError(handler) {
      errorHandlers.push(handler);
    },
    close() {
      closing ??= closeConnection(connection);
      return closing;
    },
  };
}

/** QUIT, or drop the connection if QUIT has not settled after `CLOSE_TIMEOUT_MS`. Never rejects. */
async function closeConnection(connection: IoredisLike): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(true);
    }, CLOSE_TIMEOUT_MS);
  });
  const quit = new Promise((resolve) => {
    resolve(connection.quit());
  }).then(
    () => false,
    () => true,
  );
  const force = await Promise.race([quit, timedOut]);
  clearTimeout(timer);
  if (!force) return;
  try {
    connection.disconnect?.();
  } catch {
    // close never rejects
  }
}

export function isRedisClientAdapter(
  value: IoredisLike | RedisClientAdapter,
): value is RedisClientAdapter {
  return typeof (value as Partial<RedisClientAdapter>).createSubscriber === 'function';
}
