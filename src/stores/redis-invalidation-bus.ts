import type { InvalidationBus, InvalidationMessage } from './cache-store.interface.js';
import { ioredisAdapter, isRedisClientAdapter } from './ioredis.adapter.js';
import type { IoredisClusterLike, IoredisLike } from './ioredis.adapter.js';
import type { RedisClientAdapter, RedisSubscriberAdapter } from './redis-client.adapter.js';

/** Options of `redisInvalidationBus`. */
export interface RedisInvalidationBusOptions {
  /** An ioredis client or Cluster, or a `RedisClientAdapter` (e.g. `nodeRedisAdapter(client)`). */
  client: IoredisLike | IoredisClusterLike | RedisClientAdapter;
  /** The pub/sub channel of invalidation messages. Defaults to 'nestjs-cache:invalidate'. */
  channel?: string;
}

/** Internal: the channel used when none is configured. */
export const DEFAULT_CHANNEL = 'nestjs-cache:invalidate';

export function toRedisAdapter(
  client: IoredisLike | IoredisClusterLike | RedisClientAdapter,
): RedisClientAdapter {
  return isRedisClientAdapter(client) ? client : ioredisAdapter(client);
}

/** Longest message, in characters, that is parsed; a longer one is never `JSON.parse`d. */
const MAX_MESSAGE_LENGTH = 1_048_576;

function parseMessage(raw: string): InvalidationMessage | undefined {
  // A forged multi-megabyte message would cost a parse on every instance. It becomes a clear of
  // every key instead; the empty origin never equals an instance's randomUUID() origin, so no
  // store ignores it as its own.
  if (raw.length > MAX_MESSAGE_LENGTH) return { origin: '', prefix: '' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const origin = record['origin'];
  if (typeof origin !== 'string') return undefined;
  const keys = record['keys'];
  const prefix = record['prefix'];
  if (keys !== undefined && prefix === undefined) {
    if (Array.isArray(keys) && keys.every((k): k is string => typeof k === 'string')) {
      return { origin, keys };
    }
    return undefined;
  }
  if (typeof prefix === 'string' && keys === undefined) return { origin, prefix };
  return undefined;
}

/** Internal: builds the bus over an adapter that the caller owns. */
export function createRedisBus(adapter: RedisClientAdapter, channel: string): InvalidationBus {
  const handlers: Array<(message: InvalidationMessage) => void> = [];
  const reconnectHandlers: Array<() => void> = [];
  const errorHandlers: Array<(error: unknown) => void> = [];
  let subscriber: RedisSubscriberAdapter | undefined;
  let subscribed: Promise<void> | undefined;

  const dispatch = (raw: string): void => {
    const message = parseMessage(raw);
    if (message === undefined) return;
    for (const h of handlers) {
      try {
        h(message);
      } catch {
        // one failing handler must not stop the others or reach the ioredis listener
      }
    }
  };

  return {
    async publish(message) {
      await adapter.publish(channel, JSON.stringify(message));
    },
    subscribe(handler) {
      if (!handlers.includes(handler)) handlers.push(handler);
      if (subscriber === undefined) {
        subscriber = adapter.createSubscriber();
        for (const onReconnect of reconnectHandlers) subscriber.onReconnect(onReconnect);
        for (const onError of errorHandlers) subscriber.onError?.(onError);
      }
      // A rejected attempt is forgotten, so a later call subscribes again.
      subscribed ??= subscriber.subscribe(channel, dispatch).catch((error: unknown) => {
        subscribed = undefined;
        throw error;
      });
      return subscribed;
    },
    onReconnect(handler) {
      reconnectHandlers.push(handler);
      subscriber?.onReconnect(handler);
    },
    onError(handler) {
      errorHandlers.push(handler);
      subscriber?.onError?.(handler);
    },
    async close() {
      await subscriber?.close();
    },
  };
}

/**
 * The Redis pub/sub `InvalidationBus` a `RedisStore` uses, on its own: for a custom store, or a
 * `tieredStore` whose L2 is not Redis. Its subscriber is created on the first `subscribe`.
 */
export function redisInvalidationBus(options: RedisInvalidationBusOptions): InvalidationBus {
  return createRedisBus(toRedisAdapter(options.client), options.channel ?? DEFAULT_CHANNEL);
}
