import { CacheConfigError } from '../errors.js';
import { mgetBySlot, scanNodes, unlinkBySlot } from './cluster-ops.js';
import { RELEASE_SCRIPT } from './redis-client.adapter.js';
import type { RedisClientAdapter, RedisSubscriberAdapter } from './redis-client.adapter.js';
import { closeWithTimeout, createSubscriptionTracker } from './subscriber-support.js';

/** Re-exported for existing imports; the script lives in `redis-client.adapter.ts`. */
export { RELEASE_SCRIPT };

/**
 * Structural subset of an ioredis client (v5 and v6). Declared by hand so the
 * library never imports ioredis.
 *
 * Structural subset of ioredis ≥ 5. Implemented by you. In 1.x, members are only added as optional,
 * and the library checks that they exist before calling them.
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
  /** Optional. Used by health checks; the adapter exposes `ping` only when it exists. */
  ping?(): Promise<unknown>;
  /** Optional. Used by batch reads; the adapter exposes `mget` only when it exists. */
  mget?(...keys: string[]): Promise<(string | null)[]>;
  duplicate(): IoredisLike;
  subscribe(...channels: string[]): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  quit(): Promise<unknown>;
  /** Optional. Closes the connection at once; used when `quit` does not settle in time. */
  disconnect?(): void;
}

/** The data commands a Cluster shares with a single-node client. */
type IoredisCommands = Omit<IoredisLike, 'duplicate' | 'on'>;

/**
 * Structural subset of an ioredis `Cluster` (ioredis 5.6.0 or later, for sharded pub/sub).
 * Declared by hand so the library never imports ioredis. `ioredisAdapter` runs in Cluster mode
 * when `isCluster` is `true`.
 *
 * Structural subset of ioredis ≥ 5. Implemented by you. In 1.x, members are only added as optional,
 * and the library checks that they exist before calling them.
 */
export interface IoredisClusterLike extends IoredisCommands {
  readonly isCluster: boolean;
  /** The master nodes; `scanIterator` scans each of them. */
  nodes(role: 'master'): IoredisLike[];
  spublish(channel: string, message: string): Promise<unknown>;
  ssubscribe(...channels: string[]): Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cluster's EventEmitter `on` takes `(...args: any[]) => void`, which `never[]` does not accept
  on(event: string, listener: (...args: any[]) => void): unknown;
  /** The adapter's subscriber is `duplicate([], { shardedSubscribers: true })`. */
  duplicate(
    startupNodes?: unknown[],
    options?: { shardedSubscribers?: boolean },
  ): IoredisClusterLike;
}

function isClusterClient(client: IoredisLike | IoredisClusterLike): client is IoredisClusterLike {
  return (client as Partial<IoredisClusterLike>).isCluster === true;
}

/**
 * Adapts an ioredis client or Cluster to `RedisClientAdapter`. `redisStore` does this itself;
 * call it to wrap or decorate the adapter.
 */
export function ioredisAdapter(client: IoredisLike | IoredisClusterLike): RedisClientAdapter {
  const adapter: RedisClientAdapter = {
    async get(key) {
      return (await client.get(key)) ?? undefined;
    },
    async set(key, value, ttlMs) {
      await client.set(key, value, 'PX', Math.ceil(ttlMs));
    },
    async getex(key, ttlMs) {
      return (await client.getex(key, 'PX', Math.ceil(ttlMs))) ?? undefined;
    },
    async setIfAbsent(key, value, ttlMs) {
      return (await client.set(key, value, 'PX', ttlMs, 'NX')) === 'OK';
    },
    async deleteIfEquals(key, value) {
      return (await client.eval(RELEASE_SCRIPT, 1, key, value)) === 1;
    },
    ...(isClusterClient(client) ? clusterCommands(client) : singleNodeCommands(client)),
  };
  // Optional members exist only when the client has them, so `'ping' in adapter` is truthful.
  if (typeof client.ping === 'function') {
    adapter.ping = async () => {
      await client.ping?.();
    };
  }
  if (typeof client.mget === 'function') {
    const mget = async (keys: readonly string[]): Promise<(string | undefined)[]> => {
      if (keys.length === 0) return [];
      const values = (await client.mget?.(...keys)) ?? [];
      return keys.map((_, index) => values[index] ?? undefined);
    };
    // A Cluster rejects a multi-key command across slots (CROSSSLOT): one MGET per slot.
    adapter.mget = isClusterClient(client) ? (keys) => mgetBySlot(keys, mget) : mget;
  }
  return adapter;
}

type KeyspaceCommands = Pick<
  RedisClientAdapter,
  'unlink' | 'scan' | 'publish' | 'createSubscriber' | 'scanIterator'
>;

function singleNodeCommands(client: IoredisLike): KeyspaceCommands {
  return {
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
      return createSubscriber(client.duplicate(), false);
    },
  };
}

/** Spec 3.3: multi-key commands per slot, SCAN on every master, sharded pub/sub. */
function clusterCommands(client: IoredisClusterLike): KeyspaceCommands {
  return {
    unlink(keys) {
      return unlinkBySlot(keys, async (slotKeys) => {
        await client.unlink(...slotKeys);
      });
    },
    scan() {
      return Promise.reject(
        new CacheConfigError(
          'ioredisAdapter: scan is not supported on a Redis Cluster client, because one cursor covers one node; use scanIterator, which scans every master',
        ),
      );
    },
    scanIterator(match, count) {
      return scanMasters(client, match, count);
    },
    async publish(channel, message) {
      await client.spublish(channel, message);
    },
    createSubscriber() {
      // Without shardedSubscribers, ioredis sends SSUBSCRIBE to a random node and gets MOVED.
      return createSubscriber(client.duplicate([], { shardedSubscribers: true }), true);
    },
  };
}

/**
 * Reads the masters when iteration starts, so a topology change before `clear` is seen. Rejects
 * when none is known (a `lazyConnect` Cluster before its first command): scanning zero masters
 * would let `clear` succeed without deleting anything.
 */
async function* scanMasters(
  client: IoredisClusterLike,
  match: string,
  count: number,
): AsyncIterable<string[]> {
  yield* scanNodes(
    client.nodes('master'),
    async (node, cursor) => {
      const [next, keys] = await node.scan(cursor, 'MATCH', match, 'COUNT', count);
      return { cursor: next, keys };
    },
    'ioredisAdapter: no cluster master is known yet, so the keyspace cannot be scanned',
  );
}

/**
 * The subscriber over a dedicated connection. With `sharded` and a Cluster connection, it sends
 * SSUBSCRIBE and listens to 'smessage'; otherwise SUBSCRIBE and 'message'. One flag decides both,
 * so the command and the listened event always match. Retries, reconnects and close follow the
 * shared `createSubscriptionTracker`.
 */
function createSubscriber(
  connection: IoredisLike | IoredisClusterLike,
  sharded: boolean,
): RedisSubscriberAdapter {
  const shardedConnection = sharded && isClusterClient(connection) ? connection : undefined;
  const tracker = createSubscriptionTracker({
    subscribe: (channel) =>
      shardedConnection === undefined
        ? connection.subscribe(channel)
        : shardedConnection.ssubscribe(channel),
    close: () => closeConnection(connection),
  });
  // Without an 'error' listener ioredis prints "Unhandled error event" on every failed reconnect.
  connection.on('error', (error: unknown) => {
    tracker.error(error);
  });
  connection.on(
    shardedConnection === undefined ? 'message' : 'smessage',
    (channel: string, message: string) => {
      tracker.deliver(channel, message);
    },
  );
  connection.on('ready', () => {
    tracker.ready();
  });
  return tracker.subscriber;
}

/** QUIT, or drop the connection if QUIT has not settled in time. Never rejects. */
function closeConnection(connection: IoredisLike | IoredisClusterLike): Promise<void> {
  return closeWithTimeout(
    () => connection.quit(),
    () => {
      connection.disconnect?.();
    },
  );
}

export function isRedisClientAdapter(
  value: IoredisLike | IoredisClusterLike | RedisClientAdapter,
): value is RedisClientAdapter {
  return typeof (value as Partial<RedisClientAdapter>).createSubscriber === 'function';
}
