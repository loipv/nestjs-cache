import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type {
  NodeRedisClusterLike,
  NodeRedisLike,
  NodeRedisSentinelLike,
} from '../../../src/stores/node-redis.adapter.js';

type Listener = (message: string, channel: string) => void;

/**
 * Stand-in for a node-redis v5 client. Like node-redis, a channel gets its listener only once its
 * SUBSCRIBE succeeded; `publishRemote` plays the part of another instance publishing.
 */
export class FakeNodeRedis extends EventEmitter {
  /** The listeners of every confirmed SUBSCRIBE, by channel. */
  readonly channels = new Map<string, Set<Listener>>();
  /** The listeners of every confirmed SSUBSCRIBE, by channel. */
  readonly shardChannels = new Map<string, Set<Listener>>();
  readonly duplicates: FakeNodeRedis[] = [];
  get = vi.fn();
  set = vi.fn();
  getEx = vi.fn();
  eval = vi.fn();
  unlink = vi.fn();
  mGet = vi.fn();
  scan = vi.fn();
  ping = vi.fn(() => Promise.resolve('PONG'));
  publish = vi.fn((channel: string, message: string) => {
    for (const connection of this.duplicates) connection.publishRemote(channel, message);
    return Promise.resolve(1);
  });
  connect = vi.fn(() => Promise.resolve(this));
  subscribe = vi.fn((channel: string, listener: Listener) => {
    add(this.channels, channel, listener);
    return Promise.resolve();
  });
  sSubscribe = vi.fn((channel: string, listener: Listener) => {
    add(this.shardChannels, channel, listener);
    return Promise.resolve();
  });
  close = vi.fn(() => Promise.resolve());
  destroy = vi.fn();

  duplicate = vi.fn((): NodeRedisLike => {
    const connection = this.spawn();
    this.duplicates.push(connection);
    return connection.asNodeRedis();
  });

  /** The connection `duplicate` returns: a client of the same kind. */
  protected spawn(): FakeNodeRedis {
    return new FakeNodeRedis();
  }

  publishRemote(channel: string, message: string): void {
    for (const listener of this.channels.get(channel) ?? []) listener(message, channel);
  }

  sPublishRemote(channel: string, message: string): void {
    for (const listener of this.shardChannels.get(channel) ?? []) listener(message, channel);
  }

  asNodeRedis(): NodeRedisLike {
    return this;
  }
}

/**
 * Stand-in for a node-redis v5 cluster (`createCluster`). `masters` are opaque node objects;
 * `nodeClient` answers the matching entry of `masterClients`. `sPublish` reaches the sharded
 * subscriptions of every duplicate, as SPUBLISH reaches every instance's sharded subscriber.
 */
export class FakeNodeRedisCluster extends FakeNodeRedis {
  masters: object[] = [
    { address: '127.0.0.1:7000' },
    { address: '127.0.0.1:7001' },
    { address: '127.0.0.1:7002' },
  ];
  /** The node client of each master, in `masters` order. */
  readonly masterClients = [new FakeNodeRedis(), new FakeNodeRedis(), new FakeNodeRedis()];
  nodeClient = vi.fn((master: unknown) => {
    const client = this.masterClients[this.masters.findIndex((known) => known === master)];
    return client === undefined
      ? Promise.reject(new Error('unknown master'))
      : Promise.resolve(client.asNodeRedis());
  });
  sPublish = vi.fn((channel: string, message: string) => {
    for (const connection of this.duplicates) connection.sPublishRemote(channel, message);
    return Promise.resolve(1);
  });

  protected override spawn(): FakeNodeRedis {
    return new FakeNodeRedisCluster();
  }

  asCluster(): NodeRedisClusterLike {
    // `duplicate` is typed for the single-node fake, though here it returns a cluster fake.
    return this as unknown as NodeRedisClusterLike;
  }
}

/**
 * Stand-in for a node-redis v5 Sentinel client (`createSentinel`). It has no `duplicate`: it
 * subscribes on itself, through its pub/sub proxy that follows the master. `publish` reaches its
 * own subscriptions, as PUBLISH through the sentinel reaches its own proxy. `unsubscribe` removes
 * one listener of a channel, as node-redis does when a listener is given.
 */
export class FakeNodeRedisSentinel extends FakeNodeRedis {
  getSentinelNode = vi.fn(() => ({ host: '127.0.0.1', port: 26379 }));
  getMasterNode = vi.fn(() => ({ host: '127.0.0.1', port: 6379 }));
  unsubscribe = vi.fn((channel: string, listener: Listener) => {
    const listeners = this.channels.get(channel);
    listeners?.delete(listener);
    if (listeners?.size === 0) this.channels.delete(channel);
    return Promise.resolve();
  });

  constructor() {
    super();
    Reflect.deleteProperty(this, 'duplicate');
    this.publish = vi.fn((channel: string, message: string) => {
      this.publishRemote(channel, message);
      return Promise.resolve(1);
    });
  }

  /** What the sentinel emits once it has moved its clients to a new master. */
  masterChange(): void {
    this.emit('topology-change', { type: 'MASTER_CHANGE', node: { host: '10.0.0.3', port: 6379 } });
  }

  asSentinel(): NodeRedisSentinelLike {
    return this;
  }
}

function add(channels: Map<string, Set<Listener>>, channel: string, listener: Listener): void {
  const listeners = channels.get(channel) ?? new Set<Listener>();
  listeners.add(listener);
  channels.set(channel, listeners);
}
