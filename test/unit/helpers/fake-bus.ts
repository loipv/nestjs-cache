import type {
  InvalidationBus,
  InvalidationMessage,
} from '../../../src/stores/cache-store.interface.js';

type Op = 'publish' | 'subscribe';

export class FakeBus implements InvalidationBus {
  readonly published: InvalidationMessage[] = [];
  closed = false;
  private readonly handlers: Array<(message: InvalidationMessage) => void> = [];
  private readonly reconnectHandlers: Array<() => void> = [];
  private readonly failures = new Map<Op, Error[]>();

  failNext(op: Op, error: Error = new Error(`${op} failed`)): void {
    const queue = this.failures.get(op) ?? [];
    queue.push(error);
    this.failures.set(op, queue);
  }

  publish(message: InvalidationMessage): Promise<void> {
    const error = this.failures.get('publish')?.shift();
    if (error) return Promise.reject(error);
    this.published.push(message);
    return Promise.resolve();
  }

  subscribe(handler: (message: InvalidationMessage) => void): Promise<void> {
    const error = this.failures.get('subscribe')?.shift();
    if (error) return Promise.reject(error);
    this.handlers.push(handler);
    return Promise.resolve();
  }

  onReconnect(handler: () => void): void {
    this.reconnectHandlers.push(handler);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** Delivers a message to every subscribed handler, as if it came from another instance. */
  deliver(message: InvalidationMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  triggerReconnect(): void {
    for (const handler of this.reconnectHandlers) handler();
  }
}
