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

  it('sinkFor carries the log level; a custom sink without logLevel counts as error', () => {
    /* … */
    const events = new CacheEvents();
    expect(events.sinkFor('s').logLevel).toBe('error');
    expect(events.sinkFor('s', 'off').logLevel).toBe('off');
    expect(events.sinkFor('s', 'debug').logLevel).toBe('debug');
    const seen: unknown[] = [];
    events.on('breaker', (p) => seen.push(p));
    events.sinkFor('s', 'off').emit('breaker', { state: 'open' });
    expect(seen).toEqual([{ store: 's', state: 'open' }]);
  });

  it('sinkFor stamps the store on breaker events', () => {
    const ev = new CacheEvents();
    const seen: unknown[] = [];
    ev.on('breaker', (p) => seen.push(p));
    ev.sinkFor('sessions').emit('breaker', { state: 'open' });
    expect(seen).toEqual([{ store: 'sessions', state: 'open' }]);
  });

  it('sinkFor picks the event by name, whatever the payload shape', () => {
    const ev = new CacheEvents();
    const seen: { event: string; payload: unknown }[] = [];
    ev.on('error', (payload) => seen.push({ event: 'error', payload }));
    ev.on('breaker', (payload) => seen.push({ event: 'breaker', payload }));
    const sink = ev.sinkFor('s');
    // Misuse the overloads prevent at compile time: a breaker payload sent as 'error' is not
    // dropped, and an error payload sent as 'breaker' does not become an error event.
    sink.emit('error', { state: 'open' } as unknown as { operation: 'get'; error: unknown });
    sink.emit('breaker', { operation: 'get', error: 'x' } as unknown as { state: 'open' });
    // The fields the event name expects are forwarded as they are, here undefined.
    expect(seen).toStrictEqual([
      { event: 'error', payload: { store: 's', operation: undefined, error: undefined } },
      { event: 'breaker', payload: { store: 's', state: undefined } },
    ]);
  });

  it('sinkFor ignores an unknown event name without throwing', () => {
    const ev = new CacheEvents();
    const seen: unknown[] = [];
    ev.on('error', (p) => seen.push(p));
    ev.on('breaker', (p) => seen.push(p));
    const sink = ev.sinkFor('s');
    expect(() => {
      sink.emit('bogus' as 'error', { operation: 'get', error: 'x' });
    }).not.toThrow();
    expect(seen).toEqual([]);
  });

  it('delivers lock events', () => {
    const ev = new CacheEvents();
    const seen: unknown[] = [];
    ev.on('lock', (p) => seen.push(p));
    const payload = { store: 's', namespace: undefined, key: 'k', waitedMs: 3, acquired: true };
    ev.emit('lock', payload);
    expect(seen).toEqual([payload]);
  });
});
