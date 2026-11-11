import { RELEASE_SCRIPT } from './redis-client.adapter.js';
import type { RedisClientAdapter, RedisSubscriberAdapter } from './redis-client.adapter.js';
import { closeWithTimeout, notifyAll } from './subscriber-support.js';

/** node-redis's pub/sub listener: it receives the message first, then the channel. */
type PubSubListener = (message: string, channel: string) => void;

/**
 * Structural subset of a node-redis v5 client (`createClient()` from `redis`). Declared by hand so
 * the library never imports `redis`. The client must be connected before it is passed to
 * `nodeRedisAdapter`; the library never connects it.
 */
export interface NodeRedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { expiration: { type: 'PX'; value: number }; condition?: 'NX' },
  ): Promise<string | null>;
  getEx(key: string, options: { type: 'PX'; value: number }): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  unlink(keys: string[]): Promise<unknown>;
  mGet(keys: string[]): Promise<(string | null)[]>;
  /** Optional. Used by health checks; the adapter exposes `ping` only when it exists. */
  ping?(): Promise<unknown>;
  scan(
    cursor: string,
    options: { MATCH: string; COUNT: number },
  ): Promise<{ cursor: string; keys: string[] }>;
  publish(channel: string, message: string): Promise<unknown>;
  /** The subscriber's dedicated connection: a new, unconnected client. */
  duplicate(): NodeRedisLike;
  connect(): Promise<unknown>;
  subscribe(channel: string, listener: PubSubListener): Promise<unknown>;
  close(): Promise<unknown>;
  destroy(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- node-redis's EventEmitter `on` takes `(...args: any[]) => void`, which `never[]` does not accept
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * The connection the subscriber drives. A cluster connection (sharded mode) also has
 * `sSubscribe`.
 */
type SubscriberConnection = Pick<
  NodeRedisLike,
  'connect' | 'subscribe' | 'close' | 'destroy' | 'on'
> & {
  sSubscribe?(channel: string, listener: PubSubListener): Promise<unknown>;
};

/** Adapts a connected node-redis v5 client to the cache's `RedisClientAdapter`. */
export function nodeRedisAdapter(client: NodeRedisLike): RedisClientAdapter {
  const adapter: RedisClientAdapter = {
    async get(key) {
      return (await client.get(key)) ?? undefined;
    },
    async set(key, value, ttlMs) {
      await client.set(key, value, { expiration: { type: 'PX', value: Math.ceil(ttlMs) } });
    },
    async getex(key, ttlMs) {
      return (await client.getEx(key, { type: 'PX', value: Math.ceil(ttlMs) })) ?? undefined;
    },
    async setIfAbsent(key, value, ttlMs) {
      const reply = await client.set(key, value, {
        expiration: { type: 'PX', value: Math.ceil(ttlMs) },
        condition: 'NX',
      });
      return reply === 'OK';
    },
    async deleteIfEquals(key, value) {
      return (await client.eval(RELEASE_SCRIPT, { keys: [key], arguments: [value] })) === 1;
    },
    async unlink(keys) {
      if (keys.length === 0) return;
      await client.unlink([...keys]);
    },
    async mget(keys) {
      if (keys.length === 0) return [];
      const values = await client.mGet([...keys]);
      return keys.map((_, index) => values[index] ?? undefined);
    },
    async scan(cursor, match, count) {
      const reply = await client.scan(cursor, { MATCH: match, COUNT: count });
      return { cursor: reply.cursor, keys: reply.keys };
    },
    async publish(channel, message) {
      await client.publish(channel, message);
    },
    createSubscriber() {
      return createNodeRedisSubscriber(client.duplicate(), false);
    },
  };
  // Optional members exist only when the client has them, so `'ping' in adapter` is truthful.
  if (typeof client.ping === 'function') {
    adapter.ping = async () => {
      await client.ping?.();
    };
  }
  return adapter;
}

interface Subscription {
  status: 'pending' | 'ok' | 'failed';
  done: Promise<void>;
}

/**
 * The subscriber over a dedicated, not yet connected node-redis connection. The first `subscribe`
 * connects it; a rejected connect is forgotten, so a later `subscribe` connects again. With
 * `sharded` (a cluster) it sends SSUBSCRIBE, otherwise SUBSCRIBE. node-redis restores confirmed
 * subscriptions after a reconnect; a SUBSCRIBE that rejected is sent again on the next 'ready'.
 */
export function createNodeRedisSubscriber(
  connection: SubscriberConnection,
  sharded: boolean,
): RedisSubscriberAdapter {
  const handlers = new Map<string, (message: string) => void>();
  const subscriptions = new Map<string, Subscription>();
  const reconnectHandlers: Array<() => void> = [];
  const errorHandlers: Array<(error: unknown) => void> = [];
  let readyCount = 0;
  let connecting: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;

  // One listener for every channel; it runs inside node-redis's reply parser, so it never throws.
  const deliver: PubSubListener = (message, channel) => {
    try {
      handlers.get(channel)?.(message);
    } catch {
      // swallowed: a throwing handler must not reach node-redis
    }
  };

  const connect = (): Promise<unknown> => {
    // The executor turns a synchronous throw into a rejection.
    connecting ??= new Promise((resolve) => {
      resolve(connection.connect());
    }).catch((error: unknown) => {
      connecting = undefined;
      throw error;
    });
    return connecting;
  };

  const subscribeCommand = (channel: string): Promise<unknown> => {
    if (closing !== undefined) {
      return Promise.reject(new Error('nodeRedisAdapter: the subscriber was closed'));
    }
    if (!sharded) return connection.subscribe(channel, deliver);
    if (connection.sSubscribe === undefined) {
      return Promise.reject(
        new Error('nodeRedisAdapter: sharded pub/sub needs a client with sSubscribe'),
      );
    }
    return connection.sSubscribe(channel, deliver);
  };

  const send = (channel: string): Promise<void> => {
    const subscription: Subscription = { status: 'pending', done: Promise.resolve() };
    subscription.done = connect()
      .then(() => subscribeCommand(channel))
      .then(
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

  // Without an 'error' listener, an error emitted while node-redis reconnects would crash.
  connection.on('error', (error: unknown) => {
    notifyAll(errorHandlers, error);
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
      closing ??= closeWithTimeout(
        () => connection.close(),
        () => {
          connection.destroy();
        },
      );
      return closing;
    },
  };
}
