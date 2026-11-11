import { describe, expect, it, vi } from 'vitest';
import type {
  RedisClientAdapter,
  RedisSubscriberAdapter,
} from '../../src/stores/redis-client.adapter.js';
import { probePubSub } from '../integration/helpers/pubsub-probe.js';

/* A fake adapter: `behaviour` decides what subscribe and publish do; every subscriber made is kept
   so a case can check it was closed. Fake timers drive the 3 s wait. */
function fake(behaviour: {
  subscribe: (channel: string, onMessage: (m: string) => void) => Promise<void>;
  publish?: (channel: string) => Promise<void>;
  close?: () => Promise<void>;
}): { adapter: RedisClientAdapter; subscribers: { close: ReturnType<typeof vi.fn> }[] } {
  const subscribers: { close: ReturnType<typeof vi.fn> }[] = [];
  const adapter = {
    publish: vi.fn(behaviour.publish ?? (() => Promise.resolve())),
    createSubscriber: () => {
      const close = vi.fn(behaviour.close ?? (() => Promise.resolve()));
      subscribers.push({ close });
      const subscriber: RedisSubscriberAdapter = {
        subscribe: behaviour.subscribe,
        onReconnect: () => undefined,
        onError: () => undefined,
        close,
      };
      return subscriber;
    },
  } as unknown as RedisClientAdapter;
  return { adapter, subscribers };
}

describe('probePubSub', () => {
  it('resolves true and closes the subscriber when the message arrives', async () => {
    /* scenario: publish delivers to the subscription at once. */
    let deliver: ((m: string) => void) | undefined;
    const { adapter, subscribers } = fake({
      subscribe: (_c, onMessage) => {
        deliver = onMessage;
        return Promise.resolve();
      },
      publish: () => {
        deliver?.('ping');
        return Promise.resolve();
      },
    });
    expect(await probePubSub(adapter)).toBe(true);
    expect(subscribers).toHaveLength(1);
    expect(subscribers[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('resolves false after 3 s when the subscribe never completes, and closes the subscriber', async () => {
    /* scenario: SUBSCRIBE hangs (node-redis v5 Sentinel from the host), so the timer decides. */
    vi.useFakeTimers();
    try {
      const { adapter, subscribers } = fake({
        subscribe: () => new Promise<void>(() => undefined),
      });
      const result = probePubSub(adapter);
      await vi.advanceTimersByTimeAsync(2_999);
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBe(false);
      expect(subscribers[0]?.close).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves false, without throwing, when subscribe or publish rejects, and closes the subscriber', async () => {
    /* scenario: errors at either step are an unreachable answer, never an exception. */
    const subscribeFails = fake({ subscribe: () => Promise.reject(new Error('refused')) });
    expect(await probePubSub(subscribeFails.adapter)).toBe(false);
    expect(subscribeFails.subscribers[0]?.close).toHaveBeenCalledTimes(1);

    const publishFails = fake({
      subscribe: () => Promise.resolve(),
      publish: () => Promise.reject(new Error('down')),
    });
    expect(await probePubSub(publishFails.adapter)).toBe(false);
    expect(publishFails.subscribers[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('resolves false when createSubscriber throws, and when close rejects', async () => {
    /* scenario: even a broken adapter or a misbehaving close cannot make the probe throw. */
    const broken = {
      publish: () => Promise.resolve(),
      createSubscriber: () => {
        throw new Error('no connection');
      },
    } as unknown as RedisClientAdapter;
    expect(await probePubSub(broken)).toBe(false);

    const badClose = fake({
      subscribe: () => Promise.reject(new Error('refused')),
      close: () => Promise.reject(new Error('close failed')),
    });
    expect(await probePubSub(badClose.adapter)).toBe(false);
    expect(badClose.subscribers[0]?.close).toHaveBeenCalledTimes(1);
  });
});
