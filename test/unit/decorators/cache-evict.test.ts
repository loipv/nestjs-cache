import 'reflect-metadata';
import { Injectable, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheEvents, type CacheEventMap } from '../../../src/core/events.js';
import { CacheConfigError } from '../../../src/errors.js';
import { CacheEvict, CacheModule, CachePut, CacheService } from '../../../src/index.js';
import { EVENT_NAMES } from '../helpers/engine.js';
import { FakeStore } from '../helpers/fake-store.js';

/** A readonly key list, as `as const` produces. */
const READONLY_KEYS = ['user:{0}', (id: string) => `profile:${id}`] as const;

type Entry =
  | string
  | { op: 'delete'; keys: readonly string[] }
  | { op: 'clear'; prefix: string }
  | { op: 'tag'; key: string };

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

  @CacheEvict({ namespace: 'users', key: '{0}' })
  async removeRaw(id: string): Promise<string> {
    this.calls++;
    return `removed ${id}`;
  }

  @CacheEvict({ namespace: 'users', key: ['{0}', 'user:{1}'] })
  async removeRawMany(id: string, userId: string): Promise<string> {
    this.calls++;
    return `removed ${id}${userId}`;
  }

  @CacheEvict({ namespace: 'users', key: ['{0}', '{1}'] })
  async removeAllRaw(id: string, other: string): Promise<string> {
    this.calls++;
    return `removed ${id}${other}`;
  }

  @CacheEvict({
    namespace: 'users',
    key: [
      (id: string): string => {
        throw new Error(`bad key ${id}`);
      },
      'user:{0}',
    ],
  })
  async removeThrowingMany(id: string): Promise<string> {
    this.calls++;
    return `removed ${id}`;
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
    /* the failed delete is logged once through the module logger, not printed to the test output */
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    fake.failNext('delete');
    await expect(svc.remove('1')).resolves.toBe('removed 1');
    expect(errorSpy.mock.calls).toEqual([
      ['Cache delete failed on store "default": delete failed'],
    ]);
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

  it('skips the eviction but runs the method when its only key renders empty', async () => {
    /* deleting 'users' would hit the bare namespace key, never an entry of the namespace */
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await svc.removeRaw('')).toBe('removed ');
    expect(svc.calls).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(emitted).toEqual([
      { event: 'error', payload: expect.objectContaining({ operation: 'key' }) as unknown },
    ]);
  });

  it('drops only the key that renders empty and evicts the rest of the list', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await svc.removeRawMany('', '7')).toBe('removed 7');
    expect(svc.calls).toBe(1);
    expect(fake.calls).toEqual([{ op: 'delete', args: [['users:user:7']] }]);
    expect(emitted).toEqual([
      { event: 'error', payload: expect.objectContaining({ operation: 'key' }) as unknown },
      { event: 'delete', payload: { store: 'default', namespace: 'users', keys: ['user:7'] } },
    ]);
  });

  it('skips the whole eviction when every key in the list renders empty', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await svc.removeAllRaw('', '')).toBe('removed ');
    expect(svc.calls).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(emitted).toEqual([
      { event: 'error', payload: expect.objectContaining({ operation: 'key' }) as unknown },
    ]);
  });

  it('skips the whole eviction when a key builder in the list throws', async () => {
    /* no key list exists then, so nothing is deleted */
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await svc.removeThrowingMany('1')).toBe('removed 1');
    expect(svc.calls).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(emitted).toEqual([
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

/** Also logs each tag version write (`__tag__:<tag>`), in order with deletes and clears. */
class TagLoggingStore extends LoggingStore {
  override set(key: string, value: string, ttlMs: number): Promise<void> {
    if (key.startsWith('__tag__:')) log.push({ op: 'tag', key });
    return super.set(key, value, ttlMs);
  }
}

const THIRTY_THREE = Array.from({ length: 33 }, (_, i) => `t${String(i)}`);

@Injectable()
class TagRemover {
  @CacheEvict({ tags: ['user:{0}'] })
  async remove(id: string): Promise<string> {
    log.push('method');
    return `removed ${id}`;
  }

  @CacheEvict({ tags: ['user:{0}'] })
  async removeFailing(id: string): Promise<void> {
    log.push('method');
    throw new Error(`nope ${id}`);
  }

  @CacheEvict({ tags: ['user:{0}'], beforeInvocation: true })
  async removeEarly(id: string): Promise<void> {
    log.push('method');
    throw new Error(`late ${id}`);
  }

  @CacheEvict({ namespace: 'users', key: 'user:{0}', tags: ['user:{0}'] })
  async removeBoth(id: string): Promise<void> {
    log.push(`method ${id}`);
  }

  @CacheEvict({ namespace: 'users', key: 'user:{0}', tags: ['user:{0}'], beforeInvocation: true })
  async removeBothEarly(id: string): Promise<void> {
    log.push(`method ${id}`);
  }

  @CacheEvict({ namespace: 'users', allEntries: true, tags: ['users'] })
  async importAll(): Promise<void> {
    log.push('method');
  }

  @CacheEvict({ tags: (id: string, extra: string) => [`user:${id}`, '', extra, `user:${id}`] })
  async byCallback(id: string, extra: string): Promise<void> {
    log.push(`method ${id} ${extra}`);
  }

  @CacheEvict({ tags: ['{0}'] })
  async allEmpty(id: string): Promise<string> {
    log.push('method');
    return id;
  }

  @CacheEvict({
    tags: (): string[] => {
      throw new Error('bad tags');
    },
  })
  async throwing(): Promise<string> {
    log.push('method');
    return 'ok';
  }

  @CacheEvict({ tags: () => 'user:1' as unknown as string[] })
  async wrongType(): Promise<string> {
    log.push('method');
    return 'ok';
  }

  @CacheEvict({ tags: () => THIRTY_THREE })
  async tooMany(): Promise<string> {
    log.push('method');
    return 'ok';
  }

  @CacheEvict({ tags: () => [...THIRTY_THREE.slice(0, 32), 't0', 't1'] })
  async thirtyTwo(): Promise<string> {
    log.push('method');
    return 'ok';
  }

  @CacheEvict({ tags: ['f:{0}'] })
  async unrenderable(fn: () => void): Promise<string> {
    log.push('method');
    return typeof fn;
  }

  @CacheEvict({
    namespace: 'users',
    key: (id: string): string => {
      throw new Error(`bad key ${id}`);
    },
    tags: ['user:{0}'],
  })
  async badKeyWithTags(id: string): Promise<string> {
    log.push('method');
    return id;
  }

  @CacheEvict({
    namespace: 'users',
    key: 'user:{0}',
    tags: (): string[] => {
      throw new Error('bad tags');
    },
  })
  async keyWithBadTags(id: string): Promise<string> {
    log.push('method');
    return id;
  }
}

describe('@CacheEvict tags', () => {
  let app: TestingModule;
  let svc: TagRemover;
  let fake: TagLoggingStore;
  let cache: CacheService;
  let emitted: { event: keyof CacheEventMap; payload: unknown }[];

  beforeEach(async () => {
    log.length = 0;
    fake = new TagLoggingStore();
    app = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ stores: { default: fake } })],
      providers: [TagRemover],
    }).compile();
    await app.init();
    svc = app.get(TagRemover);
    cache = app.get(CacheService);
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

  const errorOps = () =>
    emitted
      .filter((e) => e.event === 'error')
      .map((e) => (e.payload as { operation: string }).operation);

  it("@CacheEvict({ tags: ['user:{0}'] }) invalidates after the method", async () => {
    /* Spec 2.2: the template renders against the arguments; the tag gets a new version after
       the method succeeds, so an entry stamped with it is a miss. Tags alone delete no key. */
    await cache.set('profile', { id: '1' }, { tags: ['user:1'] });
    log.length = 0;
    fake.calls.length = 0;
    expect(await svc.remove('1')).toBe('removed 1');
    expect(log).toEqual(['method', { op: 'tag', key: '__tag__:user:1' }]);
    expect(fake.calls.filter((c) => c.op === 'delete' || c.op === 'clear')).toEqual([]);
    expect(await cache.get('profile')).toBeUndefined();
  });

  it('invalidates nothing when the method throws', async () => {
    /* As with keys: a method that throws evicts nothing. */
    await expect(svc.removeFailing('1')).rejects.toThrow('nope 1');
    expect(log).toEqual(['method']);
  });

  it('with beforeInvocation invalidates before the method, even if it throws', async () => {
    /* beforeInvocation moves the invalidation ahead of the method. */
    await expect(svc.removeEarly('1')).rejects.toThrow('late 1');
    expect(log).toEqual([{ op: 'tag', key: '__tag__:user:1' }, 'method']);
  });

  it('combined with key deletes the key first, then invalidates the tags', async () => {
    /* Spec 2.2: key (or namespace) first, then tags; after the method, or before it with
       beforeInvocation. */
    await svc.removeBoth('1');
    expect(log).toEqual([
      'method 1',
      { op: 'delete', keys: ['users:user:1'] },
      { op: 'tag', key: '__tag__:user:1' },
    ]);
    log.length = 0;
    await svc.removeBothEarly('2');
    expect(log).toEqual([
      { op: 'delete', keys: ['users:user:2'] },
      { op: 'tag', key: '__tag__:user:2' },
      'method 2',
    ]);
  });

  it('combined with allEntries clears the namespace first, then invalidates the tags', async () => {
    /* Spec 2.2: the namespace is cleared before the tags get new versions. */
    await svc.importAll();
    expect(log).toEqual([
      'method',
      { op: 'clear', prefix: 'users:' },
      { op: 'tag', key: '__tag__:users' },
    ]);
  });

  it('a tags callback gets the arguments; empty tags are dropped, duplicates written once', async () => {
    /* Spec 2.5: an empty tag is dropped from an eviction list and the rest is invalidated. */
    await svc.byCallback('1', 'team:9');
    expect(log).toEqual([
      'method 1 team:9',
      { op: 'tag', key: '__tag__:user:1' },
      { op: 'tag', key: '__tag__:team:9' },
    ]);
    expect(errorOps()).toEqual([]);
  });

  it('a list that is empty once empty tags are dropped invalidates nothing', async () => {
    /* '{0}' with '' renders an empty tag: dropped, nothing left, no error. */
    expect(await svc.allEmpty('')).toBe('');
    expect(log).toEqual(['method']);
    expect(errorOps()).toEqual([]);
  });

  it('exactly 32 tags after de-duplication are invalidated', async () => {
    /* Duplicates do not count toward the limit. */
    await svc.thirtyTwo();
    expect(log.filter((e) => typeof e === 'object' && e.op === 'tag')).toHaveLength(32);
    expect(errorOps()).toEqual([]);
  });

  it.each([
    ['a callback that throws', (s: TagRemover) => s.throwing(), 'ok'],
    ['a callback that returns a string', (s: TagRemover) => s.wrongType(), 'ok'],
    ['33 tags', (s: TagRemover) => s.tooMany(), 'ok'],
    [
      'a template that cannot be rendered',
      (s: TagRemover) => s.unrenderable(() => undefined),
      'function',
    ],
  ] as const)(
    '@CacheEvict tag errors emit one tag error and never reject the call: %s',
    async (_n, call, value) => {
      /* Spec 2.5: an invalid list is one 'tag' error and invalidates nothing; the method runs
         and the call resolves with its value. */
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      expect(await call(svc)).toBe(value);
      expect(log).toEqual(['method']);
      expect(errorOps()).toEqual(['tag']);
    },
  );

  it('an invalid tag list still deletes the keys', async () => {
    /* Keys and tags are evicted independently: the key is deleted, the tags error is reported. */
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await svc.keyWithBadTags('1')).toBe('1');
    expect(log).toEqual(['method', { op: 'delete', keys: ['users:user:1'] }]);
    expect(errorOps()).toEqual(['tag']);
  });

  it('a throwing key callback is one key error and the tags are still invalidated', async () => {
    /* Keys and tags are evicted independently: the key cannot be built (one 'key' error, no
       delete), the tags are still invalidated and the method result is returned. */
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(await svc.badKeyWithTags('1')).toBe('1');
    expect(log).toEqual(['method', { op: 'tag', key: '__tag__:user:1' }]);
    expect(errorOps()).toEqual(['key']);
  });

  it('a failed token write is a version error and the call still resolves', async () => {
    /* Spec 3.4: @CacheEvict never rejects; the failure surfaces only as an event. */
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fake.failNext('set');
    await expect(svc.remove('1')).resolves.toBe('removed 1');
    expect(errorOps()).toEqual(['version']);
  });

  it.each([
    ['an empty tag', ['']],
    ['a non-array', 5],
    ['a malformed template', ['{']],
    ['an empty array', []],
  ])('rejects %s at class definition', (_n, tags) => {
    /* Spec 2.5: the error names Class.method. */
    expect(() => {
      class S {
        @CacheEvict({ tags: tags as readonly string[] }) a(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).toThrow(CacheConfigError);
    expect(() => {
      class S {
        @CacheEvict({ tags: tags as readonly string[] }) a(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).toThrow(/^S\.a: /);
  });
});

describe('@CacheEvict option types (JavaScript callers)', () => {
  it.each([
    ['allEntries', 'false', 'S.a: allEntries must be a boolean, got false'],
    ['beforeInvocation', 1, 'S.a: beforeInvocation must be a boolean, got 1'],
  ] as const)('rejects a non-boolean %s at class definition', (field, value, message) => {
    /* 0.9-T6 (Task 5 observation 2): allEntries: 'false' is truthy, so it cleared the whole
       namespace; a non-boolean allEntries or beforeInvocation is now a CacheConfigError when
       the decorator runs. */
    const options = { namespace: 'users', [field]: value } as never;
    const define = (): unknown => {
      class S {
        @CacheEvict(options) a(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    };
    expect(define).toThrow(CacheConfigError);
    expect(define).toThrow(message);
  });

  it('accepts undefined allEntries and beforeInvocation', () => {
    /* 0.9-T6: an undefined option is the same as an absent one. */
    const options = { allEntries: undefined, beforeInvocation: undefined } as never;
    expect(() => {
      class S {
        @CacheEvict(options) a(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      return S;
    }).not.toThrow();
  });
});
