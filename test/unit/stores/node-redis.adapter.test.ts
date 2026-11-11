import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import { keySlot } from '../../../src/stores/key-slot.js';
import {
  createNodeRedisSubscriber,
  nodeRedisAdapter,
} from '../../../src/stores/node-redis.adapter.js';
import { RELEASE_SCRIPT } from '../../../src/stores/redis-client.adapter.js';
import type { RedisSubscriberAdapter } from '../../../src/stores/redis-client.adapter.js';
import { redisStore } from '../../../src/stores/redis.store.js';
import {
  FakeNodeRedis,
  FakeNodeRedisCluster,
  FakeNodeRedisSentinel,
} from '../helpers/fake-node-redis.js';

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

describe('nodeRedisAdapter cluster mode', () => {
  /* '{a}1' and '{a}2' share the slot of 'a'; '{b}1' is in another slot. One mGet per slot, and
     the values come back in input order with null mapped to undefined. */
  it('cluster: per-slot mGet', async () => {
    expect(keySlot('{a}1')).not.toBe(keySlot('{b}1'));
    const cluster = new FakeNodeRedisCluster();
    cluster.mGet.mockImplementation((keys: string[]) =>
      Promise.resolve(keys.map((key) => (key === '{a}2' ? null : `v:${key}`))),
    );
    const adapter = nodeRedisAdapter(cluster.asCluster());
    await expect(adapter.mget?.(['{a}1', '{b}1', '{a}2'])).resolves.toEqual([
      'v:{a}1',
      'v:{b}1',
      undefined,
    ]);
    expect(cluster.mGet).toHaveBeenCalledTimes(2);
    expect(cluster.mGet).toHaveBeenCalledWith(['{a}1', '{a}2']);
    expect(cluster.mGet).toHaveBeenCalledWith(['{b}1']);
  });

  /* Keys in two slots: one unlink per slot, each with only that slot's keys. */
  it('cluster: per-slot unlink', async () => {
    const cluster = new FakeNodeRedisCluster();
    cluster.unlink.mockResolvedValue(1);
    const adapter = nodeRedisAdapter(cluster.asCluster());
    await expect(adapter.unlink(['{a}1', '{b}1', '{a}2'])).resolves.toBeUndefined();
    expect(cluster.unlink).toHaveBeenCalledTimes(2);
    expect(cluster.unlink).toHaveBeenCalledWith(['{a}1', '{a}2']);
    expect(cluster.unlink).toHaveBeenCalledWith(['{b}1']);
  });

  /* Review Focus 3: empty key lists resolve at once and never reach the cluster client. */
  it('cluster: empty lists send nothing', async () => {
    const cluster = new FakeNodeRedisCluster();
    const adapter = nodeRedisAdapter(cluster.asCluster());
    await expect(adapter.mget?.([])).resolves.toEqual([]);
    await expect(adapter.unlink([])).resolves.toBeUndefined();
    expect(cluster.mGet).not.toHaveBeenCalled();
    expect(cluster.unlink).not.toHaveBeenCalled();
  });

  /* Three masters: the first has two pages, the second none, the third one. scanIterator gets
     each master's client from nodeClient, scans it to cursor '0' with MATCH/COUNT and yields the
     non-empty pages. The cluster's own scan (one random node) is never used. */
  it('cluster: scanIterator scans every master through nodeClient', async () => {
    const cluster = new FakeNodeRedisCluster();
    const [n1, n2, n3] = cluster.masterClients;
    n1!.scan
      .mockResolvedValueOnce({ cursor: '5', keys: ['p:1'] })
      .mockResolvedValueOnce({ cursor: '0', keys: ['p:2'] });
    n2!.scan.mockResolvedValueOnce({ cursor: '0', keys: [] });
    n3!.scan.mockResolvedValueOnce({ cursor: '0', keys: ['p:3'] });
    const adapter = nodeRedisAdapter(cluster.asCluster());
    const pages: string[][] = [];
    for await (const page of adapter.scanIterator!('p:*', 100)) pages.push(page);
    expect(pages).toEqual([['p:1'], ['p:2'], ['p:3']]);
    for (const master of cluster.masters) expect(cluster.nodeClient).toHaveBeenCalledWith(master);
    expect(n1!.scan.mock.calls).toEqual([
      ['0', { MATCH: 'p:*', COUNT: 100 }],
      ['5', { MATCH: 'p:*', COUNT: 100 }],
    ]);
    expect(n2!.scan).toHaveBeenCalledWith('0', { MATCH: 'p:*', COUNT: 100 });
    expect(n3!.scan).toHaveBeenCalledWith('0', { MATCH: 'p:*', COUNT: 100 });
    expect(cluster.scan).not.toHaveBeenCalled();
  });

  /* A cluster that knows no master yet (its connect has not finished discovery): scanning zero
     masters would let clear succeed while deleting nothing, so scanIterator rejects with a plain
     Error (not a CacheConfigError), RedisStore.clear rejects with it and no UNLINK is sent. */
  it('cluster: scanIterator and clear reject when no master is known', async () => {
    const cluster = new FakeNodeRedisCluster();
    cluster.masters = [];
    const adapter = nodeRedisAdapter(cluster.asCluster());
    const pages: string[][] = [];
    const iterating = (async () => {
      for await (const page of adapter.scanIterator!('*', 100)) pages.push(page);
    })();
    await expect(iterating).rejects.toThrow('no cluster master');
    await expect(iterating).rejects.not.toBeInstanceOf(CacheConfigError);
    expect(pages).toEqual([]);

    const store = redisStore({ client: adapter });
    await expect(store.clear('')).rejects.toThrow('no cluster master');
    expect(cluster.unlink).not.toHaveBeenCalled();
  });

  /* A cursor scan cannot cover a cluster: scan rejects with a CacheConfigError that points to
     scanIterator, and sends nothing. */
  it('cluster: scan rejects with CacheConfigError', async () => {
    const cluster = new FakeNodeRedisCluster();
    const adapter = nodeRedisAdapter(cluster.asCluster());
    const scanning = adapter.scan('0', '*', 100);
    await expect(scanning).rejects.toBeInstanceOf(CacheConfigError);
    await expect(scanning).rejects.toThrow('scanIterator');
    expect(cluster.scan).not.toHaveBeenCalled();
  });

  /* publish goes through SPUBLISH. The subscriber is a cluster duplicate that connects on the
     first subscribe and sends SSUBSCRIBE, never SUBSCRIBE; the SPUBLISH reaches its handler. */
  it('cluster: publish uses sPublish and the subscriber uses sSubscribe', async () => {
    const cluster = new FakeNodeRedisCluster();
    const adapter = nodeRedisAdapter(cluster.asCluster());
    const subscriber = adapter.createSubscriber();
    expect(cluster.duplicate).toHaveBeenCalledTimes(1);
    const connection = cluster.duplicates[0]!;
    expect(connection).toBeInstanceOf(FakeNodeRedisCluster);
    const onMessage = vi.fn();
    await subscriber.subscribe('ch', onMessage);
    expect(connection.connect).toHaveBeenCalledTimes(1);
    expect(connection.sSubscribe).toHaveBeenCalledWith('ch', expect.any(Function));
    expect(connection.subscribe).not.toHaveBeenCalled();

    await expect(adapter.publish('ch', 'hello')).resolves.toBeUndefined();
    expect(cluster.sPublish).toHaveBeenCalledWith('ch', 'hello');
    expect(cluster.publish).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith('hello');
    await subscriber.close();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  /* A cluster re-emits each node client's errors as 'node-error' (error, clientInfo), and its own
     discovery errors as 'error'. Both reach every onError handler; a throwing handler reaches
     neither the next handler nor node-redis's emitter. */
  it('cluster: node-error and error events of the subscriber connection reach onError', () => {
    const cluster = new FakeNodeRedisCluster();
    const subscriber = nodeRedisAdapter(cluster.asCluster()).createSubscriber();
    const connection = cluster.duplicates[0]!;
    const failing = vi.fn(() => {
      throw new Error('handler failed');
    });
    const onError = vi.fn();
    subscriber.onError?.(failing);
    subscriber.onError?.(onError);
    const nodeError = new Error('ECONNRESET');
    expect(() =>
      connection.emit('node-error', nodeError, { host: '127.0.0.1', port: 7000 }),
    ).not.toThrow();
    const discoveryError = new Error('ECONNREFUSED');
    expect(() => connection.emit('error', discoveryError)).not.toThrow();
    expect(onError.mock.calls).toEqual([[nodeError], [discoveryError]]);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  /* 'node-ready' is registered with .once per node client, so it never marks a reconnect: the
     cluster subscriber fires no onReconnect, whatever node events arrive. */
  it('cluster: node-ready fires no onReconnect', async () => {
    const cluster = new FakeNodeRedisCluster();
    const subscriber = nodeRedisAdapter(cluster.asCluster()).createSubscriber();
    const connection = cluster.duplicates[0]!;
    const onReconnect = vi.fn();
    subscriber.onReconnect(onReconnect);
    await subscriber.subscribe('ch', vi.fn());
    for (let i = 0; i < 3; i += 1) {
      connection.emit('node-ready', { host: '127.0.0.1', port: 7000 });
      connection.emit('node-reconnecting', { host: '127.0.0.1', port: 7000 });
    }
    await flush();
    expect(onReconnect).not.toHaveBeenCalled();
  });
});

describe('nodeRedisAdapter sentinel mode', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /* T1-A: a client whose getSentinelNode is a function is a Sentinel. Every data command goes to
     the sentinel object (which routes it to the master), as on a single client. */
  it('sentinel: data commands go to the sentinel object', async () => {
    const sentinel = new FakeNodeRedisSentinel();
    sentinel.get.mockResolvedValueOnce('v').mockResolvedValueOnce(null);
    sentinel.set.mockResolvedValue('OK');
    sentinel.getEx.mockResolvedValue('v');
    sentinel.eval.mockResolvedValue(1);
    sentinel.unlink.mockResolvedValue(2);
    sentinel.mGet.mockResolvedValue(['a', null]);
    sentinel.scan.mockResolvedValue({ cursor: '0', keys: ['p:1'] });
    const adapter = nodeRedisAdapter(sentinel.asSentinel());

    expect(await adapter.get('k')).toBe('v');
    expect(await adapter.get('missing')).toBeUndefined();
    await adapter.set('k', 'v', 1500.2);
    expect(sentinel.set).toHaveBeenCalledWith('k', 'v', {
      expiration: { type: 'PX', value: 1501 },
    });
    expect(await adapter.getex('k', 100)).toBe('v');
    expect(sentinel.getEx).toHaveBeenCalledWith('k', { type: 'PX', value: 100 });
    expect(await adapter.setIfAbsent?.('k', 'v', 5_000)).toBe(true);
    expect(sentinel.set).toHaveBeenLastCalledWith('k', 'v', {
      expiration: { type: 'PX', value: 5_000 },
      condition: 'NX',
    });
    expect(await adapter.deleteIfEquals?.('k', 't')).toBe(true);
    expect(sentinel.eval).toHaveBeenCalledWith(RELEASE_SCRIPT, { keys: ['k'], arguments: ['t'] });
    await adapter.unlink(['a', 'b']);
    expect(sentinel.unlink).toHaveBeenCalledWith(['a', 'b']);
    expect(await adapter.mget?.(['a', 'b'])).toEqual(['a', undefined]);
    expect(await adapter.scan('0', 'p:*', 100)).toEqual({ cursor: '0', keys: ['p:1'] });
    expect(sentinel.scan).toHaveBeenCalledWith('0', { MATCH: 'p:*', COUNT: 100 });
    await adapter.publish('ch', 'm');
    expect(sentinel.publish).toHaveBeenCalledWith('ch', 'm');
    await adapter.ping?.();
    expect(sentinel.ping).toHaveBeenCalledTimes(1);
    expect(sentinel.connect).not.toHaveBeenCalled();

    const store = redisStore({ client: adapter });
    expect(store.lock).toBeDefined();
    expect(store.ping).toBeDefined();
  });

  /* A Sentinel has no duplicate: the subscriber subscribes on the sentinel object itself, whose
     pub/sub proxy follows the master. It never connects (the sentinel is connected already), and
     a message published through the sentinel reaches only its channel's handler. */
  it('sentinel: the subscriber subscribes on the sentinel object without connecting', async () => {
    const sentinel = new FakeNodeRedisSentinel();
    const adapter = nodeRedisAdapter(sentinel.asSentinel());
    const subscriber = adapter.createSubscriber();
    const onA = vi.fn();
    const onB = vi.fn();
    await Promise.all([subscriber.subscribe('a', onA), subscriber.subscribe('b', onB)]);
    await subscriber.subscribe('a', onA);
    expect(sentinel.subscribe.mock.calls).toEqual([
      ['a', expect.any(Function)],
      ['b', expect.any(Function)],
    ]);
    expect(sentinel.connect).not.toHaveBeenCalled();

    await adapter.publish('a', 'm1');
    expect(onA).toHaveBeenCalledWith('m1');
    expect(onB).not.toHaveBeenCalled();
  });

  /* Only a function counts: a single client that happens to carry a non-function getSentinelNode
     property is still duplicated for its subscriber. */
  it('sentinel: detection needs getSentinelNode to be a function', () => {
    const client = new FakeNodeRedis();
    Object.assign(client, { getSentinelNode: 'not a function' });
    nodeRedisAdapter(client.asNodeRedis()).createSubscriber();
    expect(client.duplicate).toHaveBeenCalledTimes(1);
  });

  /* T1-A: close only unsubscribes the subscriber's own channels with its own listener. The user's
     sentinel is never closed or destroyed, a listener the user added on the same channel keeps
     receiving, and the sentinel still serves commands. A later subscribe rejects; a second close
     is a no-op. */
  it('sentinel: close only unsubscribes its channels and never closes the client', async () => {
    const sentinel = new FakeNodeRedisSentinel();
    const adapter = nodeRedisAdapter(sentinel.asSentinel());
    const subscriber = adapter.createSubscriber();
    const onMessage = vi.fn();
    await subscriber.subscribe('a', onMessage);
    await subscriber.subscribe('b', onMessage);
    const userListener = vi.fn();
    await sentinel.subscribe('a', userListener);
    const [, listener] = sentinel.subscribe.mock.calls[0]!;

    await expect(subscriber.close()).resolves.toBeUndefined();
    await subscriber.close();
    expect(sentinel.unsubscribe.mock.calls).toEqual([
      ['a', listener],
      ['b', listener],
    ]);
    expect(sentinel.close).not.toHaveBeenCalled();
    expect(sentinel.destroy).not.toHaveBeenCalled();

    await adapter.publish('a', 'after');
    expect(userListener).toHaveBeenCalledWith('after', 'a');
    expect(onMessage).not.toHaveBeenCalled();
    sentinel.get.mockResolvedValue('v');
    expect(await adapter.get('k')).toBe('v');
    await expect(subscriber.subscribe('c', vi.fn())).rejects.toThrow('subscriber is closed');
    expect(sentinel.subscribe).toHaveBeenCalledTimes(3);
  });

  /* Two stores share one sentinel, so they get two subscribers on the same object. Closing one
     leaves the other's subscription in place. */
  it('sentinel: closing one subscriber keeps another subscriber on the same sentinel', async () => {
    const sentinel = new FakeNodeRedisSentinel();
    const adapter = nodeRedisAdapter(sentinel.asSentinel());
    const first = adapter.createSubscriber();
    const second = adapter.createSubscriber();
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    await first.subscribe('ch', onFirst);
    await second.subscribe('ch', onSecond);
    await first.close();
    await adapter.publish('ch', 'm');
    expect(onFirst).not.toHaveBeenCalled();
    expect(onSecond).toHaveBeenCalledWith('m');
  });

  /* close never rejects: an UNSUBSCRIBE that rejects or throws is swallowed and does not stop the
     other channels' UNSUBSCRIBE, and one that hangs is abandoned after 1 s. Nothing is closed or
     destroyed, and the timer is cleared. */
  it('sentinel: close never rejects and gives up on a hanging unsubscribe after 1 s', async () => {
    const rejecting = new FakeNodeRedisSentinel();
    const rejectingSub = nodeRedisAdapter(rejecting.asSentinel()).createSubscriber();
    await rejectingSub.subscribe('a', vi.fn());
    await rejectingSub.subscribe('b', vi.fn());
    await rejectingSub.subscribe('c', vi.fn());
    rejecting.unsubscribe
      .mockRejectedValueOnce(new Error('The client is closed'))
      .mockImplementationOnce(() => {
        throw new Error('sync failure');
      });
    await expect(rejectingSub.close()).resolves.toBeUndefined();
    expect(rejecting.unsubscribe.mock.calls.map(([channel]) => channel)).toEqual(['a', 'b', 'c']);

    vi.useFakeTimers();
    const hanging = new FakeNodeRedisSentinel();
    const hangingSub = nodeRedisAdapter(hanging.asSentinel()).createSubscriber();
    await hangingSub.subscribe('a', vi.fn());
    hanging.unsubscribe.mockImplementation(() => new Promise<void>(() => undefined));
    let done = false;
    const closing = hangingSub.close().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(done).toBe(true);
    expect(hanging.close).not.toHaveBeenCalled();
    expect(hanging.destroy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  /* The sentinel's 'error' events (its pub/sub proxy and node clients re-emit through it) reach
     every onError handler; a throwing handler reaches neither the next one nor the emitter. After
     close the subscriber's listeners are removed from the user's sentinel. */
  it('sentinel: error events reach onError until close', async () => {
    const sentinel = new FakeNodeRedisSentinel();
    const subscriber = nodeRedisAdapter(sentinel.asSentinel()).createSubscriber();
    expect(sentinel.listenerCount('error')).toBe(1);
    const failing = vi.fn(() => {
      throw new Error('handler failed');
    });
    const onError = vi.fn();
    subscriber.onError?.(failing);
    subscriber.onError?.(onError);
    const error = new Error('Connection timeout');
    expect(() => sentinel.emit('error', error)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(error);
    expect(failing).toHaveBeenCalledTimes(1);

    await subscriber.close();
    expect(sentinel.listenerCount('error')).toBe(0);
    expect(sentinel.listenerCount('topology-change')).toBe(0);
  });

  /* The sentinel never emits 'ready'. A MASTER_CHANGE topology event means the pub/sub proxy
     moved to a new master and messages may have been missed: onReconnect fires, and a SUBSCRIBE
     that had rejected is sent again. Other topology events fire nothing. */
  it('sentinel: a master change fires onReconnect and resends a failed subscribe', async () => {
    const sentinel = new FakeNodeRedisSentinel();
    const subscriber = nodeRedisAdapter(sentinel.asSentinel()).createSubscriber();
    const onReconnect = vi.fn();
    subscriber.onReconnect(onReconnect);
    sentinel.subscribe.mockRejectedValueOnce(new Error('Connection timeout'));
    const onMessage = vi.fn();
    await expect(subscriber.subscribe('ch', onMessage)).rejects.toThrow('Connection timeout');

    sentinel.emit('topology-change', { type: 'REPLICA_ADD', node: { host: 'r', port: 6379 } });
    sentinel.emit('topology-change', { type: 'SENTINEL_CHANGE', node: { host: 's', port: 1 } });
    sentinel.emit('topology-change', undefined);
    await flush();
    expect(onReconnect).not.toHaveBeenCalled();
    expect(sentinel.subscribe).toHaveBeenCalledTimes(1);

    sentinel.masterChange();
    await flush();
    expect(sentinel.subscribe).toHaveBeenCalledTimes(2);
    // once for the master change, once for the channel that recovered
    expect(onReconnect).toHaveBeenCalledTimes(2);
    await sentinel.publish('ch', 'm');
    expect(onMessage).toHaveBeenCalledWith('m');
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

  /* F-2: after close, a subscribe rejects before it opens a connection. */
  it('subscribe after close rejects without connecting', async () => {
    const { subscriber, connection } = setup();
    await subscriber.close();
    await expect(subscriber.subscribe('ch', vi.fn())).rejects.toThrow('subscriber is closed');
    expect(connection.connect).not.toHaveBeenCalled();
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

  /* 0.5-FW-2: closed before connect and closed during connect reject with one message. */
  it('subscriber: both closed paths reject with the same message', async () => {
    const message = 'nodeRedisAdapter: the subscriber is closed';
    const before = setup();
    await before.subscriber.close();
    await expect(before.subscriber.subscribe('ch', vi.fn())).rejects.toThrow(message);

    const during = setup();
    let connected: () => void = () => undefined;
    during.connection.connect.mockImplementationOnce(
      () =>
        new Promise<FakeNodeRedis>((resolve) => {
          connected = () => {
            resolve(during.connection);
          };
        }),
    );
    const subscribing = during.subscriber.subscribe('ch', vi.fn());
    await during.subscriber.close();
    connected();
    await expect(subscribing).rejects.toThrow(message);
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
