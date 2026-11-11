import 'reflect-metadata';
import { Injectable, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { CacheService } from '../../../src/core/cache.service.js';
import { CacheEvents, type CacheEventMap } from '../../../src/core/events.js';
import * as strategies from '../../../src/core/strategies/expiry-strategy.js';
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

  @CachePut({ key: '{0}' })
  async putRaw(id: string): Promise<string> {
    this.calls++;
    return `raw${id}`;
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

  it('runs the method and skips the write when the key renders empty', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await svc.putRaw('')).toBe('raw');
    expect(svc.calls).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(emitted).toEqual([
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
        @CachePut({ nullTtl: -1 }) static a(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).toThrow('S.a: cache decorators cannot be used on static methods');
    expect(() => {
      class S {
        @CachePut({ ttl: 0, strategy: 'sliding', maxTtl: 0 }) static b(): Promise<number> {
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
      @CachePut({ key: 'once:{0}', strategy: 'sliding', maxTtl: 120_000 })
      async save(id: string): Promise<string> {
        return id;
      }
    }
    expect(create).toHaveBeenCalledTimes(1);
    const store = new FakeStore();
    const ref = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ stores: { default: store } })],
      providers: [Once],
    }).compile();
    await ref.init();
    const once = ref.get(Once);
    for (const id of ['a', 'b', 'a', 'c']) expect(await once.save(id)).toBe(id);
    expect(store.data.has('once:c')).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    await ref.close();
  });
});

const putTagCalls: unknown[][] = [];
let gate: { started: () => void; wait: Promise<void> } | undefined;

@Injectable()
class TaggedWriter {
  calls = 0;

  @CachePut({ namespace: 'users', key: 'user:{0}', tags: ['user:{0}'] })
  async save(id: string, dto: { name: string }): Promise<User> {
    this.calls++;
    if (gate !== undefined) {
      gate.started();
      await gate.wait;
    }
    return { id, name: dto.name };
  }

  @CachePut({
    key: 'n:{0}',
    tags: (result: User, id: string, dto: { name: string }) => {
      putTagCalls.push([result, id, dto]);
      return [`name:${result.name}`];
    },
  })
  async rename(id: string, dto: { name: string }): Promise<User> {
    this.calls++;
    return { id, name: dto.name };
  }

  @CachePut({
    key: 'bad:{0}',
    tags: (): string[] => Array.from({ length: 33 }, (_, i) => `t${String(i)}`),
  })
  async tooMany(id: string): Promise<string> {
    this.calls++;
    return id;
  }

  @CachePut({ key: 'e:{0}', tags: ['{0}'] })
  async emptyTag(id: string): Promise<string> {
    this.calls++;
    return `v${id}`;
  }
}

describe('@CachePut tags', () => {
  let app: TestingModule;
  let svc: TaggedWriter;
  let fake: FakeStore;
  let cache: CacheService;
  let errors: unknown[];

  function stampAt(key: string): Record<string, string> | undefined {
    const raw = fake.data.get(key)?.value;
    return raw === undefined
      ? undefined
      : (JSON.parse(raw) as { tags?: Record<string, string> }).tags;
  }

  beforeEach(async () => {
    putTagCalls.length = 0;
    gate = undefined;
    fake = new FakeStore();
    app = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ stores: { default: fake } })],
      providers: [TaggedWriter],
    }).compile();
    await app.init();
    svc = app.get(TaggedWriter);
    cache = app.get(CacheService);
    errors = [];
    app.get(CacheEvents).on('error', (payload) => errors.push(payload));
  });

  afterEach(async () => {
    gate = undefined;
    vi.restoreAllMocks();
    await app.close();
  });

  it("@CachePut({ tags: ['user:{0}'] }) stamps user:<arg> and invalidateTags misses it", async () => {
    /* The template renders against the arguments; after invalidateTags the entry is a miss. */
    await svc.save('1', { name: 'a' });
    expect(Object.keys(stampAt('users:user:1') ?? {})).toEqual(['user:1']);
    expect(await cache.get('user:1', { namespace: 'users' })).toEqual({ id: '1', name: 'a' });
    await cache.invalidateTags(['user:1']);
    expect(await cache.get('user:1', { namespace: 'users' })).toBeUndefined();
  });

  it('takes the tag tokens before the method runs (T4-B)', async () => {
    /* Spec 3.3: with array tags the tokens are taken before the method, and the write uses
       exactly those. An invalidateTags while the method runs leaves the written entry stale:
       the next read is a miss. */
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    gate = {
      started,
      wait: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const pending = svc.save('1', { name: 'a' });
    await running;
    await cache.invalidateTags(['user:1']);
    release();
    expect(await pending).toEqual({ id: '1', name: 'a' });
    expect(fake.data.has('users:user:1')).toBe(true);
    expect(await cache.get('user:1', { namespace: 'users' })).toBeUndefined();
  });

  it('@CachePut({ tags: (r, ...args) => [...] }) receives the result then the args', async () => {
    /* The callback gets the method's result followed by every argument. */
    await svc.rename('2', { name: 'bo' });
    expect(putTagCalls).toEqual([[{ id: '2', name: 'bo' }, '2', { name: 'bo' }]]);
    expect(Object.keys(stampAt('n:2') ?? {})).toEqual(['name:bo']);
  });

  it.each([
    ['more than 32 tags', (s: TaggedWriter) => s.tooMany('x'), 'x', 'bad:x'],
    ['a template tag that renders empty', (s: TaggedWriter) => s.emptyTag(''), 'v', 'e:'],
  ] as const)('%s is one tag error and no write', async (_n, call, value, key) => {
    /* Spec 2.5: the method runs and its value is returned; the entry is not written. */
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await call(svc)).toBe(value);
    expect(svc.calls).toBe(1);
    expect(errors).toEqual([expect.objectContaining({ store: 'default', operation: 'tag' })]);
    expect(fake.data.has(key)).toBe(false);
  });

  it.each([
    ['an empty tag', ['']],
    ['a non-array', 5],
    ['a malformed template', ['{']],
  ])('rejects %s at class definition', (_n, tags) => {
    /* Spec 2.5: the error names Class.method. */
    expect(() => {
      class S {
        @CachePut({ tags: tags as readonly string[] }) a(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).toThrow(CacheConfigError);
    expect(() => {
      class S {
        @CachePut({ tags: tags as readonly string[] }) a(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).toThrow(/^S\.a: /);
  });
});
