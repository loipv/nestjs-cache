import { CacheConfigError } from '../errors.js';
import { mgetBySlot, scanNodes, unlinkBySlot } from './cluster-ops.js';
import { RELEASE_SCRIPT } from './redis-client.adapter.js';
import type { RedisClientAdapter, RedisSubscriberAdapter } from './redis-client.adapter.js';
import { closeWithTimeout, createSubscriptionTracker } from './subscriber-support.js';

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
 * Structural subset of a node-redis v5 cluster (`createCluster()` from `redis`). Declared by hand
 * so the library never imports `redis`. `nodeRedisAdapter` runs in cluster mode when the client
 * has `masters`. Like a single client, it must be connected before it is passed in.
 */
export interface NodeRedisClusterLike extends Omit<NodeRedisLike, 'scan' | 'duplicate'> {
  /** The master nodes, passed back to `nodeClient`; `scanIterator` scans each of them. */
  readonly masters: readonly unknown[];
  /** The client of one master node. */
  nodeClient(master: unknown): Promise<Pick<NodeRedisLike, 'scan'>>;
  sPublish(channel: string, message: string): Promise<unknown>;
  sSubscribe(channel: string, listener: PubSubListener): Promise<unknown>;
  /** The subscriber's dedicated connection: a new, unconnected cluster. */
  duplicate(): NodeRedisClusterLike;
}

/**
 * The connection the subscriber drives: a single client, or a cluster (sharded mode), which also
 * has `sSubscribe`.
 */
type SubscriberConnection = Pick<
  NodeRedisLike,
  'connect' | 'subscribe' | 'close' | 'destroy' | 'on'
> & {
  sSubscribe?(channel: string, listener: PubSubListener): Promise<unknown>;
};

/**
 * Adapts a connected node-redis v5 client or cluster to the cache's `RedisClientAdapter`. A
 * cluster (spec 3.4) splits `mget`/`unlink` per slot, scans every master through `scanIterator`,
 * and publishes and subscribes with sharded pub/sub.
 */
export function nodeRedisAdapter(client: NodeRedisLike | NodeRedisClusterLike): RedisClientAdapter {
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
    ...('masters' in client ? clusterCommands(client) : singleNodeCommands(client)),
  };
  // Optional members exist only when the client has them, so `'ping' in adapter` is truthful.
  if (typeof client.ping === 'function') {
    adapter.ping = async () => {
      await client.ping?.();
    };
  }
  return adapter;
}

type KeyspaceCommands = Pick<
  RedisClientAdapter,
  'unlink' | 'mget' | 'scan' | 'publish' | 'createSubscriber' | 'scanIterator'
>;

/** MGET; `null` becomes `undefined` and the values keep the key order. */
async function mgetValues(
  client: Pick<NodeRedisLike, 'mGet'>,
  keys: readonly string[],
): Promise<(string | undefined)[]> {
  if (keys.length === 0) return [];
  const values = await client.mGet([...keys]);
  return keys.map((_, index) => values[index] ?? undefined);
}

function singleNodeCommands(client: NodeRedisLike): KeyspaceCommands {
  return {
    async unlink(keys) {
      if (keys.length === 0) return;
      await client.unlink([...keys]);
    },
    mget(keys) {
      return mgetValues(client, keys);
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
}

/** Spec 3.4: multi-key commands per slot, SCAN on every master, sharded pub/sub. */
function clusterCommands(client: NodeRedisClusterLike): KeyspaceCommands {
  return {
    unlink(keys) {
      return unlinkBySlot(keys, async (slotKeys) => {
        await client.unlink(slotKeys);
      });
    },
    // A cluster rejects a multi-key command across slots (CROSSSLOT): one MGET per slot.
    mget(keys) {
      return mgetBySlot(keys, (slotKeys) => mgetValues(client, slotKeys));
    },
    scan() {
      return Promise.reject(
        new CacheConfigError(
          'nodeRedisAdapter: scan is not supported on a Redis cluster client, because one cursor covers one node; use scanIterator, which scans every master',
        ),
      );
    },
    scanIterator(match, count) {
      return scanMasters(client, match, count);
    },
    async publish(channel, message) {
      await client.sPublish(channel, message);
    },
    createSubscriber() {
      return createNodeRedisSubscriber(client.duplicate(), true);
    },
  };
}

/**
 * Reads the masters when iteration starts, so a topology change before `clear` is seen. Rejects
 * when none is known: scanning zero masters would let `clear` succeed without deleting anything.
 */
async function* scanMasters(
  client: NodeRedisClusterLike,
  match: string,
  count: number,
): AsyncIterable<string[]> {
  const masters = [...client.masters];
  if (masters.length === 0) {
    throw new Error(
      'nodeRedisAdapter: no cluster master is known yet, so the keyspace cannot be scanned',
    );
  }
  yield* scanNodes(masters, async (master, cursor) => {
    const node = await client.nodeClient(master);
    const reply = await node.scan(cursor, { MATCH: match, COUNT: count });
    return { cursor: reply.cursor, keys: reply.keys };
  });
}

/**
 * The subscriber over a dedicated, not yet connected node-redis connection. The first `subscribe`
 * connects it; a rejected connect is forgotten, so a later `subscribe` connects again. With
 * `sharded` (a cluster) it sends SSUBSCRIBE, otherwise SUBSCRIBE. Retries, reconnects and close
 * follow the shared `createSubscriptionTracker`: node-redis restores confirmed subscriptions after
 * a reconnect, and a SUBSCRIBE that rejected is sent again on the next 'ready'.
 */
export function createNodeRedisSubscriber(
  connection: SubscriberConnection,
  sharded: boolean,
): RedisSubscriberAdapter {
  let connecting: Promise<unknown> | undefined;
  let closed = false;

  const connect = (): Promise<unknown> => {
    if (closed) return Promise.reject(new Error('nodeRedisAdapter: the subscriber is closed'));
    // The executor turns a synchronous throw into a rejection.
    connecting ??= new Promise((resolve) => {
      resolve(connection.connect());
    }).catch((error: unknown) => {
      connecting = undefined;
      throw error;
    });
    return connecting;
  };

  // One listener for every channel; the tracker swallows a throwing handler.
  const deliver: PubSubListener = (message, channel) => {
    tracker.deliver(channel, message);
  };

  const subscribeCommand = (channel: string): Promise<unknown> => {
    if (closed) {
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

  const tracker = createSubscriptionTracker({
    subscribe: (channel) => connect().then(() => subscribeCommand(channel)),
    close: () => {
      closed = true;
      return closeWithTimeout(
        () => connection.close(),
        () => {
          connection.destroy();
        },
      );
    },
  });

  // Without an 'error' listener, an error emitted while node-redis reconnects would crash.
  connection.on('error', (error: unknown) => {
    tracker.error(error);
  });
  if (sharded) {
    // A cluster re-emits each node client's errors as 'node-error' (error, clientInfo).
    connection.on('node-error', (error: unknown) => {
      tracker.error(error);
    });
  }
  // A cluster never emits 'ready', so the cluster (sharded) subscriber never fires onReconnect:
  // 'node-ready' is registered once per node client and 'node-reconnecting' fires before the
  // reconnect completes. After a cluster reconnect, L1 staleness is bounded by l1Ttl.
  connection.on('ready', () => {
    tracker.ready();
  });
  return tracker.subscriber;
}
