import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ioredisAdapter } from '../../../src/stores/ioredis.adapter.js';
import type { IoredisLike } from '../../../src/stores/ioredis.adapter.js';

class FakeConnection extends EventEmitter {
  get = vi.fn();
  set = vi.fn();
  getex = vi.fn();
  unlink = vi.fn();
  scan = vi.fn();
  publish = vi.fn();
  subscribe = vi.fn(() => Promise.resolve(1));
  quit = vi.fn(() => Promise.resolve('OK'));
  duplicate(): IoredisLike {
    throw new Error('not used');
  }
}

describe('ioredisAdapter subscriber', () => {
  it('onReconnect fires from the second ready onward', () => {
    const connection = new FakeConnection();
    const fake = new FakeConnection();
    fake.duplicate = () => connection as unknown as IoredisLike;
    const handler = vi.fn();
    ioredisAdapter(fake as unknown as IoredisLike)
      .createSubscriber()
      .onReconnect(handler);
    connection.emit('ready');
    expect(handler).not.toHaveBeenCalled();
    connection.emit('ready');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
