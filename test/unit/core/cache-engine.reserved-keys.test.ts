import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { CacheEvents, type CacheEventMap } from '../../../src/core/events.js';
import { CacheModule, Cacheable } from '../../../src/index.js';
import { EVENT_NAMES, makeEngine } from '../helpers/engine.js';
import { FakeStore } from '../helpers/fake-store.js';

const RESERVED = '__version__:users';
const MESSAGE = 'Invalid key: keys starting with "__" are reserved; use a namespace';

function keyErrors(emitted: { event: keyof CacheEventMap; payload: unknown }[]): unknown[] {
  return emitted.filter((e) => e.event === 'error').map((e) => e.payload);
}

describe('reserved keys (no namespace, key starts with "__")', () => {
  it('get misses with one key error and no store call', async () => {
    const { engine, store, emitted } = makeEngine();
    expect(await engine.get({ key: RESERVED })).toBeUndefined();
    expect(store.calls).toEqual([]);
    const errors = keyErrors(emitted);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ operation: 'key' });
    expect((errors[0] as { error: Error }).error.message).toBe(MESSAGE);
  });

  it('set resolves and writes nothing', async () => {
    const { engine, store, emitted } = makeEngine();
    await expect(engine.set({ key: RESERVED }, 1)).resolves.toBeUndefined();
    expect(store.calls).toEqual([]);
    expect(keyErrors(emitted)).toHaveLength(1);
  });

  it('put resolves and writes nothing', async () => {
    const { engine, store, emitted } = makeEngine();
    await expect(engine.put({ key: RESERVED }, 1)).resolves.toBeUndefined();
    expect(store.calls).toEqual([]);
    expect(keyErrors(emitted)).toHaveLength(1);
  });

  it('getOrSet loads uncached', async () => {
    const { engine, store, emitted } = makeEngine();
    let calls = 0;
    const loader = (): Promise<number> => Promise.resolve(++calls);
    expect(await engine.getOrSet({ key: RESERVED }, loader)).toBe(1);
    expect(await engine.getOrSet({ key: RESERVED }, loader)).toBe(2);
    expect(store.calls).toEqual([]);
    expect(keyErrors(emitted)).toHaveLength(2);
  });

  it('delete drops the reserved key and deletes the others', async () => {
    const { engine, store, emitted } = makeEngine();
    await engine.set({ key: 'ok' }, 1);
    await engine.delete({}, [RESERVED, 'ok']);
    expect(store.data.has('ok')).toBe(false);
    expect(store.calls.filter((c) => c.op === 'delete')).toEqual([
      { op: 'delete', args: [['ok']] },
    ]);
    expect(keyErrors(emitted)).toHaveLength(1);
  });

  it('getMany keeps the other keys and reports one key error', async () => {
    const { engine, store, emitted } = makeEngine();
    await engine.set({ key: 'a' }, 1);
    emitted.length = 0;
    expect(await engine.getMany({}, ['__x', 'a', '__y'])).toEqual([undefined, 1, undefined]);
    expect(keyErrors(emitted)).toHaveLength(1);
    expect(store.calls.some((c) => JSON.stringify(c.args).includes('__'))).toBe(false);
  });

  it('setMany writes only the valid entries', async () => {
    const { engine, store, emitted } = makeEngine();
    await engine.setMany({}, [
      ['__x', 1],
      ['a', 2],
    ]);
    expect([...store.data.keys()]).toEqual(['a']);
    expect(keyErrors(emitted)).toHaveLength(1);
  });

  it('getOrSetMany loads the reserved key uncached', async () => {
    const { engine, store, emitted } = makeEngine();
    const loaded: string[][] = [];
    const loader = (missing: string[]): Promise<Map<string, number>> => {
      loaded.push(missing);
      return Promise.resolve(new Map(missing.map((k) => [k, 1])));
    };
    await engine.getOrSetMany({}, ['__x', 'a'], loader);
    expect(loaded).toEqual([['a']]);
    expect([...store.data.keys()]).toEqual(['a']);
    expect(keyErrors(emitted)).toHaveLength(1);
  });

  it('a namespaced key starting with "__" caches normally', async () => {
    const { engine, store, emitted } = makeEngine();
    await engine.set({ namespace: 'users', key: '__x' }, 1);
    expect(await engine.get({ namespace: 'users', key: '__x' })).toBe(1);
    expect([...store.data.keys()]).toContain('users:__x');
    expect(keyErrors(emitted)).toEqual([]);
  });

  it('a key with "__" past the first two characters caches normally', async () => {
    const { engine, emitted } = makeEngine();
    await engine.set({ key: 'a__b' }, 1);
    expect(await engine.get({ key: 'a__b' })).toBe(1);
    expect(keyErrors(emitted)).toEqual([]);
  });
});

describe('@Cacheable with an untrusted key template', () => {
  @Injectable()
  class Service {
    calls = 0;

    @Cacheable({ key: '{0}' })
    async find(id: string): Promise<string> {
      this.calls++;
      return `v:${id}`;
    }
  }

  it('runs the method, reports one key error and never touches the reserved key', async () => {
    const store = new FakeStore();
    const app = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ stores: { default: store } })],
      providers: [Service],
    }).compile();
    await app.init();
    const emitted: { event: keyof CacheEventMap; payload: unknown }[] = [];
    for (const event of EVENT_NAMES) {
      app.get(CacheEvents).on(event, (payload) => emitted.push({ event, payload }));
    }
    const svc = app.get(Service);
    expect(await svc.find(RESERVED)).toBe(`v:${RESERVED}`);
    expect(svc.calls).toBe(1);
    expect(keyErrors(emitted)).toHaveLength(1);
    expect(store.calls).toEqual([]);
    await app.close();
  });
});
