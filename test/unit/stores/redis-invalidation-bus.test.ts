import { describe, expect, it, vi } from 'vitest';
import type { InvalidationMessage } from '../../../src/stores/cache-store.interface.js';
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

  it('delivers well-formed messages and drops everything else', async () => {
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
    ]);
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
});
