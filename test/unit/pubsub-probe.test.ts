import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  probePubSub,
  type IoredisProbeClient,
  type NodeRedisProbeClient,
  type NodeRedisProbeConnection,
  type NodeRedisSentinelProbeClient,
} from '../integration/helpers/pubsub-probe.js';

type Deliver = (channel: string) => void;

/* Raw-client fakes for the three shapes the probe drives. `subscribe` decides what SUBSCRIBE
   does; by default `publish` delivers to the channel's subscription at once. */
function fakeIoredis(
  behaviour: { subscribe?: () => Promise<unknown>; otherChannel?: boolean } = {},
) {
  let onMessage: ((channel: string, message: string) => void) | undefined;
  const disconnect = vi.fn();
  const connection = {
    subscribe: vi.fn<(channel: string) => Promise<unknown>>(
      behaviour.subscribe ?? (() => Promise.resolve(1)),
    ),
    on: (event: string, listener: (channel: string, message: string) => void) => {
      if (event === 'message') onMessage = listener;
      return connection;
    },
    disconnect,
  };
  const client: IoredisProbeClient = {
    duplicate: () => connection,
    publish: vi.fn((channel: string, message: string) => {
      onMessage?.(behaviour.otherChannel === true ? `${channel}:other` : channel, message);
      return Promise.resolve(1);
    }),
  };
  return { client, connection, disconnect };
}

function fakeNodeRedis(
  behaviour: {
    connect?: () => Promise<unknown>;
    publish?: () => Promise<unknown>;
    destroy?: () => void;
  } = {},
) {
  const deliver: { to?: Deliver } = {};
  const destroy = vi.fn(behaviour.destroy ?? (() => undefined));
  const connection: NodeRedisProbeConnection = {
    connect: vi.fn(behaviour.connect ?? (() => Promise.resolve())),
    subscribe: vi.fn((channel: string, listener: (message: string, channel: string) => void) => {
      deliver.to = (published) => {
        if (published === channel) listener('ping', channel);
      };
      return Promise.resolve();
    }),
    on: () => connection,
    destroy,
  };
  const client: NodeRedisProbeClient = {
    duplicate: () => connection,
    publish: vi.fn(
      behaviour.publish ??
        ((channel: string) => {
          deliver.to?.(channel);
          return Promise.resolve(1);
        }),
    ),
  };
  return { client, connection, destroy };
}

function fakeSentinel(
  behaviour: { subscribe?: () => Promise<unknown>; unsubscribe?: () => Promise<unknown> } = {},
) {
  const listeners = new Map<string, (message: string, channel: string) => void>();
  const client = {
    subscribe: vi.fn((channel: string, listener: (message: string, channel: string) => void) => {
      listeners.set(channel, listener);
      return behaviour.subscribe?.() ?? Promise.resolve();
    }),
    unsubscribe: vi.fn(behaviour.unsubscribe ?? (() => Promise.resolve())),
    publish: vi.fn((channel: string, message: string) => {
      listeners.get(channel)?.(message, channel);
      return Promise.resolve(1);
    }),
  };
  return { client: client as NodeRedisSentinelProbeClient, spies: client };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('probePubSub', () => {
  it('ioredis: a duplicate subscribes, the raw client publishes, and the duplicate is closed', async () => {
    /* scenario (final review I-1): the probe drives the raw ioredis client, never the library's
       adapter, so a broken adapter publish fails the pub/sub cases instead of skipping them. */
    const { client, connection, disconnect } = fakeIoredis();
    expect(await probePubSub({ kind: 'ioredis', client })).toBe(true);
    const channel = connection.subscribe.mock.calls[0]?.[0];
    expect(channel).toMatch(/^probe:/);
    expect(client.publish).toHaveBeenCalledWith(channel, 'ping');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('node-redis: a connected duplicate subscribes, the raw client publishes, and it is destroyed', async () => {
    /* scenario (I-1): a node-redis client or cluster probes over its own duplicate connection. */
    const { client, connection, destroy } = fakeNodeRedis();
    expect(await probePubSub({ kind: 'node-redis', client })).toBe(true);
    expect(connection.connect).toHaveBeenCalledTimes(1);
    expect(client.publish).toHaveBeenCalledWith(expect.stringMatching(/^probe:/), 'ping');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("node-redis Sentinel: it subscribes on the Sentinel's own pub/sub and unsubscribes its listener", async () => {
    /* scenario (I-1): a Sentinel has no duplicate; the probe uses its pub/sub API directly and
       removes only its own listener, leaving the caller's Sentinel open. */
    const { client, spies } = fakeSentinel();
    expect(await probePubSub({ kind: 'node-redis-sentinel', client })).toBe(true);
    const [channel, listener] = spies.subscribe.mock.calls[0] ?? [];
    expect(spies.publish).toHaveBeenCalledWith(channel, 'ping');
    expect(spies.unsubscribe).toHaveBeenCalledWith(channel, listener);
  });

  it('resolves false at 3 s when the subscription never completes, and closes it', async () => {
    /* scenario: SUBSCRIBE hangs (node-redis v5 Sentinel from the host), so the timer decides;
       no timer is left behind. */
    vi.useFakeTimers();
    const { client, destroy } = fakeNodeRedis({ connect: () => new Promise(() => undefined) });
    const result = probePubSub({ kind: 'node-redis', client });
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(false);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves false when a message arrives on another channel only', async () => {
    /* scenario: the ioredis duplicate sees only its own probe channel as an answer. */
    vi.useFakeTimers();
    const { client, disconnect } = fakeIoredis({ otherChannel: true });
    const result = probePubSub({ kind: 'ioredis', client });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await result).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('gives a hanging Sentinel unsubscribe 1 s, then resolves anyway', async () => {
    /* scenario: on v5 the Sentinel's UNSUBSCRIBE can hang like its SUBSCRIBE; the probe still
       answers, 3 s for the wait plus at most 1 s for the close. */
    vi.useFakeTimers();
    const { client, spies } = fakeSentinel({
      subscribe: () => new Promise(() => undefined),
      unsubscribe: () => new Promise(() => undefined),
    });
    const result = probePubSub({ kind: 'node-redis-sentinel', client });
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(settled).toBe(false);
    expect(spies.unsubscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves false, without throwing, when subscribe or publish rejects, and still closes', async () => {
    /* scenario: errors at either step are an unreachable answer, never an exception. */
    const subscribeFails = fakeIoredis({ subscribe: () => Promise.reject(new Error('refused')) });
    expect(await probePubSub({ kind: 'ioredis', client: subscribeFails.client })).toBe(false);
    expect(subscribeFails.disconnect).toHaveBeenCalledTimes(1);

    const publishFails = fakeNodeRedis({ publish: () => Promise.reject(new Error('down')) });
    expect(await probePubSub({ kind: 'node-redis', client: publishFails.client })).toBe(false);
    expect(publishFails.destroy).toHaveBeenCalledTimes(1);

    const connectFails = fakeNodeRedis({ connect: () => Promise.reject(new Error('refused')) });
    expect(await probePubSub({ kind: 'node-redis', client: connectFails.client })).toBe(false);
  });

  it('does not unsubscribe a Sentinel channel whose SUBSCRIBE rejected', async () => {
    /* scenario: nothing was subscribed, so close sends nothing to the caller's Sentinel. */
    const { client, spies } = fakeSentinel({
      subscribe: () => Promise.reject(new Error('refused')),
    });
    expect(await probePubSub({ kind: 'node-redis-sentinel', client })).toBe(false);
    expect(spies.unsubscribe).not.toHaveBeenCalled();
  });

  it('resolves false when duplicate throws, and when the close throws', async () => {
    /* scenario: even a broken client or a misbehaving close cannot make the probe throw. */
    const broken: IoredisProbeClient = {
      duplicate: () => {
        throw new Error('no connection');
      },
      publish: () => Promise.resolve(1),
    };
    expect(await probePubSub({ kind: 'ioredis', client: broken })).toBe(false);

    const badClose = fakeNodeRedis({
      publish: () => Promise.reject(new Error('down')),
      destroy: () => {
        throw new Error('close failed');
      },
    });
    expect(await probePubSub({ kind: 'node-redis', client: badClose.client })).toBe(false);
    expect(badClose.destroy).toHaveBeenCalledTimes(1);
  });
});
