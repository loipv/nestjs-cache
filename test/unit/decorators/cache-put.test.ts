import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { CacheService } from '../../../src/core/cache.service.js';
import { CacheEvents, type CacheEventMap } from '../../../src/core/events.js';
import { CacheConfigError } from '../../../src/errors.js';
import { CacheModule, CachePut } from '../../../src/index.js';
import { EVENT_NAMES } from '../helpers/engine.js';
import { FakeStore } from '../helpers/fake-store.js';

interface User {
  id: string;
  name: string;
}

@Injectable()
class UserWriter {
  calls = 0;

  @CachePut({ namespace: 'users', key: 'user:{0}' })
  async update(id: string, dto: { name: string }): Promise<User> {
    this.calls++;
    return { id, name: dto.name };
  }

  @CachePut({ namespace: 'users', key: 'user:{0}' })
  async wipe(id: string): Promise<User | null> {
    this.calls++;
    return id === '' ? { id, name: '' } : null;
  }

  @CachePut({ key: 'p:{0}', condition: (id: string) => id !== 'skip' })
  async conditional(id: string): Promise<string> {
    this.calls++;
    return id;
  }

  @CachePut({ key: 'sw:{0}', ttl: 100, strategy: 'swr', staleTtl: 300 })
  async swr(id: string): Promise<string> {
    return id;
  }

  @CachePut({ key: 'sl:{0}', strategy: 'sliding', maxTtl: 120_000 })
  async sliding(id: string): Promise<string> {
    return id;
  }

  @CachePut()
  async byFilter(filter: Map<string, string>): Promise<string[]> {
    this.calls++;
    return [...filter.values()];
  }
}

describe('@CachePut', () => {
  let app: TestingModule;
  let svc: UserWriter;
  let fake: FakeStore;
  let emitted: { event: keyof CacheEventMap; payload: unknown }[];

  beforeEach(async () => {
    fake = new FakeStore();
    const fake2 = new FakeStore();
    app = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ stores: { default: fake, sessions: fake2 } })],
      providers: [UserWriter],
    }).compile();
    await app.init();
    svc = app.get(UserWriter);
    emitted = [];
    const events = app.get(CacheEvents);
    for (const event of EVENT_NAMES) {
      events.on(event, (payload) => emitted.push({ event, payload }));
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('always runs the method and overwrites the entry', async () => {
    expect(await svc.update('1', { name: 'a' })).toEqual({ id: '1', name: 'a' });
    expect(await svc.update('1', { name: 'b' })).toEqual({ id: '1', name: 'b' });
    expect(svc.calls).toBe(2);
    const cache = app.get(CacheService);
    expect(await cache.get('user:1', { namespace: 'users' })).toEqual({ id: '1', name: 'b' });
  });

  it('deletes the entry when the result is empty and cacheNull is off', async () => {
    const cache = app.get(CacheService);
    await cache.set('user:9', { id: '9', name: 'old' }, { namespace: 'users' });
    expect(fake.data.has('users:user:9')).toBe(true);
    expect(await svc.wipe('9')).toBeNull();
    expect(fake.data.has('users:user:9')).toBe(false);
    expect(fake.calls.at(-1)).toEqual({ op: 'delete', args: [['users:user:9']] });
  });

  it('does not touch the cache when condition is false', async () => {
    expect(await svc.conditional('skip')).toBe('skip');
    expect(svc.calls).toBe(1);
    expect(fake.calls).toEqual([]);
    await svc.conditional('keep');
    expect(fake.data.has('p:keep')).toBe(true);
  });

  it('runs the method and skips the write when the key cannot be built', async () => {
    expect(await svc.byFilter(new Map([['a', 'b']]))).toEqual(['b']);
    expect(svc.calls).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(emitted.filter((e) => e.event === 'error')).toEqual([
      { event: 'error', payload: expect.objectContaining({ operation: 'key' }) as unknown },
    ]);
  });

  it('@CachePut writes swr and sliding envelopes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000);
      await svc.swr('1');
      expect(fake.data.get('sw:1')?.ttlMs).toBe(400);
      expect(JSON.parse(fake.data.get('sw:1')!.value)).toEqual({
        v: 1,
        value: '1',
        storedAt: 1_000,
        staleAt: 1_100,
        expiresAt: 1_400,
      });
      expect(emitted.at(-1)).toEqual({
        event: 'set',
        payload: { store: 'default', namespace: undefined, key: 'sw:1', ttl: 400 },
      });
      await svc.sliding('2');
      expect(fake.data.get('sl:2')?.ttlMs).toBe(60_000);
      expect(JSON.parse(fake.data.get('sl:2')!.value)).toEqual({
        v: 1,
        value: '2',
        storedAt: 1_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes strategy options to put, with only the defined fields', async () => {
    const put = vi.spyOn(CacheEngine.prototype, 'put');
    await svc.swr('1');
    await svc.sliding('2');
    await svc.conditional('3');
    await svc.swr('4');
    expect(put.mock.calls.map((c) => c[2])).toStrictEqual([
      { ttl: 100, strategy: 'swr', staleTtl: 300 },
      { strategy: 'sliding', maxTtl: 120_000 },
      {},
      { ttl: 100, strategy: 'swr', staleTtl: 300 },
    ]);
    // built once at decoration time
    expect(put.mock.calls[3]![2]).toBe(put.mock.calls[0]![2]);
  });

  it('reports a static method before validating its options', () => {
    expect(() => {
      class S {
        @CachePut({ nullTtl: -1 }) static a(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).toThrow(CacheConfigError);
    expect(() => {
      class S {
        @CachePut({ ttl: 0, strategy: 'sliding', maxTtl: 0 }) static b(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).toThrow('S.b: cache decorators cannot be used on static methods');
  });
});
