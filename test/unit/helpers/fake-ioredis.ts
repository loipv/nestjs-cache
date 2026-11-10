import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { IoredisLike } from '../../../src/stores/ioredis.adapter.js';

/**
 * Stand-in for an ioredis connection. Like ioredis, it only delivers messages on channels whose
 * SUBSCRIBE succeeded; `publishRemote` plays the part of another instance publishing.
 */
export class FakeConnection extends EventEmitter {
  readonly channels = new Set<string>();
  readonly duplicates: FakeConnection[] = [];
  get = vi.fn();
  set = vi.fn();
  getex = vi.fn();
  unlink = vi.fn();
  scan = vi.fn();
  publish = vi.fn((channel: string, message: string) => {
    for (const connection of this.duplicates) connection.publishRemote(channel, message);
    return Promise.resolve(1);
  });
  subscribe = vi.fn((...channels: string[]) => {
    for (const channel of channels) this.channels.add(channel);
    return Promise.resolve(channels.length);
  });
  quit = vi.fn(() => Promise.resolve('OK'));
  disconnect = vi.fn();

  private readonly prepared: FakeConnection[] = [];

  duplicate(): IoredisLike {
    const connection = this.prepared.shift() ?? new FakeConnection();
    this.duplicates.push(connection);
    return connection.asIoredis();
  }

  /** Creates the connection that the next `duplicate()` returns, so a test can set it up first. */
  prepareDuplicate(): FakeConnection {
    const connection = new FakeConnection();
    this.prepared.push(connection);
    return connection;
  }

  /** Makes the next SUBSCRIBE reject without subscribing, as ioredis does after its retries. */
  failNextSubscribe(error: Error = new Error('Reached the max retries per request limit')): void {
    this.subscribe.mockImplementationOnce(() => Promise.reject(error));
  }

  publishRemote(channel: string, message: string): void {
    if (this.channels.has(channel)) this.emit('message', channel, message);
  }

  asIoredis(): IoredisLike {
    return this as unknown as IoredisLike;
  }
}
