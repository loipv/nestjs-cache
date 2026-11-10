import type { InvalidationBus, InvalidationMessage } from './cache-store.interface.js';
import { ioredisAdapter, isRedisClientAdapter } from './ioredis.adapter.js';
import type { IoredisLike } from './ioredis.adapter.js';
import type { RedisClientAdapter, RedisSubscriberAdapter } from './redis-client.adapter.js';

export interface RedisStoreOptions {
  client: IoredisLike | RedisClientAdapter;
  /** Defaults to 'nestjs-cache:invalidate'. */
  channel?: string;
}

const DEFAULT_CHANNEL = 'nestjs-cache:invalidate';

export function toRedisAdapter(client: IoredisLike | RedisClientAdapter): RedisClientAdapter {
  return isRedisClientAdapter(client) ? client : ioredisAdapter(client);
}

function parseMessage(raw: string): InvalidationMessage | undefined {
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
  let subscriber: RedisSubscriberAdapter | undefined;
  let subscribed: Promise<void> | undefined;

  return {
    async publish(message) {
      await adapter.publish(channel, JSON.stringify(message));
    },
    subscribe(handler) {
      handlers.push(handler);
      if (subscribed === undefined) {
        subscriber = adapter.createSubscriber();
        for (const onReconnect of reconnectHandlers) subscriber.onReconnect(onReconnect);
        subscribed = subscriber.subscribe(channel, (raw) => {
          const message = parseMessage(raw);
          if (message === undefined) return;
          for (const h of handlers) h(message);
        });
      }
      return subscribed;
    },
    onReconnect(handler) {
      reconnectHandlers.push(handler);
      subscriber?.onReconnect(handler);
    },
    async close() {
      await subscriber?.close();
    },
  };
}

export function redisInvalidationBus(options: RedisStoreOptions): InvalidationBus {
  return createRedisBus(toRedisAdapter(options.client), options.channel ?? DEFAULT_CHANNEL);
}
