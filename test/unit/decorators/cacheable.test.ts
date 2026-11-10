import 'reflect-metadata';
import { Injectable, Scope } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheEvents, type CacheEventMap } from '../../../src/core/events.js';
import { CacheConfigError } from '../../../src/errors.js';
import { CacheModule, Cacheable } from '../../../src/index.js';
import { EVENT_NAMES } from '../helpers/engine.js';
import { FakeStore } from '../helpers/fake-store.js';

interface Query {
  term: string;
}

let requestCalls = 0;

@Injectable()
class UserService {
  calls = 0;

  @Cacheable({ namespace: 'users', key: 'user:{0}' })
  async find(id: string): Promise<{ id: string }> {
    this.calls++;
    return { id };
  }

  @Cacheable({ key: (q: Query, page: number) => `s:${q.term}:${page}` })
  async searchPaged(q: Query, page: number): Promise<string[]> {
    this.calls++;
    return [`${q.term}:${page}`];
  }

  @Cacheable()
  async findAll(): Promise<number[]> {
    this.calls++;
    return [1, 2];
  }

  @Cacheable()
  async search(q: Query): Promise<string> {
    this.calls++;
    return q.term;
  }

  @Cacheable({ key: 'c:{0}', condition: (id: string) => id !== 'skip' })
  async conditional(id: string): Promise<string> {
    this.calls++;
    return id;
  }

  @Cacheable({
    key: (id: string): string => {
      throw new Error(`bad key ${id}`);
    },
  })
  async badKey(id: string): Promise<string> {
    this.calls++;
    return `v${id}`;
  }

  @Cacheable()
  async byFilter(filter: Map<string, string>): Promise<string[]> {
    this.calls++;
    return [...filter.values()];
  }

  @Cacheable({ key: 'u:{0}', unless: (r: string) => r === 'skip' })
  async unlessCase(value: string): Promise<string> {
    return value;
  }

  @Cacheable({ key: 'ttl', ttl: 5_000 })
  async withTtl(): Promise<number> {
    return 1;
  }

  @Cacheable({ key: 'nul', cacheNull: true, nullTtl: 9 })
  async nullable(): Promise<null> {
    return null;
  }

  @Cacheable({ store: 'sessions', key: 'sess' })
  async session(): Promise<string> {
    return 's';
  }

  @Cacheable({ key: 'boom' })
  async failing(): Promise<number> {
    this.calls++;
    throw new Error('boom');
  }
}

@Injectable({ scope: Scope.REQUEST })
class RequestService {
  @Cacheable({ key: 'req:{0}' })
  async load(id: string): Promise<string> {
    requestCalls++;
    return `r${id}`;
  }
}

describe('@Cacheable', () => {
  let app: TestingModule;
  let svc: UserService;
  let fake: FakeStore;
  let fake2: FakeStore;
  let emitted: { event: keyof CacheEventMap; payload: unknown }[];

  beforeEach(async () => {
    fake = new FakeStore();
    fake2 = new FakeStore();
    app = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ stores: { default: fake, sessions: fake2 } })],
      providers: [UserService, RequestService],
    }).compile();
    await app.init();
    svc = app.get(UserService);
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

  it('runs the method once per distinct argument', async () => {
    expect(await svc.find('1')).toEqual({ id: '1' });
    expect(await svc.find('1')).toEqual({ id: '1' });
    expect(await svc.find('2')).toEqual({ id: '2' });
    expect(svc.calls).toBe(2);
  });

  it('builds the key from a template under the namespace', async () => {
    await svc.find('42');
    expect(fake.data.has('users:user:42')).toBe(true);
  });

  it('builds the key from a callback', async () => {
    expect(await svc.searchPaged({ term: 'abc' }, 2)).toEqual(['abc:2']);
    expect([...fake.data.keys()]).toEqual(['s:abc:2']);
  });

  it('uses Class.method and an argument hash by default', async () => {
    await svc.findAll();
    await svc.search({ term: 'x' });
    expect([...fake.data.keys()]).toEqual(
      expect.arrayContaining([
        'UserService.findAll',
        expect.stringMatching(/^UserService\.search:[0-9a-f]{16}$/),
      ]),
    );
  });

  it('skips the cache when condition is false', async () => {
    expect(await svc.conditional('skip')).toBe('skip');
    expect(await svc.conditional('skip')).toBe('skip');
    expect(svc.calls).toBe(2);
    expect(fake.calls).toEqual([]);
  });

  it('falls back to the method when the key callback throws', async () => {
    expect(await svc.badKey('1')).toBe('v1');
    const errors = emitted.filter((e) => e.event === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.payload).toMatchObject({ store: 'default', operation: 'key' });
    expect((errors[0]!.payload as { error: Error }).error.message).toBe('bad key 1');
    expect(fake.calls).toEqual([]);
  });

  it('falls back to the method for Map arguments with the default key (Review Focus 5)', async () => {
    const a = await svc.byFilter(new Map([['role', 'admin']]));
    const b = await svc.byFilter(new Map([['role', 'guest']]));
    expect(a).not.toEqual(b);
    expect(fake.data.size).toBe(0);
    expect(emitted.filter((e) => e.event === 'error').length).toBe(2);
  });

  it('honours unless, ttl, cacheNull and nullTtl', async () => {
    expect(await svc.unlessCase('skip')).toBe('skip');
    expect(fake.data.has('u:skip')).toBe(false);
    await svc.unlessCase('keep');
    expect(fake.data.has('u:keep')).toBe(true);

    await svc.withTtl();
    expect(fake.data.get('ttl')?.ttlMs).toBe(5_000);

    expect(await svc.nullable()).toBeNull();
    expect(fake.data.get('nul')?.ttlMs).toBe(9);
  });

  it('uses the named store', async () => {
    await svc.session();
    expect(fake2.data.has('sess')).toBe(true);
    expect(fake.data.has('sess')).toBe(false);
  });

  it('returns the method result when the store read fails', async () => {
    fake.failNext('get');
    expect(await svc.find('7')).toEqual({ id: '7' });
    expect(emitted).toContainEqual({
      event: 'error',
      payload: expect.objectContaining({ operation: 'get' }) as unknown,
    });
  });

  it('propagates method errors and caches nothing', async () => {
    await expect(svc.failing()).rejects.toThrow('boom');
    await expect(svc.failing()).rejects.toThrow('boom');
    expect(svc.calls).toBe(2);
    expect(fake.data.size).toBe(0);
  });

  it('works on a request-scoped provider', async () => {
    requestCalls = 0;
    const first = await app.resolve(RequestService);
    const second = await app.resolve(RequestService);
    expect(first).not.toBe(second);
    expect(await first.load('1')).toBe('r1');
    expect(await second.load('1')).toBe('r1');
    expect(requestCalls).toBe(1);
    expect(fake.data.has('req:1')).toBe(true);
  });

  it('throws CacheConfigError for a malformed template at class definition', () => {
    expect(() => {
      class S {
        @Cacheable({ key: 'user:{id}' }) a(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).toThrow(CacheConfigError);
  });

  it('names the class and method in a template error', () => {
    expect(() => {
      class Repo {
        @Cacheable({ key: 'x}' }) load(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return Repo;
    }).toThrow(/^Repo\.load: Invalid cache key template "x}"/);
  });
});
