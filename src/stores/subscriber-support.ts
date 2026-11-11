import type { RedisSubscriberAdapter } from './redis-client.adapter.js';

/** How long a subscriber's `close` waits for a graceful close before it drops the connection. */
export const CLOSE_TIMEOUT_MS = 1_000;

/** Calls every handler; a throwing handler never reaches the others or the client's emitter. */
export function notifyAll<A extends unknown[]>(
  handlers: readonly ((...args: A) => void)[],
  ...args: A
): void {
  for (const handler of handlers) {
    try {
      handler(...args);
    } catch {
      // swallowed: this runs inside the client's event listeners
    }
  }
}

/**
 * Runs `close`, or `destroy` when `close` rejects, throws or has not settled after
 * `CLOSE_TIMEOUT_MS`. Never rejects; the timer is unref'd and always cleared.
 */
export async function closeWithTimeout(close: () => unknown, destroy: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(true);
    }, CLOSE_TIMEOUT_MS);
    timer.unref();
  });
  // The executor turns a synchronous throw into a rejection.
  const closed = new Promise((resolve) => {
    resolve(close());
  }).then(
    () => false,
    () => true,
  );
  const force = await Promise.race([closed, timedOut]);
  clearTimeout(timer);
  if (!force) return;
  try {
    destroy();
  } catch {
    // close never rejects
  }
}

/** What a client library supplies to `createSubscriptionTracker`. */
export interface SubscriberTransport {
  /** Sends one SUBSCRIBE (or SSUBSCRIBE) for `channel`. May throw synchronously. */
  subscribe(channel: string): Promise<unknown>;
  /** Closes the dedicated connection; called at most once. Must never reject. */
  close(): Promise<void>;
}

/** The shared subscriber state; the adapter wires its connection's events to it. */
export interface SubscriptionTracker {
  readonly subscriber: RedisSubscriberAdapter;
  /** Hands a message to the channel's handler. A throwing handler is not caught here. */
  deliver(channel: string, message: string): void;
  /** For each 'ready' event of the connection. */
  ready(): void;
  /** For each 'error' event of the connection. */
  error(error: unknown): void;
}

interface Subscription {
  status: 'pending' | 'ok' | 'failed';
  done: Promise<void>;
}

/**
 * The `RedisSubscriberAdapter` retry contract, shared by the client adapters. Clients restore a
 * channel on reconnect only once its SUBSCRIBE was confirmed, so channels whose SUBSCRIBE failed are
 * sent again on 'ready', and a later `subscribe` call retries too. `onReconnect` fires from the
 * second 'ready' onward, and when a failed channel recovers.
 */
export function createSubscriptionTracker(transport: SubscriberTransport): SubscriptionTracker {
  const handlers = new Map<string, (message: string) => void>();
  /** The latest SUBSCRIBE per channel. */
  const subscriptions = new Map<string, Subscription>();
  const reconnectHandlers: Array<() => void> = [];
  const errorHandlers: Array<(error: unknown) => void> = [];
  let readyCount = 0;
  let closing: Promise<void> | undefined;

  const send = (channel: string): Promise<void> => {
    const subscription: Subscription = { status: 'pending', done: Promise.resolve() };
    // The executor turns a synchronous throw into a rejection, so nothing throws into the client.
    const sent = new Promise((resolve) => {
      resolve(transport.subscribe(channel));
    });
    subscription.done = sent.then(
      () => {
        subscription.status = 'ok';
      },
      (error: unknown) => {
        subscription.status = 'failed';
        throw error;
      },
    );
    subscriptions.set(channel, subscription);
    return subscription.done;
  };

  return {
    subscriber: {
      subscribe(channel, onMessage) {
        handlers.set(channel, onMessage);
        const current = subscriptions.get(channel);
        if (current !== undefined && current.status !== 'failed') return current.done;
        return send(channel);
      },
      onReconnect(handler) {
        reconnectHandlers.push(handler);
      },
      onError(handler) {
        errorHandlers.push(handler);
      },
      close() {
        closing ??= transport.close();
        return closing;
      },
    },
    deliver(channel, message) {
      handlers.get(channel)?.(message);
    },
    ready() {
      readyCount += 1;
      if (readyCount > 1) notifyAll(reconnectHandlers);
      if (closing !== undefined) return;
      for (const [channel, subscription] of subscriptions) {
        if (subscription.status !== 'failed') continue;
        // Messages published while the channel was not subscribed are lost: treat it as a reconnect.
        send(channel).then(
          () => {
            notifyAll(reconnectHandlers);
          },
          (error: unknown) => {
            notifyAll(errorHandlers, error);
          },
        );
      }
    },
    error(error) {
      notifyAll(errorHandlers, error);
    },
  };
}
