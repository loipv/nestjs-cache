import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNodeRedisSubscriber,
  nodeRedisAdapter,
} from '../../../src/stores/node-redis.adapter.js';
import { RELEASE_SCRIPT } from '../../../src/stores/redis-client.adapter.js';
import type { RedisSubscriberAdapter } from '../../../src/stores/redis-client.adapter.js';
import { redisStore } from '../../../src/stores/redis.store.js';
import { FakeNodeRedis } from '../helpers/fake-node-redis.js';

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function setup(): {
  client: FakeNodeRedis;
  subscriber: RedisSubscriberAdapter;
  connection: FakeNodeRedis;
} {
  const client = new FakeNodeRedis();
  const subscriber = nodeRedisAdapter(client.asNodeRedis()).createSubscriber();
  return { client, subscriber, connection: client.duplicates[0]! };
}

describe('nodeRedisAdapter commands', () => {
  /* GET answers 'v', then null for a missing key: null becomes undefined. */
  it('get maps null to undefined', async () => {
    const client = new FakeNodeRedis();
    client.get.mockResolvedValueOnce('v').mockResolvedValueOnce(null);
    const adapter = nodeRedisAdapter(client.asNodeRedis());
    expect(await adapter.get('k')).toBe('v');
    expect(await adapter.get('missing')).toBeUndefined();
    expect(client.get.mock.calls).toEqual([['k'], ['missing']]);
  });

  /* A fractional TTL of 1500.2 ms is sent as PX 1501 in node-redis's expiration option. */
  it('set sends PX with the ttl rounded up', async () => {
    const client = new FakeNodeRedis();
    client.set.mockResolvedValue('OK');
    const adapter = nodeRedisAdapter(client.asNodeRedis());
    await expect(adapter.set('k', 'v', 1500.2)).resolves.toBeUndefined();
    expect(client.set).toHaveBeenCalledWith('k', 'v', { expiration: { type: 'PX', value: 1501 } });
  });

  /* GETEX with { type: 'PX' } and the TTL rounded up; a missing key (null) becomes undefined. */
  it('getex sends PX', async () => {
    const client = new FakeNodeRedis();
    client.getEx.mockResolvedValueOnce('v').mockResolvedValueOnce(null);
    const adapter = nodeRedisAdapter(client.asNodeRedis());
    expect(await adapter.getex('k', 99.5)).toBe('v');
    expect(await adapter.getex('missing', 100)).toBeUndefined();
    expect(client.getEx).toHaveBeenNthCalledWith(1, 'k', { type: 'PX', value: 100 });
    expect(client.getEx).toHaveBeenNthCalledWith(2, 'missing', { type: 'PX', value: 100 });
  });

  /* SET ... NX answers 'OK' when it set the key and null when the key existed. */
  it('setIfAbsent sends NX and returns true only for OK', async () => {
    const client = new FakeNodeRedis();
    client.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const adapter = nodeRedisAdapter(client.asNodeRedis());
    expect(await adapter.setIfAbsent?.('k', 'v', 5_000)).toBe(true);
    expect(await adapter.setIfAbsent?.('k', 'v', 5_000)).toBe(false);
    expect(client.set).toHaveBeenCalledWith('k', 'v', {
      expiration: { type: 'PX', value: 5_000 },
      condition: 'NX',
    });
  });

  /* The release script deleted the key (1), found another token (0), or answered something else. */
  it('deleteIfEquals evals RELEASE_SCRIPT with keys and arguments and returns true only for 1', async () => {
    const client = new FakeNodeRedis();
    client.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce('1');
    const adapter = nodeRedisAdapter(client.asNodeRedis());
    expect(await adapter.deleteIfEquals?.('k', 'token')).toBe(true);
    expect(await adapter.deleteIfEquals?.('k', 'token')).toBe(false);
    expect(await adapter.deleteIfEquals?.('k', 'token')).toBe(false);
    expect(client.eval).toHaveBeenCalledWith(RELEASE_SCRIPT, { keys: ['k'], arguments: ['token'] });
  });

  /* Empty key lists resolve at once without a command; a non-empty UNLINK gets the key array. */
  it('unlink and mget send nothing for an empty list', async () => {
    const client = new FakeNodeRedis();
    client.unlink.mockResolvedValue(2);
    const adapter = nodeRedisAdapter(client.asNodeRedis());
    await expect(adapter.unlink([])).resolves.toBeUndefined();
    await expect(adapter.mget?.([])).resolves.toEqual([]);
    expect(client.unlink).not.toHaveBeenCalled();
    expect(client.mGet).not.toHaveBeenCalled();
    await adapter.unlink(['a', 'b']);
    expect(client.unlink).toHaveBeenCalledWith(['a', 'b']);
  });

  /* MGET answers ['a', null, 'c']: null becomes undefined and the key order is kept. */
  it('mget maps null to undefined', async () => {
    const client = new FakeNodeRedis();
    client.mGet.mockResolvedValue(['a', null, 'c']);
    const adapter = nodeRedisAdapter(client.asNodeRedis());
    await expect(adapter.mget?.(['k1', 'k2', 'k3'])).resolves.toEqual(['a', undefined, 'c']);
    expect(client.mGet).toHaveBeenCalledWith(['k1', 'k2', 'k3']);
  });

  /* node-redis's SCAN takes { MATCH, COUNT } and answers { cursor, keys } with a string cursor. */
  it('scan passes MATCH and COUNT and returns the string cursor', async () => {
    const client = new FakeNodeRedis();
    client.scan.mockResolvedValue({ cursor: '17', keys: ['p:1', 'p:2'] });
    const adapter = nodeRedisAdapter(client.asNodeRedis());
    await expect(adapter.scan('0', 'p:*', 100)).resolves.toEqual({
      cursor: '17',
      keys: ['p:1', 'p:2'],
    });
    expect(client.scan).toHaveBeenCalledWith('0', { MATCH: 'p:*', COUNT: 100 });
  });

  /* A client with ping gives an adapter whose ping sends PING; one without gives no ping member. */
  it('ping is present only when the client has ping', async () => {
    const client = new FakeNodeRedis();
    const adapter = nodeRedisAdapter(client.asNodeRedis());
    expect('ping' in adapter).toBe(true);
    await expect(adapter.ping?.()).resolves.toBeUndefined();
    expect(client.ping).toHaveBeenCalledTimes(1);

    const bare = new FakeNodeRedis();
    Reflect.deleteProperty(bare, 'ping');
    expect('ping' in nodeRedisAdapter(bare.asNodeRedis())).toBe(false);
  });

  /* publish goes to PUBLISH on the caller's client and resolves undefined. */
  it('publish uses publish', async () => {
    const client = new FakeNodeRedis();
    const adapter = nodeRedisAdapter(client.asNodeRedis());
    await expect(adapter.publish('ch', 'm')).resolves.toBeUndefined();
    expect(client.publish).toHaveBeenCalledWith('ch', 'm');
  });

  /* setIfAbsent, deleteIfEquals and ping are all there, so redisStore gets a lock and a ping. */
  it('redisStore over the adapter has a lock and a ping', () => {
    const store = redisStore({ client: nodeRedisAdapter(new FakeNodeRedis().asNodeRedis()) });
    expect(store.lock).toBeDefined();
    expect(store.ping).toBeDefined();
  });
});

describe('nodeRedisAdapter subscriber', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /* Two channels subscribed at once share one duplicate and one connect; each SUBSCRIBE carries a
     listener that delivers only its channel's messages. The caller's client is never connected. */
  it('subscriber: duplicates and connects once, subscribes with a listener', async () => {
    const { client, subscriber, connection } = setup();
    const onA = vi.fn();
    const onB = vi.fn();
    await Promise.all([subscriber.subscribe('a', onA), subscriber.subscribe('b', onB)]);
    await subscriber.subscribe('a', onA);
    expect(client.duplicate).toHaveBeenCalledTimes(1);
    expect(connection.connect).toHaveBeenCalledTimes(1);
    expect(connection.subscribe.mock.calls).toEqual([
      ['a', expect.any(Function)],
      ['b', expect.any(Function)],
    ]);
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.subscribe).not.toHaveBeenCalled();

    connection.publishRemote('a', 'm1');
    expect(onA).toHaveBeenCalledWith('m1');
    expect(onB).not.toHaveBeenCalled();
  });

  /* Nothing connects before the first subscribe. */
  it('subscriber: does not connect before the first subscribe', () => {
    const { connection } = setup();
    expect(connection.connect).not.toHaveBeenCalled();
  });

  /* The first 'ready' is the initial connect; every later one is a reconnect. */
  it('subscriber: second ready fires onReconnect, the first does not', () => {
    const { subscriber, connection } = setup();
    const onReconnect = vi.fn();
    subscriber.onReconnect(onReconnect);
    connection.emit('ready');
    expect(onReconnect).not.toHaveBeenCalled();
    connection.emit('ready');
    connection.emit('ready');
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  /* The 'error' listener is attached when the subscriber is created (node-redis emits errors while
     connect retries). A throwing onError handler reaches neither the next handler nor the emitter. */
  it('subscriber: an error event reaches onError and a throwing handler does not escape', () => {
    const { subscriber, connection } = setup();
    expect(connection.listenerCount('error')).toBe(1);
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

  /* A throwing reconnect handler does not stop the next one or escape the 'ready' listener. */
  it('subscriber: a throwing reconnect handler does not escape', () => {
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

  /* A throwing onMessage handler does not escape node-redis's pub/sub listener. */
  it('subscriber: a throwing message handler does not escape', async () => {
    const { subscriber, connection } = setup();
    await subscriber.subscribe('ch', () => {
      throw new Error('handler failed');
    });
    expect(() => {
      connection.publishRemote('ch', 'm');
    }).not.toThrow();
  });

  /* Review Focus 4: Redis is down and connect rejects (its reconnect strategy gave up). subscribe
     rejects without sending SUBSCRIBE. The next subscribe connects again and succeeds, messages
     arrive, and close still resolves. */
  it('subscriber: a rejected connect rejects subscribe, and the next subscribe retries connect', async () => {
    const { subscriber, connection } = setup();
    connection.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const onMessage = vi.fn();
    await expect(subscriber.subscribe('ch', onMessage)).rejects.toThrow('ECONNREFUSED');
    expect(connection.subscribe).not.toHaveBeenCalled();

    await expect(subscriber.subscribe('ch', onMessage)).resolves.toBeUndefined();
    expect(connection.connect).toHaveBeenCalledTimes(2);
    expect(connection.subscribe).toHaveBeenCalledTimes(1);
    connection.publishRemote('ch', 'm');
    expect(onMessage).toHaveBeenCalledWith('m');
    await expect(subscriber.close()).resolves.toBeUndefined();
  });

  /* A SUBSCRIBE that rejected (its reply was lost with the socket) is not restored by node-redis.
     The next 'ready' sends it again, and onReconnect fires because messages may have been missed. */
  it('subscriber: a failed SUBSCRIBE is sent again on the next ready', async () => {
    const { subscriber, connection } = setup();
    const onReconnect = vi.fn();
    subscriber.onReconnect(onReconnect);
    connection.subscribe.mockRejectedValueOnce(new Error('Socket closed unexpectedly'));
    const onMessage = vi.fn();
    await expect(subscriber.subscribe('ch', onMessage)).rejects.toThrow('Socket closed');

    connection.emit('ready'); // the first ready: no reconnect of its own
    await flush();
    expect(connection.subscribe).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    connection.publishRemote('ch', 'm');
    expect(onMessage).toHaveBeenCalledWith('m');
  });

  /* A retry on 'ready' that fails again reaches onError, never the emitter. */
  it('subscriber: a failed retry on ready reaches onError', async () => {
    const { subscriber, connection } = setup();
    const onError = vi.fn();
    subscriber.onError?.(onError);
    connection.subscribe.mockRejectedValueOnce(new Error('first')).mockImplementationOnce(() => {
      throw new Error('retry failed');
    });
    await expect(subscriber.subscribe('ch', vi.fn())).rejects.toThrow('first');
    expect(() => connection.emit('ready')).not.toThrow();
    await flush();
    expect(onError).toHaveBeenCalledWith(new Error('retry failed'));
  });

  /* Closing while connect is still pending: subscribe rejects and SUBSCRIBE is never sent; a
     'ready' after close sends nothing either. */
  it('subscriber: close during connect stops the subscribe', async () => {
    const { subscriber, connection } = setup();
    let connected: () => void = () => undefined;
    connection.connect.mockImplementationOnce(
      () =>
        new Promise<FakeNodeRedis>((resolve) => {
          connected = () => {
            resolve(connection);
          };
        }),
    );
    const subscribing = subscriber.subscribe('ch', vi.fn());
    await subscriber.close();
    connected();
    await expect(subscribing).rejects.toThrow('closed');
    connection.emit('ready');
    await flush();
    expect(connection.subscribe).not.toHaveBeenCalled();
  });

  /* Sharded mode (a cluster, Task 6) sends SSUBSCRIBE and receives sharded messages. */
  it('subscriber: sharded mode uses sSubscribe', async () => {
    const connection = new FakeNodeRedis();
    const subscriber = createNodeRedisSubscriber(connection.asNodeRedis(), true);
    const onMessage = vi.fn();
    await subscriber.subscribe('ch', onMessage);
    expect(connection.sSubscribe).toHaveBeenCalledWith('ch', expect.any(Function));
    expect(connection.subscribe).not.toHaveBeenCalled();
    connection.sPublishRemote('ch', 'm');
    expect(onMessage).toHaveBeenCalledWith('m');
  });

  /* Sharded mode over a connection without sSubscribe rejects instead of throwing. */
  it('subscriber: sharded mode without sSubscribe rejects', async () => {
    const connection = new FakeNodeRedis();
    Reflect.deleteProperty(connection, 'sSubscribe');
    const subscriber = createNodeRedisSubscriber(connection.asNodeRedis(), true);
    await expect(subscriber.subscribe('ch', vi.fn())).rejects.toThrow('sSubscribe');
  });

  describe('subscriber: close calls close, falls back to destroy after 1 s, never rejects, and is idempotent', () => {
    /* close settles at once: destroy is never called, the timer is cleared, a second close is a
       no-op. */
    it('closes once and clears its timer when close settles', async () => {
      vi.useFakeTimers();
      const { subscriber, connection } = setup();
      await subscriber.close();
      await subscriber.close();
      expect(connection.close).toHaveBeenCalledTimes(1);
      expect(connection.destroy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    /* close hangs: after 999 ms nothing happens, at 1 s destroy runs and close resolves. */
    it('destroys when close has not settled after 1 s', async () => {
      vi.useFakeTimers();
      const { subscriber, connection } = setup();
      connection.close.mockImplementation(() => new Promise<void>(() => undefined));
      let done = false;
      const closing = subscriber.close().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      expect(connection.destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(done).toBe(true);
      expect(connection.destroy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await subscriber.close();
      expect(connection.close).toHaveBeenCalledTimes(1);
      expect(connection.destroy).toHaveBeenCalledTimes(1);
    });

    /* close rejects (a never-connected client is closed): destroy runs and close still resolves.
       close and destroy both throwing synchronously: close still resolves. */
    it('never rejects, even when close rejects or throws', async () => {
      const rejecting = setup();
      rejecting.connection.close.mockRejectedValue(new Error('The client is closed'));
      await expect(rejecting.subscriber.close()).resolves.toBeUndefined();
      expect(rejecting.connection.destroy).toHaveBeenCalledTimes(1);

      const throwing = setup();
      throwing.connection.close.mockImplementation(() => {
        throw new Error('sync close failure');
      });
      throwing.connection.destroy.mockImplementation(() => {
        throw new Error('sync destroy failure');
      });
      await expect(throwing.subscriber.close()).resolves.toBeUndefined();
    });
  });
});
