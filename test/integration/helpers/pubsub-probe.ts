import { randomUUID } from 'node:crypto';
import { ioredisAdapter, isRedisClientAdapter } from '../../../src/stores/ioredis.adapter.js';
import type { RedisSubscriberAdapter } from '../../../src/stores/redis-client.adapter.js';
import type { RedisStoreOptions } from '../../../src/stores/redis.store.js';

const PROBE_WAIT_MS = 3_000;

/** What `probePubSub` needs of a client; `startAdapter(...).client` and a `RedisClientAdapter` both fit. */
export type ProbeClient = RedisStoreOptions['client'];

/**
 * Whether a message published on `client` reaches a subscriber made from it within 3 s. Resolves
 * `false` on a timeout or any error and never throws; the temporary subscriber is always closed.
 * Ruling T1-B: redis (node-redis) v5 applies `nodeAddressMap` to a Sentinel's data clients but not
 * to its pub/sub proxy, so from the host that SUBSCRIBE never connects (v6.3.1 fixes it).
 */
export async function probePubSub(client: ProbeClient): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let subscriber: RedisSubscriberAdapter | undefined;
  try {
    const adapter = isRedisClientAdapter(client) ? client : ioredisAdapter(client);
    const channel = `probe:${randomUUID()}`;
    const received = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, PROBE_WAIT_MS);
      subscriber = adapter.createSubscriber();
      subscriber.onError?.(() => undefined);
      subscriber
        .subscribe(channel, () => {
          resolve(true);
        })
        .then(() => adapter.publish(channel, 'ping'))
        .catch(() => {
          resolve(false);
        });
    });
    return await received;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    try {
      await subscriber?.close();
    } catch {
      // close never rejects by contract; a probe must not throw either way
    }
  }
}
