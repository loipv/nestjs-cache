import { afterEach, describe, expect, it, vi } from 'vitest';
import { ioredisAdapter, RELEASE_SCRIPT } from '../../../src/stores/ioredis.adapter.js';
import type { RedisSubscriberAdapter } from '../../../src/stores/redis-client.adapter.js';
import { FakeConnection } from '../helpers/fake-ioredis.js';

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function setup(): { subscriber: RedisSubscriberAdapter; connection: FakeConnection } {
  const client = new FakeConnection();
  const subscriber = ioredisAdapter(client.asIoredis()).createSubscriber();
  return { subscriber, connection: client.duplicates[0]! };
}

describe('ioredisAdapter subscriber', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('onReconnect fires from the second ready onward', () => {
    const { subscriber, connection } = setup();
    const handler = vi.fn();
    subscriber.onReconnect(handler);
    connection.emit('ready');
    expect(handler).not.toHaveBeenCalled();
    connection.emit('ready');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  describe('failed subscribe (F1)', () => {
    it('subscribes again on the next ready after a failed first subscribe, then delivers', async () => {
      const { subscriber, connection } = setup();
      connection.failNextSubscribe();
      const onMessage = vi.fn();
      await expect(subscriber.subscribe('ch', onMessage)).rejects.toThrow('max retries');
      connection.publishRemote('ch', 'lost');
      expect(onMessage).not.toHaveBeenCalled();

      connection.emit('ready'); // the first ready: Redis became reachable after the failure
      await flush();
      connection.publishRemote('ch', 'm');
      expect(onMessage).toHaveBeenCalledWith('m');
      expect(connection.subscribe).toHaveBeenCalledTimes(2);
    });

    it('does not resend a subscribe that succeeded or is still in flight', async () => {
      const { subscriber, connection } = setup();
      await subscriber.subscribe('ok', vi.fn());
      let settle: (value: number) => void = () => undefined;
      connection.subscribe.mockImplementationOnce(
        () => new Promise<number>((resolve) => (settle = resolve)),
      );
      const inFlight = subscriber.subscribe('slow', vi.fn());
      connection.emit('ready');
      connection.emit('ready');
      await flush();
      expect(connection.subscribe.mock.calls).toEqual([['ok'], ['slow']]);
      settle(1);
      await inFlight;
      // subscribing to a confirmed channel again sends nothing
      await subscriber.subscribe('ok', vi.fn());
      expect(connection.subscribe).toHaveBeenCalledTimes(2);
    });

    it('keeps retrying on each ready and reports a failed retry through onError', async () => {
      const { subscriber, connection } = setup();
      const onError = vi.fn();
      subscriber.onError?.(onError);
      connection.failNextSubscribe();
      connection.failNextSubscribe(new Error('retry failed'));
      await expect(subscriber.subscribe('ch', vi.fn())).rejects.toThrow();
      connection.emit('ready');
      await flush();
      expect(onError).toHaveBeenCalledWith(new Error('retry failed'));
      connection.emit('ready');
      await flush();
      expect(connection.subscribe).toHaveBeenCalledTimes(3);
      expect(connection.channels.has('ch')).toBe(true);
    });

    it('fires reconnect handlers once a failed subscription recovers (messages were missed)', async () => {
      const { subscriber, connection } = setup();
      const onReconnect = vi.fn();
      subscriber.onReconnect(onReconnect);
      connection.failNextSubscribe();
      await expect(subscriber.subscribe('ch', vi.fn())).rejects.toThrow();
      connection.emit('ready');
      expect(onReconnect).not.toHaveBeenCalled();
      await flush();
      expect(onReconnect).toHaveBeenCalledTimes(1);
    });

    it('reports a retry whose SUBSCRIBE throws synchronously, without throwing from ready', async () => {
      const { subscriber, connection } = setup();
      const onError = vi.fn();
      subscriber.onError?.(onError);
      connection.failNextSubscribe();
      await expect(subscriber.subscribe('ch', vi.fn())).rejects.toThrow();
      connection.subscribe.mockImplementationOnce(() => {
        throw new Error('sync subscribe failure');
      });
      expect(() => connection.emit('ready')).not.toThrow();
      await flush();
      expect(onError).toHaveBeenCalledWith(new Error('sync subscribe failure'));
    });

    it('does not resubscribe after close', async () => {
      const { subscriber, connection } = setup();
      connection.failNextSubscribe();
      await expect(subscriber.subscribe('ch', vi.fn())).rejects.toThrow();
      await subscriber.close();
      connection.emit('ready');
      await flush();
      expect(connection.subscribe).toHaveBeenCalledTimes(1);
    });

    it('never throws out of the ready listener when a reconnect handler throws', () => {
      const { subscriber, connection } = setup();
      const after = vi.fn();
      subscriber.onReconnect(() => {
        throw new Error('handler failed');
      });
      subscriber.onReconnect(after);
      connection.emit('ready');
      expect(() => connection.emit('ready')).not.toThrow();
      expect(after).toHaveBeenCalledTimes(1);
    });
  });

  describe('connection errors (F2)', () => {
    it('attaches an error listener when the subscriber is created', () => {
      const { connection } = setup();
      expect(connection.listenerCount('error')).toBe(1);
      // without a listener, EventEmitter would throw here (ioredis logs "Unhandled error event")
      expect(() => connection.emit('error', new Error('ECONNREFUSED'))).not.toThrow();
    });

    it('forwards connection errors to every onError handler', () => {
      const { subscriber, connection } = setup();
      const failing = vi.fn(() => {
        throw new Error('handler failed');
      });
      const second = vi.fn();
      subscriber.onError?.(failing);
      subscriber.onError?.(second);
      const error = new Error('ECONNREFUSED');
      expect(() => connection.emit('error', error)).not.toThrow();
      expect(failing).toHaveBeenCalledWith(error);
      expect(second).toHaveBeenCalledWith(error);
    });
  });

  describe('close (F7)', () => {
    it('quits once, clears its timer and never calls disconnect when quit settles', async () => {
      vi.useFakeTimers();
      const { subscriber, connection } = setup();
      await subscriber.close();
      await subscriber.close();
      expect(connection.quit).toHaveBeenCalledTimes(1);
      expect(connection.disconnect).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('disconnects when quit has not settled after 1 s', async () => {
      vi.useFakeTimers();
      const { subscriber, connection } = setup();
      connection.quit.mockImplementation(() => new Promise<string>(() => undefined));
      let done = false;
      const closing = subscriber.close().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      expect(connection.disconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(done).toBe(true);
      expect(connection.disconnect).toHaveBeenCalledTimes(1);
      await subscriber.close();
      expect(connection.quit).toHaveBeenCalledTimes(1);
      expect(connection.disconnect).toHaveBeenCalledTimes(1);
    });

    it('never rejects, even when quit rejects or throws', async () => {
      const rejecting = setup();
      rejecting.connection.quit.mockImplementation(() =>
        Promise.reject(new Error('Connection is closed.')),
      );
      await expect(rejecting.subscriber.close()).resolves.toBeUndefined();
      expect(rejecting.connection.disconnect).toHaveBeenCalledTimes(1);

      const throwing = setup();
      throwing.connection.quit.mockImplementation(() => {
        throw new Error('sync quit failure');
      });
      throwing.connection.disconnect.mockImplementation(() => {
        throw new Error('sync disconnect failure');
      });
      await expect(throwing.subscriber.close()).resolves.toBeUndefined();
    });

    it('resolves after the timeout when the connection has no disconnect', async () => {
      vi.useFakeTimers();
      const client = new FakeConnection();
      const bare = new FakeConnection();
      bare.quit.mockImplementation(() => new Promise<string>(() => undefined));
      const withoutDisconnect = Object.assign(bare.asIoredis(), { disconnect: undefined });
      client.duplicate = () => withoutDisconnect;
      const subscriber = ioredisAdapter(client.asIoredis()).createSubscriber();
      const closing = subscriber.close();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(closing).resolves.toBeUndefined();
    });
  });
});

describe('ioredisAdapter lock primitives', () => {
  it('setIfAbsent sends SET NX PX and maps OK/null', async () => {
    const client = new FakeConnection();
    const adapter = ioredisAdapter(client.asIoredis());
    client.set.mockResolvedValueOnce('OK');
    expect(await adapter.setIfAbsent?.('k', 'v', 5)).toBe(true);
    expect(client.set).toHaveBeenCalledWith('k', 'v', 'PX', 5, 'NX');
    client.set.mockResolvedValueOnce(null);
    expect(await adapter.setIfAbsent?.('k', 'v', 5)).toBe(false);
  });

  it('deleteIfEquals evaluates the release script', async () => {
    const client = new FakeConnection();
    const adapter = ioredisAdapter(client.asIoredis());
    client.eval.mockResolvedValueOnce(1);
    expect(await adapter.deleteIfEquals?.('k', 'v')).toBe(true);
    expect(client.eval).toHaveBeenCalledWith(RELEASE_SCRIPT, 1, 'k', 'v');
    client.eval.mockResolvedValueOnce(0);
    expect(await adapter.deleteIfEquals?.('k', 'v')).toBe(false);
  });
});

describe('ioredisAdapter optional members', () => {
  /* The client's MGET answers ['a', null, 'c']: null becomes undefined, the order is kept. */
  it('mget maps null to undefined and keeps order', async () => {
    const fake = new FakeConnection();
    fake.mget.mockResolvedValue(['a', null, 'c']);
    const adapter = ioredisAdapter(fake.asIoredis());
    await expect(adapter.mget?.(['k1', 'k2', 'k3'])).resolves.toEqual(['a', undefined, 'c']);
    expect(fake.mget).toHaveBeenCalledWith('k1', 'k2', 'k3');
  });

  /* An empty key list resolves [] and never reaches the client. */
  it('mget with no keys sends no command', async () => {
    const fake = new FakeConnection();
    const adapter = ioredisAdapter(fake.asIoredis());
    await expect(adapter.mget?.([])).resolves.toEqual([]);
    expect(fake.mget).not.toHaveBeenCalled();
  });

  /* A client without mget and ping gives an adapter that has neither member. */
  it('an adapter over a client without mget or ping has neither', () => {
    const fake = new FakeConnection();
    Reflect.deleteProperty(fake, 'mget');
    Reflect.deleteProperty(fake, 'ping');
    const adapter = ioredisAdapter(fake.asIoredis());
    expect('mget' in adapter).toBe(false);
    expect('ping' in adapter).toBe(false);
  });
});
