import type {
  RedisClientAdapter,
  RedisSubscriberAdapter,
} from '../../../src/stores/redis-client.adapter.js';

export class FakeSubscriber implements RedisSubscriberAdapter {
  closed = false;
  subscribeCalls = 0;
  private readonly handlers = new Map<string, Array<(message: string) => void>>();
  private readonly reconnectHandlers: Array<() => void> = [];
  private readonly errorHandlers: Array<(error: unknown) => void> = [];
  private readonly subscribeFailures: Error[] = [];

  failNextSubscribe(error: Error = new Error('subscribe failed')): void {
    this.subscribeFailures.push(error);
  }

  async subscribe(channel: string, onMessage: (message: string) => void): Promise<void> {
    this.subscribeCalls += 1;
    await Promise.resolve();
    const failure = this.subscribeFailures.shift();
    if (failure) throw failure;
    this.handlers.set(channel, [onMessage]);
  }

  onReconnect(handler: () => void): void {
    this.reconnectHandlers.push(handler);
  }

  onError(handler: (error: unknown) => void): void {
    this.errorHandlers.push(handler);
  }

  triggerError(error: unknown): void {
    for (const handler of this.errorHandlers) handler(error);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.resolve();
  }

  /** Delivers a raw message to every handler, whatever the channel. */
  deliver(message: string): void {
    for (const list of this.handlers.values()) for (const handler of list) handler(message);
  }

  triggerReconnect(): void {
    for (const handler of this.reconnectHandlers) handler();
  }
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === '\\') {
      i += 1;
      source += escapeRegExp(pattern.charAt(i));
    } else if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += escapeRegExp(ch);
  }
  return new RegExp(`^${source}$`, 's');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class FakeRedis implements RedisClientAdapter {
  readonly commands: { name: string; args: unknown[] }[] = [];
  readonly subscribers: FakeSubscriber[] = [];
  readonly data = new Map<string, string>();
  /** Optional, like the adapter member: tests assign it to make this fake ping-capable. */
  declare ping?: () => Promise<void>;
  /** Stable scan order, so deleting mid-scan does not shift the cursor. */
  private readonly order: string[] = [];

  private record(name: string, ...args: unknown[]): void {
    this.commands.push({ name, args });
  }

  async get(key: string): Promise<string | undefined> {
    this.record('get', key);
    return Promise.resolve(this.data.get(key));
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.record('set', key, value, ttlMs);
    this.data.set(key, value);
    await Promise.resolve();
  }

  async getex(key: string, ttlMs: number): Promise<string | undefined> {
    this.record('getex', key, ttlMs);
    return Promise.resolve(this.data.get(key));
  }

  async unlink(keys: readonly string[]): Promise<void> {
    this.record('unlink', keys);
    for (const key of keys) this.data.delete(key);
    await Promise.resolve();
  }

  async scan(
    cursor: string,
    match: string,
    count: number,
  ): Promise<{ cursor: string; keys: string[] }> {
    this.record('scan', cursor, match, count);
    for (const key of this.data.keys()) if (!this.order.includes(key)) this.order.push(key);
    const all = this.order;
    const start = Number(cursor);
    const end = start + count;
    const regex = globToRegExp(match);
    const keys = all.slice(start, end).filter((k) => this.data.has(k) && regex.test(k));
    return Promise.resolve({ cursor: end >= all.length ? '0' : String(end), keys });
  }

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.record('setIfAbsent', key, value, ttlMs);
    await Promise.resolve();
    if (this.data.has(key)) return false;
    this.data.set(key, value);
    return true;
  }

  async deleteIfEquals(key: string, value: string): Promise<boolean> {
    this.record('deleteIfEquals', key, value);
    await Promise.resolve();
    if (this.data.get(key) !== value) return false;
    this.data.delete(key);
    return true;
  }

  /** Test-only: whether the key is stored. */
  has(key: string): boolean {
    return this.data.has(key);
  }

  /** Test-only: removes the key without a command, simulating expiry. */
  forceDelete(key: string): void {
    this.data.delete(key);
  }

  async publish(channel: string, message: string): Promise<void> {
    this.record('publish', channel, message);
    await Promise.resolve();
  }

  /** Failures queued for the next subscriber's SUBSCRIBE calls. */
  readonly subscribeFailures: Error[] = [];

  createSubscriber(): FakeSubscriber {
    const subscriber = new FakeSubscriber();
    for (const error of this.subscribeFailures.splice(0)) subscriber.failNextSubscribe(error);
    this.subscribers.push(subscriber);
    return subscriber;
  }
}
