import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../../../src/core/cache.service.js';
import { CacheEvents, type CacheEventMap } from '../../../src/core/events.js';
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
});
