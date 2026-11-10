import { describe, expect, it } from 'vitest';
import { CircuitOpenError } from '../../../src/resilience/circuit-breaker.store.js';
import { makeEngine } from '../helpers/engine.js';
import { FakeLock } from '../helpers/fake-lock.js';
import { FakeStore } from '../helpers/fake-store.js';

const names = (emitted: { event: string }[]): string[] => emitted.map((e) => e.event);

describe('CacheEngine with an open circuit', () => {
  it('an open circuit is a silent miss for getOrSet', async () => {
    const { engine, store, emitted } = makeEngine();
    store.failNext('get', new CircuitOpenError());
    store.failNext('set', new CircuitOpenError());
    expect(await engine.getOrSet({ key: 'k' }, async () => 1)).toBe(1);
    expect(emitted.some((e) => e.event === 'error')).toBe(false);
    expect(names(emitted)).toContain('miss');
  });

  it('open-circuit writes, deletes and clears emit no error', async () => {
    const { engine, store, emitted } = makeEngine();
    store.failNext('set', new CircuitOpenError());
    store.failNext('delete', new CircuitOpenError());
    store.failNext('clear', new CircuitOpenError());
    await engine.set({ key: 'k' }, 1);
    await engine.delete({}, ['k']);
    await engine.clear('ns');
    expect(emitted.some((e) => e.event === 'error')).toBe(false);
  });

  it('open-circuit lock acquire loads without lock and emits neither error nor lock', async () => {
    const lock = new FakeLock();
    const store = Object.assign(new FakeStore(), { lock: lock });
    const { engine, emitted } = makeEngine({ stores: { default: store } });
    lock.failNext('acquire', new CircuitOpenError());
    expect(await engine.getOrSet({ key: 'k' }, async () => 7, { lock: true })).toBe(7);
    expect(lock.acquireCalls).toHaveLength(1);
    expect(names(emitted)).not.toContain('error');
    expect(names(emitted)).not.toContain('lock');
  });

  it('open-circuit lock release emits no error', async () => {
    const lock = new FakeLock();
    const store = Object.assign(new FakeStore(), { lock: lock });
    const { engine, emitted } = makeEngine({ stores: { default: store } });
    lock.failNext('release', new CircuitOpenError());
    expect(await engine.getOrSet({ key: 'k' }, async () => 7, { lock: true })).toBe(7);
    expect(names(emitted)).not.toContain('error');
  });

  it('real store errors are still reported', async () => {
    const { engine, store, emitted } = makeEngine();
    store.failNext('get', new Error('x'));
    await engine.getOrSet({ key: 'k' }, async () => 1);
    expect(emitted.filter((e) => e.event === 'error')).toEqual([
      { event: 'error', payload: expect.objectContaining({ operation: 'get' }) as unknown },
    ]);
  });
});
