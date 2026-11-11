import { randomUUID } from 'node:crypto';

const PROBE_WAIT_MS = 3_000;
/** How long the probe waits for its temporary connection or subscription to close. */
const CLOSE_WAIT_MS = 1_000;

/** A pub/sub listener as node-redis types it for either mode: string or buffer messages. */
type AnyModeListener = (message: string | Uint8Array, channel: string | Uint8Array) => void;

/** The connection an ioredis `duplicate()` gives (a `Redis`, or a `Cluster` for a cluster). */
export interface IoredisProbeConnection {
  subscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  disconnect(): void;
}

/** A raw ioredis `Redis` (standalone or Sentinel) or `Cluster`. */
export interface IoredisProbeClient {
  duplicate(): IoredisProbeConnection;
  publish(channel: string, message: string): Promise<unknown>;
}

/** The connection a node-redis `duplicate()` gives: a new, unconnected client or cluster. */
export interface NodeRedisProbeConnection {
  connect(): Promise<unknown>;
  subscribe(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): Promise<unknown>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  destroy(): void;
}

/** A raw node-redis client (`createClient`) or cluster (`createCluster`), connected. */
export interface NodeRedisProbeClient {
  duplicate(): NodeRedisProbeConnection;
  publish(channel: string, message: string): Promise<unknown>;
}

/** A raw node-redis Sentinel (`createSentinel`), connected: it has its own pub/sub connection. */
export interface NodeRedisSentinelProbeClient {
  subscribe(channel: string, listener: AnyModeListener): Promise<unknown>;
  unsubscribe(channel: string, listener: AnyModeListener): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
}

/**
 * The raw client the probe drives, never the library's adapter: a pub/sub bug in an adapter must
 * fail the pub/sub cases, not make the probe skip them (final review I-1).
 */
export type ProbeClient =
  | { kind: 'ioredis'; client: IoredisProbeClient }
  | { kind: 'node-redis'; client: NodeRedisProbeClient }
  | { kind: 'node-redis-sentinel'; client: NodeRedisSentinelProbeClient };

/** One probe's temporary subscription; `close` releases whatever it opened. */
interface ProbeSession {
  subscribe(channel: string, onMessage: () => void): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  close(): Promise<unknown>;
}

const ignore = (): void => undefined;

/**
 * ioredis: a duplicate connection subscribes, the client publishes. On a cluster a plain
 * SUBSCRIBE reaches one node and PUBLISH is broadcast to every node, which is enough to tell
 * whether the host can reach the nodes' pub/sub.
 */
function ioredisSession(client: IoredisProbeClient): ProbeSession {
  const connection = client.duplicate();
  connection.on('error', ignore);
  return {
    subscribe: (channel, onMessage) => {
      connection.on('message', (received) => {
        if (received === channel) onMessage();
      });
      return connection.subscribe(channel);
    },
    publish: (channel, message) => client.publish(channel, message),
    close: async () => {
      connection.disconnect();
    },
  };
}

/** node-redis client or cluster: a duplicate connects and subscribes, the client publishes. */
function nodeRedisSession(client: NodeRedisProbeClient): ProbeSession {
  const connection = client.duplicate();
  connection.on('error', ignore);
  let connected = false;
  return {
    subscribe: async (channel, onMessage) => {
      connected = true;
      await connection.connect();
      return connection.subscribe(channel, onMessage);
    },
    publish: (channel, message) => client.publish(channel, message),
    close: async () => {
      // destroy throws on a connection that never opened or already closed.
      if (connected) connection.destroy();
    },
  };
}

/**
 * node-redis Sentinel: it subscribes on its own pub/sub connection, the same one the adapter uses
 * (ruling T1-A), and close removes the probe's listener; the Sentinel itself is the caller's.
 */
function sentinelSession(client: NodeRedisSentinelProbeClient): ProbeSession {
  let subscribed: { channel: string; listener: AnyModeListener } | undefined;
  return {
    subscribe: (channel, onMessage) => {
      const listener: AnyModeListener = () => {
        onMessage();
      };
      subscribed = { channel, listener };
      return client.subscribe(channel, listener).catch((error: unknown) => {
        // Not subscribed, so there is nothing to unsubscribe.
        subscribed = undefined;
        throw error;
      });
    },
    publish: (channel, message) => client.publish(channel, message),
    close: () =>
      subscribed === undefined
        ? Promise.resolve()
        : client.unsubscribe(subscribed.channel, subscribed.listener),
  };
}

function openSession(probe: ProbeClient): ProbeSession {
  switch (probe.kind) {
    case 'ioredis':
      return ioredisSession(probe.client);
    case 'node-redis':
      return nodeRedisSession(probe.client);
    case 'node-redis-sentinel':
      return sentinelSession(probe.client);
  }
}

/** Runs `close`, giving up after `CLOSE_WAIT_MS`; never rejects. */
async function closeQuietly(close: () => Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise((resolve) => {
        resolve(close());
      }),
      new Promise((resolve) => {
        timer = setTimeout(resolve, CLOSE_WAIT_MS);
      }),
    ]);
  } catch {
    // a probe must not throw, whatever close does
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a message the raw client publishes reaches a subscription made from it within 3 s.
 * Resolves `false` on a timeout or any error and never throws; the temporary connection (or, on a
 * node-redis Sentinel, the subscription) is always closed, within 1 s.
 * Ruling T1-B: redis (node-redis) v5 applies `nodeAddressMap` to a Sentinel's data clients but not
 * to its pub/sub proxy, so from the host that SUBSCRIBE never connects (v6.3.1 fixes it).
 */
export async function probePubSub(probe: ProbeClient): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let session: ProbeSession | undefined;
  try {
    const opened = openSession(probe);
    session = opened;
    const channel = `probe:${randomUUID()}`;
    return await new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, PROBE_WAIT_MS);
      // The executor turns a synchronous throw of subscribe into a rejection.
      new Promise((subscribed) => {
        subscribed(
          opened.subscribe(channel, () => {
            resolve(true);
          }),
        );
      })
        .then(() => opened.publish(channel, 'ping'))
        .catch(() => {
          resolve(false);
        });
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    const opened = session;
    if (opened !== undefined) await closeQuietly(() => opened.close());
  }
}
