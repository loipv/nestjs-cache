import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { NodeRedisLike } from '../../../src/stores/node-redis.adapter.js';

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
    const connection = new FakeNodeRedis();
    this.duplicates.push(connection);
    return connection.asNodeRedis();
  });

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

function add(channels: Map<string, Set<Listener>>, channel: string, listener: Listener): void {
  const listeners = channels.get(channel) ?? new Set<Listener>();
  listeners.add(listener);
  channels.set(channel, listeners);
}
