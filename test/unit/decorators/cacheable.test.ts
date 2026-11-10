import 'reflect-metadata';
import { Injectable, Logger, Scope } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { CacheEvents, type CacheEventMap } from '../../../src/core/events.js';
import * as strategies from '../../../src/core/strategies/expiry-strategy.js';
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

  @Cacheable({ key: '{0}' })
  async raw(id: string): Promise<string> {
    this.calls++;
    return `raw${id}`;
  }

  @Cacheable({ key: (id: string) => id })
  async rawCallback(id: string): Promise<string> {
    this.calls++;
    return `raw${id}`;
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

  @Cacheable({ key: 'swr', ttl: 100, strategy: 'swr', staleTtl: 300 })
  async swr(): Promise<number> {
    this.calls++;
    return this.calls;
  }

  readonly swrCalls: { self: unknown; args: unknown[] }[] = [];

  @Cacheable({ key: 'swr:{0}:{1}', ttl: 100, strategy: 'swr', staleTtl: 300 })
  async swrArgs(id: string, page: number): Promise<string> {
    this.swrCalls.push({ self: this, args: [id, page] });
    return `${id}:${String(page)}:${String(this.swrCalls.length)}`;
  }

  @Cacheable({ key: 'locked', lock: true })
  async locked(): Promise<number> {
    return 1;
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

  it.each([
    ['template', 'raw'],
    ['callback', 'rawCallback'],
  ] as const)(
    'treats a %s key that renders empty as a key error and runs the method uncached',
    async (_kind, method) => {
      /* '' would collapse the full key to the bare namespace (or prefix), so it is never used */
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      expect(await svc[method]('')).toBe('raw');
      expect(await svc[method]('')).toBe('raw');
      expect(svc.calls).toBe(2);
      expect(fake.calls).toEqual([]);
      const errors = emitted.filter((e) => e.event === 'error');
      expect(errors).toHaveLength(2);
      expect(errors[0]!.payload).toMatchObject({ store: 'default', operation: 'key' });
      expect((errors[0]!.payload as { error: Error }).error.message).toBe(
        'Cache key must not be empty',
      );
      expect(emitted.filter((e) => e.event !== 'error')).toEqual([]);
    },
  );

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

  it('@Cacheable with swr serves stale data and refreshes it in the background', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(0);
      expect(await svc.swr()).toBe(1);
      expect(fake.data.get('swr')?.ttlMs).toBe(400);
      vi.setSystemTime(150);
      emitted.length = 0;
      expect(await svc.swr()).toBe(1);
      await new Promise((r) => setImmediate(r));
      expect(svc.calls).toBe(2);
      expect(emitted.map((e) => e.event)).toEqual(['hit', 'load', 'set']);
      expect(emitted[0]?.payload).toEqual({
        store: 'default',
        namespace: undefined,
        key: 'swr',
        stale: true,
      });
      // The refreshed entry is fresh until 250.
      vi.setSystemTime(200);
      expect(await svc.swr()).toBe(2);
      expect(svc.calls).toBe(2);
      // Past its expiresAt (550) the entry is a miss and loads in the foreground.
      vi.setSystemTime(550);
      expect(await svc.swr()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('@Cacheable swr re-invokes the method with the same this and args', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(0);
      expect(await svc.swrArgs('a', 2)).toBe('a:2:1');
      vi.setSystemTime(150);
      expect(await svc.swrArgs('a', 2)).toBe('a:2:1');
      await new Promise((r) => setImmediate(r));
      expect(svc.swrCalls).toHaveLength(2);
      expect(svc.swrCalls[1]?.self).toBe(svc);
      expect(svc.swrCalls[1]?.args).toEqual(['a', 2]);
      expect(await svc.swrArgs('a', 2)).toBe('a:2:2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes strategy and lock to getOrSet, with only the defined fields', async () => {
    const getOrSet = vi.spyOn(CacheEngine.prototype, 'getOrSet');
    await svc.swr();
    await svc.locked();
    await svc.findAll();
    await svc.withTtl();
    await svc.swr();
    expect(getOrSet.mock.calls.map((c) => c[2])).toStrictEqual([
      { ttl: 100, strategy: 'swr', staleTtl: 300 },
      { lock: true },
      {},
      { ttl: 5_000 },
      { ttl: 100, strategy: 'swr', staleTtl: 300 },
    ]);
    // built once at decoration time
    expect(getOrSet.mock.calls[4]![2]).toBe(getOrSet.mock.calls[0]![2]);
  });

  it('reports a static method before validating its options', () => {
    expect(() => {
      class S {
        @Cacheable({ ttl: 0 }) static a(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).toThrow('S.a: cache decorators cannot be used on static methods');
    expect(() => {
      class S {
        @Cacheable({ strategy: 'swr', staleTtl: -1, key: 'x}' }) static b(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).toThrow('S.b: cache decorators cannot be used on static methods');
  });

  it('builds the expiry strategy once at decoration time, not per call', async () => {
    const create = vi.spyOn(strategies, 'createStrategy');
    @Injectable()
    class Once {
      @Cacheable({ key: 'once:{0}', ttl: 100, strategy: 'swr', staleTtl: 300 })
      async find(id: string): Promise<string> {
        return id;
      }
    }
    expect(create).toHaveBeenCalledTimes(1);
    const ref = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ stores: { default: new FakeStore() } })],
      providers: [Once],
    }).compile();
    await ref.init();
    const once = ref.get(Once);
    for (const id of ['a', 'b', 'a', 'c', 'b']) expect(await once.find(id)).toBe(id);
    expect(create).toHaveBeenCalledTimes(1);
    await ref.close();
  });

  it('still rejects each call with an unknown strategy, as before', async () => {
    const bad = { strategy: 'lru' } as unknown as { strategy: 'fixed' };
    @Injectable()
    class Bad {
      @Cacheable(bad)
      async find(): Promise<number> {
        return 1;
      }
    }
    const ref = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ stores: { default: new FakeStore() } })],
      providers: [Bad],
    }).compile();
    await ref.init();
    const instance = ref.get(Bad);
    await expect(instance.find()).rejects.toThrow(CacheConfigError);
    await expect(instance.find()).rejects.toThrow('Unknown cache strategy: lru');
    await ref.close();
  });
});

@Injectable()
class EscapeService {
  @Cacheable({ namespace: 'n', key: '{0}' })
  async tpl(id: string): Promise<string> {
    return id;
  }

  @Cacheable({ namespace: 'n', key: (id: string) => `cb:${id}` })
  async cb(id: string): Promise<string> {
    return id;
  }
}

describe('@Cacheable with escapeKeyArgs', () => {
  async function keysFor(escapeKeyArgs: boolean | undefined): Promise<string[]> {
    const fake = new FakeStore();
    const app = await Test.createTestingModule({
      imports: [
        CacheModule.forRoot({
          stores: { default: fake },
          ...(escapeKeyArgs === undefined ? {} : { escapeKeyArgs }),
        }),
      ],
      providers: [EscapeService],
    }).compile();
    await app.init();
    const svc = app.get(EscapeService);
    await svc.tpl('a:b');
    await svc.cb('a:b');
    await app.close();
    return [...fake.data.keys()].sort();
  }

  /* With the option on, template args are escaped in the stored key; a key callback is not. */
  it('escapes template args but not callback keys when enabled', async () => {
    expect(await keysFor(true)).toEqual(['n:a%3Ab', 'n:cb:a:b']);
  });

  /* Without the option the 0.3 keys are stored. */
  it('keeps the 0.3 keys by default', async () => {
    expect(await keysFor(undefined)).toEqual(['n:a:b', 'n:cb:a:b']);
  });
});
