import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InvalidationMessage } from '../../../src/stores/cache-store.interface.js';
import { chunkKeys, MAX_PUBLISH_CHARS } from '../../../src/stores/invalidation-chunks.js';
import { redisInvalidationBus } from '../../../src/stores/redis-invalidation-bus.js';
import { FakeRedis } from '../helpers/fake-redis.js';

describe('redisInvalidationBus', () => {
  it('publishes JSON on the default channel', async () => {
    const fake = new FakeRedis();
    await redisInvalidationBus({ client: fake }).publish({ origin: 'a', keys: ['k'] });
    expect(fake.commands).toContainEqual({
      name: 'publish',
      args: ['nestjs-cache:invalidate', '{"origin":"a","keys":["k"]}'],
    });
  });

  it('uses a custom channel', async () => {
    const fake = new FakeRedis();
    await redisInvalidationBus({ client: fake, channel: 'x' }).publish({
      origin: 'a',
      prefix: 'p',
    });
    expect(fake.commands).toContainEqual({
      name: 'publish',
      args: ['x', '{"origin":"a","prefix":"p"}'],
    });
  });

  it('delivers well-formed messages, turns an unknown body into a clear and drops the rest', async () => {
    const fake = new FakeRedis();
    const bus = redisInvalidationBus({ client: fake });
    const got: InvalidationMessage[] = [];
    await bus.subscribe((m) => got.push(m));
    const sub = fake.subscribers[0]!;
    sub.deliver('{"origin":"a","keys":["k"]}');
    sub.deliver('{"origin":"a","prefix":"u:"}');
    sub.deliver('not json');
    sub.deliver('{"keys":["k"]}');
    sub.deliver('{"origin":"a","keys":"k"}');
    sub.deliver('{"origin":"a","keys":[1]}');
    sub.deliver('{"origin":"a","keys":["k"],"prefix":"p"}');
    sub.deliver('{"origin":"a"}');
    sub.deliver('42');
    sub.deliver('null');
    expect(got).toEqual([
      { origin: 'a', keys: ['k'] },
      { origin: 'a', prefix: 'u:' },
      { origin: 'a', prefix: '' },
      { origin: 'a', prefix: '' },
      { origin: 'a', prefix: '' },
      { origin: 'a', prefix: '' },
    ]);
  });

  it('parses every chunk of 30 000 keys as a keys message, not a clear', async () => {
    const fake = new FakeRedis();
    const bus = redisInvalidationBus({ client: fake });
    const got: InvalidationMessage[] = [];
    await bus.subscribe((m) => got.push(m));
    const keys = Array.from({ length: 30_000 }, (_, i) => `k:${String(i).padStart(40, '0')}`);
    const chunks = chunkKeys('a', keys, MAX_PUBLISH_CHARS);
    for (const chunk of chunks) await bus.publish(chunk);
    const sub = fake.subscribers[0]!;
    for (const c of fake.commands) if (c.name === 'publish') sub.deliver(c.args[1] as string);
    expect(got).toHaveLength(chunks.length);
    expect(got.every((m) => 'keys' in m)).toBe(true);
  });

  it('ignores a message without a string origin, whatever its body (P-07)', async () => {
    const fake = new FakeRedis();
    const bus = redisInvalidationBus({ client: fake });
    const got: InvalidationMessage[] = [];
    await bus.subscribe((m) => got.push(m));
    const sub = fake.subscribers[0]!;
    sub.deliver('{"keys":["a"]}');
    sub.deliver('{"origin":1,"keys":["a"]}');
    sub.deliver('"x"');
    sub.deliver('x');
    expect(got).toEqual([]);
  });

  describe('an oversized message', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const MAX = 1_048_576;

    /* a valid message padded with spaces to exactly `length` characters */
    function padded(length: number): string {
      const message = '{"origin":"a","keys":["k"]}';
      return message.slice(0, -1) + ' '.repeat(length - message.length) + '}';
    }

    it('over 1 MiB is not parsed and is delivered as a full clear', async () => {
      /* a forged message would otherwise cost a JSON.parse on every instance */
      const fake = new FakeRedis();
      const bus = redisInvalidationBus({ client: fake });
      const got: InvalidationMessage[] = [];
      await bus.subscribe((m) => got.push(m));
      const parse = vi.spyOn(JSON, 'parse');
      fake.subscribers[0]!.deliver(padded(MAX + 1));
      fake.subscribers[0]!.deliver('x'.repeat(MAX + 1));
      expect(parse).not.toHaveBeenCalled();
      expect(got).toEqual([
        { origin: '', prefix: '' },
        { origin: '', prefix: '' },
      ]);
    });

    it('of exactly 1 MiB is still parsed normally', async () => {
      const fake = new FakeRedis();
      const bus = redisInvalidationBus({ client: fake });
      const got: InvalidationMessage[] = [];
      await bus.subscribe((m) => got.push(m));
      const raw = padded(MAX);
      expect(raw).toHaveLength(MAX);
      fake.subscribers[0]!.deliver(raw);
      fake.subscribers[0]!.deliver('x'.repeat(MAX));
      expect(got).toEqual([{ origin: 'a', keys: ['k'] }]);
    });
  });

  it('gives every handler every message with one subscriber connection', async () => {
    const fake = new FakeRedis();
    const bus = redisInvalidationBus({ client: fake });
    const one = vi.fn();
    const two = vi.fn();
    await bus.subscribe(one);
    await bus.subscribe(two);
    fake.subscribers[0]!.deliver('{"origin":"a","keys":["k"]}');
    expect(fake.subscribers).toHaveLength(1);
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
  });

  it('keeps dispatching when a handler throws, and never throws out of the dispatch', async () => {
    const fake = new FakeRedis();
    const bus = redisInvalidationBus({ client: fake });
    const one = vi.fn(() => {
      throw new Error('handler failed');
    });
    const two = vi.fn();
    await bus.subscribe(one);
    await bus.subscribe(two);
    expect(() => {
      fake.subscribers[0]!.deliver('{"origin":"a","keys":["k"]}');
    }).not.toThrow();
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledWith({ origin: 'a', keys: ['k'] });
  });

  it('forwards reconnects registered before or after subscribe', async () => {
    const fake = new FakeRedis();
    const bus = redisInvalidationBus({ client: fake });
    const before = vi.fn();
    const after = vi.fn();
    bus.onReconnect(before);
    await bus.subscribe(() => undefined);
    bus.onReconnect(after);
    fake.subscribers[0]!.triggerReconnect();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('close before subscribe is a no-op', async () => {
    const fake = new FakeRedis();
    const bus = redisInvalidationBus({ client: fake });
    await bus.close();
    await bus.close();
    expect(fake.subscribers).toHaveLength(0);
  });

  it('a later subscribe retries after a rejected one, on the same connection (F1)', async () => {
    const fake = new FakeRedis();
    fake.subscribeFailures.push(new Error('unreachable'));
    const bus = redisInvalidationBus({ client: fake });
    const handler = vi.fn();
    await expect(bus.subscribe(handler)).rejects.toThrow('unreachable');
    await expect(bus.subscribe(handler)).resolves.toBeUndefined();
    expect(fake.subscribers).toHaveLength(1);
    expect(fake.subscribers[0]!.subscribeCalls).toBe(2);
    // the same handler passed twice is registered once
    fake.subscribers[0]!.deliver('{"origin":"a","keys":["k"]}');
    expect(handler).toHaveBeenCalledTimes(1);
    // once subscribed, the promise is shared again
    await bus.subscribe(vi.fn());
    expect(fake.subscribers[0]!.subscribeCalls).toBe(2);
  });

  it('forwards subscriber errors to onError handlers registered before or after subscribe (F2)', async () => {
    const fake = new FakeRedis();
    const bus = redisInvalidationBus({ client: fake });
    const before = vi.fn();
    const after = vi.fn();
    bus.onError?.(before);
    await bus.subscribe(() => undefined);
    bus.onError?.(after);
    const error = new Error('ECONNREFUSED');
    fake.subscribers[0]!.triggerError(error);
    expect(before).toHaveBeenCalledWith(error);
    expect(after).toHaveBeenCalledWith(error);
  });
});
