import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { IoredisClusterLike, IoredisLike } from '../../../src/stores/ioredis.adapter.js';

export interface FakePipeline {
  queued: unknown[][];
  set: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
}

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
  eval = vi.fn();
  unlink = vi.fn();
  mget = vi.fn();
  scan = vi.fn();
  ping = vi.fn(() => Promise.resolve('PONG'));
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
  /** Every pipeline made by `pipeline()`, with its queued `set`s. */
  readonly pipelines: FakePipeline[] = [];
  /** What the next `exec` resolves; by default one `[null, 'OK']` per queued command. */
  nextExec: (() => Promise<[Error | null, unknown][] | null>) | undefined;
  pipeline = vi.fn(() => {
    const queued: unknown[][] = [];
    const exec = vi.fn(() => {
      const custom = this.nextExec;
      this.nextExec = undefined;
      return custom !== undefined
        ? custom()
        : Promise.resolve(queued.map((): [Error | null, unknown] => [null, 'OK']));
    });
    const pipeline: FakePipeline = {
      queued,
      exec,
      set: vi.fn((...args: unknown[]) => {
        queued.push(args);
        return pipeline;
      }),
    };
    this.pipelines.push(pipeline);
    return pipeline;
  });

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

/**
 * Stand-in for an ioredis `Cluster`: `nodes('master')` returns three fake masters, and sharded
 * pub/sub (`spublish`, `ssubscribe`, `'smessage'`) reaches the clusters made by `duplicate`.
 */
export class FakeCluster extends FakeConnection {
  readonly isCluster = true;
  readonly masters = [new FakeConnection(), new FakeConnection(), new FakeConnection()];
  /** The arguments of every `duplicate` call, in order. */
  readonly duplicateCalls: unknown[][] = [];
  readonly clusterDuplicates: FakeCluster[] = [];
  readonly shardChannels = new Set<string>();
  nodes = vi.fn(() => this.masters.map((master) => master.asIoredis()));
  spublish = vi.fn((channel: string, message: string) => {
    for (const cluster of this.clusterDuplicates) cluster.spublishRemote(channel, message);
    return Promise.resolve(1);
  });
  ssubscribe = vi.fn((...channels: string[]) => {
    for (const channel of channels) this.shardChannels.add(channel);
    return Promise.resolve(channels.length);
  });

  override duplicate(...args: unknown[]): IoredisLike {
    this.duplicateCalls.push(args);
    const cluster = new FakeCluster();
    this.clusterDuplicates.push(cluster);
    return cluster.asIoredis();
  }

  spublishRemote(channel: string, message: string): void {
    if (this.shardChannels.has(channel)) this.emit('smessage', channel, message);
  }

  asCluster(): IoredisClusterLike {
    return this as unknown as IoredisClusterLike;
  }
}
