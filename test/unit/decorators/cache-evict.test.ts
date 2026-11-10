import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheEvents, type CacheEventMap } from '../../../src/core/events.js';
import { CacheEvict, CacheModule, CachePut } from '../../../src/index.js';
import { EVENT_NAMES } from '../helpers/engine.js';
import { FakeStore } from '../helpers/fake-store.js';

/** A readonly key list, as `as const` produces. */
const READONLY_KEYS = ['user:{0}', (id: string) => `profile:${id}`] as const;

type Entry = string | { op: 'delete'; keys: readonly string[] } | { op: 'clear'; prefix: string };

const log: Entry[] = [];

class LoggingStore extends FakeStore {
  override delete(keys: readonly string[]): Promise<void> {
    log.push({ op: 'delete', keys: [...keys] });
    return super.delete(keys);
  }

  override clear(prefix: string): Promise<void> {
    log.push({ op: 'clear', prefix });
    return super.clear(prefix);
  }
}

@Injectable()
class UserRemover {
  calls = 0;

  @CacheEvict({ namespace: 'users', key: 'user:{0}' })
  async remove(id: string): Promise<string> {
    this.calls++;
    log.push('method');
    return `removed ${id}`;
  }

  @CacheEvict({ namespace: 'users', key: 'user:{0}' })
  async removeFailing(id: string): Promise<void> {
    log.push('method');
    throw new Error(`nope ${id}`);
  }

  @CacheEvict({ namespace: 'users', key: 'user:{0}', beforeInvocation: true })
  async removeEarly(id: string): Promise<void> {
    log.push('method');
    throw new Error(`late ${id}`);
  }

  @CacheEvict({ namespace: 'users', key: ['user:{0}', (id: string) => `profile:${id}`] })
  async removeMany(id: string): Promise<void> {
    log.push(`method ${id}`);
  }

  @CacheEvict({ namespace: 'users', key: READONLY_KEYS })
  async removeReadonly(id: string): Promise<void> {
    log.push(`method ${id}`);
  }

  @CacheEvict({ namespace: 'users', allEntries: true })
  async importAll(): Promise<void> {
    log.push('method');
  }

  @CacheEvict()
  async byFilter(filter: Map<string, string>): Promise<number> {
    this.calls++;
    return filter.size;
  }

  @CacheEvict({ namespace: 'users', key: 'user:{0}' })
  @CacheEvict({ namespace: 'teams', key: 'team:{0}' })
  async removeTwice(id: string): Promise<void> {
    this.calls++;
    log.push(`method ${id}`);
  }

  @CachePut({ namespace: 'users', key: 'user:{0}' })
  @CacheEvict({ namespace: 'lists', allEntries: true })
  async rename(id: string, name: string): Promise<{ id: string; name: string }> {
    this.calls++;
    return { id, name };
  }
}

describe('@CacheEvict', () => {
  let app: TestingModule;
  let svc: UserRemover;
  let fake: LoggingStore;
  let emitted: { event: keyof CacheEventMap; payload: unknown }[];

  beforeEach(async () => {
    log.length = 0;
    fake = new LoggingStore();
    const fake2 = new FakeStore();
    app = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ stores: { default: fake, sessions: fake2 } })],
      providers: [UserRemover],
    }).compile();
    await app.init();
    svc = app.get(UserRemover);
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

  it('evicts after the method succeeds', async () => {
    expect(await svc.remove('1')).toBe('removed 1');
    expect(log).toEqual(['method', { op: 'delete', keys: ['users:user:1'] }]);
  });

  it('does not evict when the method throws', async () => {
    await expect(svc.removeFailing('1')).rejects.toThrow('nope 1');
    expect(log).toEqual(['method']);
    expect(fake.calls.filter((c) => c.op === 'delete')).toEqual([]);
  });

  it('evicts first with beforeInvocation, even if the method throws', async () => {
    await expect(svc.removeEarly('1')).rejects.toThrow('late 1');
    expect(log).toEqual([{ op: 'delete', keys: ['users:user:1'] }, 'method']);
  });

  it('evicts every key in an array', async () => {
    await svc.removeMany('1');
    expect(fake.calls).toEqual([{ op: 'delete', args: [['users:user:1', 'users:profile:1']] }]);
  });

  it('evicts every key in a readonly array', async () => {
    await svc.removeReadonly('3');
    expect(fake.calls).toEqual([{ op: 'delete', args: [['users:user:3', 'users:profile:3']] }]);
    expect(log).toEqual(['method 3', { op: 'delete', keys: ['users:user:3', 'users:profile:3'] }]);
  });

  it('clears the namespace with allEntries', async () => {
    await svc.importAll();
    expect(fake.calls).toEqual([{ op: 'clear', args: ['users:'] }]);
    expect(log).toEqual(['method', { op: 'clear', prefix: 'users:' }]);
  });

  it('returns the method result when eviction fails', async () => {
    fake.failNext('delete');
    await expect(svc.remove('1')).resolves.toBe('removed 1');
    expect(emitted).toContainEqual({
      event: 'error',
      payload: expect.objectContaining({ operation: 'delete' }) as unknown,
    });
  });

  it('skips the eviction but runs the method when the key cannot be built', async () => {
    expect(await svc.byFilter(new Map([['a', 'b']]))).toBe(1);
    expect(svc.calls).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(emitted.filter((e) => e.event === 'error')).toEqual([
      { event: 'error', payload: expect.objectContaining({ operation: 'key' }) as unknown },
    ]);
  });

  it('stacks two @CacheEvict, and @CachePut with @CacheEvict', async () => {
    await svc.removeTwice('1');
    expect(svc.calls).toBe(1);
    const deleted = fake.calls.filter((c) => c.op === 'delete').map((c) => c.args[0]);
    expect(deleted).toEqual(expect.arrayContaining([['users:user:1'], ['teams:team:1']]));
    expect(deleted).toHaveLength(2);

    svc.calls = 0;
    fake.calls.length = 0;
    expect(await svc.rename('2', 'bo')).toEqual({ id: '2', name: 'bo' });
    expect(svc.calls).toBe(1);
    expect(fake.calls.map((c) => c.op).sort()).toEqual(['clear', 'set']);
    expect(fake.data.has('users:user:2')).toBe(true);
  });

  it('reports a static method with its class name before validating options', () => {
    expect(() => {
      class S {
        @CacheEvict({ key: [] }) static a(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).toThrow('S.a: cache decorators cannot be used on static methods');
  });
});
