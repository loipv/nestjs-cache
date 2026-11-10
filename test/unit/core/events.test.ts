import { describe, expect, it, vi } from 'vitest';
import { CacheEvents } from '../../../src/core/events.js';

describe('CacheEvents', () => {
  it('delivers payloads to listeners of that event only', () => {
    const events = new CacheEvents();
    const onMiss = vi.fn();
    const onHit = vi.fn();
    events.on('hit', onHit);
    events.on('miss', onMiss);
    const payload = { store: 'default', namespace: undefined, key: 'k', stale: false };
    events.emit('hit', payload);
    expect(onHit).toHaveBeenCalledExactlyOnceWith(payload);
    expect(onMiss).not.toHaveBeenCalled();
  });

  it('on returns an unsubscribe function', () => {
    const events = new CacheEvents();
    const listener = vi.fn();
    const off = events.on('miss', listener);
    const payload = { store: 'default', namespace: undefined, key: 'k' };
    events.emit('miss', payload);
    off();
    off();
    events.emit('miss', payload);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('unsubscribe removes only that registration', () => {
    const events = new CacheEvents();
    const listener = vi.fn();
    const off = events.on('miss', listener);
    events.on('miss', listener);
    off();
    events.emit('miss', { store: 's', namespace: undefined, key: 'k' });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('calls listeners in registration order and survives self-unsubscribe', () => {
    const events = new CacheEvents();
    const order: number[] = [];
    const off = events.on('miss', () => {
      order.push(1);
      off();
    });
    events.on('miss', () => order.push(2));
    events.on('miss', () => order.push(3));
    const payload = { store: 's', namespace: undefined, key: 'k' };
    events.emit('miss', payload);
    events.emit('miss', payload);
    expect(order).toEqual([1, 2, 3, 2, 3]);
  });

  it('a throwing listener does not stop the others and is reported', () => {
    const reported: unknown[] = [];
    const events = new CacheEvents((e) => reported.push(e));
    const second = vi.fn();
    const boom = new Error('boom');
    events.on('miss', () => {
      throw boom;
    });
    events.on('miss', second);
    expect(() => {
      events.emit('miss', { store: 'default', namespace: undefined, key: 'k' });
    }).not.toThrow();
    expect(second).toHaveBeenCalledOnce();
    expect(reported).toEqual([boom]);
  });

  it('swallows listener errors when no handler is given', () => {
    const events = new CacheEvents();
    events.on('miss', () => {
      throw new Error('x');
    });
    expect(() => {
      events.emit('miss', { store: 's', namespace: undefined, key: 'k' });
    }).not.toThrow();
  });

  it('sinkFor stamps the store name', () => {
    const events = new CacheEvents();
    const seen: unknown[] = [];
    events.on('error', (p) => seen.push(p));
    const error = new Error('x');
    events.sinkFor('sessions').emit('error', { operation: 'get', error });
    expect(seen).toEqual([{ store: 'sessions', operation: 'get', error }]);
  });
});
