import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import { ioredisAdapter, RELEASE_SCRIPT } from '../../../src/stores/ioredis.adapter.js';
import { keySlot } from '../../../src/stores/key-slot.js';
import type { RedisSubscriberAdapter } from '../../../src/stores/redis-client.adapter.js';
import { FakeCluster, FakeConnection } from '../helpers/fake-ioredis.js';

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

describe('ioredisAdapter cluster mode', () => {
  /* '{a}1' and '{a}2' share the slot of 'a'; '{b}1' is in another slot. One MGET per slot, and
     the values come back in input order with null mapped to undefined. */
  it('uses per-slot MGET in cluster mode', async () => {
    expect(keySlot('{a}1')).not.toBe(keySlot('{b}1'));
    const cluster = new FakeCluster();
    cluster.mget.mockImplementation((...keys: string[]) =>
      Promise.resolve(keys.map((key) => (key === '{a}2' ? null : `v:${key}`))),
    );
    const adapter = ioredisAdapter(cluster.asCluster());
    await expect(adapter.mget?.(['{a}1', '{b}1', '{a}2'])).resolves.toEqual([
      'v:{a}1',
      'v:{b}1',
      undefined,
    ]);
    expect(cluster.mget).toHaveBeenCalledTimes(2);
    expect(cluster.mget).toHaveBeenCalledWith('{a}1', '{a}2');
    expect(cluster.mget).toHaveBeenCalledWith('{b}1');
  });

  /* Keys in two slots: one UNLINK per slot, each with only that slot's keys. */
  it('uses per-slot UNLINK in cluster mode', async () => {
    const cluster = new FakeCluster();
    cluster.unlink.mockResolvedValue(1);
    const adapter = ioredisAdapter(cluster.asCluster());
    await adapter.unlink(['{a}1', '{b}1', '{a}2']);
    expect(cluster.unlink).toHaveBeenCalledTimes(2);
    expect(cluster.unlink).toHaveBeenCalledWith('{a}1', '{a}2');
    expect(cluster.unlink).toHaveBeenCalledWith('{b}1');
  });

  /* Review Focus 3: empty key lists resolve at once and never reach the cluster client. */
  it('sends no command for empty mget or unlink in cluster mode', async () => {
    const cluster = new FakeCluster();
    const adapter = ioredisAdapter(cluster.asCluster());
    await expect(adapter.mget?.([])).resolves.toEqual([]);
    await expect(adapter.unlink([])).resolves.toBeUndefined();
    expect(cluster.mget).not.toHaveBeenCalled();
    expect(cluster.unlink).not.toHaveBeenCalled();
  });

  /* Three masters: the first has two pages, the second none, the third one. scanIterator asks
     for the masters, scans each to cursor '0' with MATCH/COUNT and yields the non-empty pages. */
  it('scanIterator walks every master', async () => {
    const cluster = new FakeCluster();
    const [m1, m2, m3] = cluster.masters;
    m1!.scan.mockResolvedValueOnce(['5', ['p:1']]).mockResolvedValueOnce(['0', ['p:2']]);
    m2!.scan.mockResolvedValueOnce(['0', []]);
    m3!.scan.mockResolvedValueOnce(['0', ['p:3']]);
    const adapter = ioredisAdapter(cluster.asCluster());
    const pages: string[][] = [];
    for await (const page of adapter.scanIterator!('p:*', 100)) pages.push(page);
    expect(pages).toEqual([['p:1'], ['p:2'], ['p:3']]);
    expect(cluster.nodes).toHaveBeenCalledWith('master');
    expect(m1!.scan.mock.calls).toEqual([
      ['0', 'MATCH', 'p:*', 'COUNT', 100],
      ['5', 'MATCH', 'p:*', 'COUNT', 100],
    ]);
    expect(m2!.scan).toHaveBeenCalledWith('0', 'MATCH', 'p:*', 'COUNT', 100);
    expect(m3!.scan).toHaveBeenCalledWith('0', 'MATCH', 'p:*', 'COUNT', 100);
    expect(cluster.scan).not.toHaveBeenCalled();
  });

  /* A cursor scan cannot cover a cluster: scan rejects with a CacheConfigError that points to
     scanIterator, and sends nothing. */
  it('scan rejects with CacheConfigError in cluster mode', async () => {
    const cluster = new FakeCluster();
    const adapter = ioredisAdapter(cluster.asCluster());
    const scanning = adapter.scan('0', '*', 100);
    await expect(scanning).rejects.toBeInstanceOf(CacheConfigError);
    await expect(scanning).rejects.toThrow('scanIterator');
    expect(cluster.scan).not.toHaveBeenCalled();
  });

  /* publish goes through SPUBLISH. The subscriber is a duplicate with shardedSubscribers forced
     on; it sends SSUBSCRIBE and delivers 'smessage' events, never using SUBSCRIBE or 'message'. */
  it('publishes with spublish and subscribes with ssubscribe on smessage in cluster mode', async () => {
    const cluster = new FakeCluster();
    const adapter = ioredisAdapter(cluster.asCluster());
    const subscriber = adapter.createSubscriber();
    expect(cluster.duplicateCalls).toEqual([[[], { shardedSubscribers: true }]]);
    const connection = cluster.clusterDuplicates[0]!;
    const onMessage = vi.fn();
    await subscriber.subscribe('ch', onMessage);
    expect(connection.ssubscribe).toHaveBeenCalledWith('ch');
    expect(connection.subscribe).not.toHaveBeenCalled();

    await adapter.publish('ch', 'hello');
    expect(cluster.spublish).toHaveBeenCalledWith('ch', 'hello');
    expect(cluster.publish).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith('hello');

    connection.emit('message', 'ch', 'unsharded');
    expect(onMessage).toHaveBeenCalledTimes(1);
    await subscriber.close();
    expect(connection.quit).toHaveBeenCalledTimes(1);
  });

  /* A failed SSUBSCRIBE is sent again on 'ready', as for the unsharded subscriber. */
  it('retries a failed ssubscribe on ready in cluster mode', async () => {
    const cluster = new FakeCluster();
    const subscriber = ioredisAdapter(cluster.asCluster()).createSubscriber();
    const connection = cluster.clusterDuplicates[0]!;
    connection.ssubscribe.mockImplementationOnce(() => Promise.reject(new Error('MOVED')));
    const onMessage = vi.fn();
    await expect(subscriber.subscribe('ch', onMessage)).rejects.toThrow('MOVED');
    connection.emit('ready');
    await flush();
    connection.spublishRemote('ch', 'm');
    expect(onMessage).toHaveBeenCalledWith('m');
    expect(connection.ssubscribe).toHaveBeenCalledTimes(2);
  });

  /* A plain client, whether isCluster is false (a real ioredis Redis) or absent, keeps the 0.4
     behaviour: no scanIterator, PUBLISH, a plain duplicate and SUBSCRIBE. */
  it('a non-cluster client (isCluster false or absent) behaves exactly as in 0.4', async () => {
    const absent = new FakeConnection();
    const explicit = Object.assign(new FakeConnection(), { isCluster: false });
    for (const client of [absent, explicit]) {
      client.unlink.mockResolvedValue(2);
      client.scan.mockResolvedValue(['0', ['k']]);
      const adapter = ioredisAdapter(client.asIoredis());
      expect('scanIterator' in adapter).toBe(false);
      await adapter.publish('ch', 'm');
      expect(client.publish).toHaveBeenCalledWith('ch', 'm');
      await adapter.unlink(['{a}1', '{b}1']);
      expect(client.unlink).toHaveBeenCalledWith('{a}1', '{b}1');
      await expect(adapter.scan('0', '*', 10)).resolves.toEqual({ cursor: '0', keys: ['k'] });
      await adapter.createSubscriber().subscribe('ch', vi.fn());
      expect(client.duplicates[0]!.subscribe).toHaveBeenCalledWith('ch');
    }
  });
});
