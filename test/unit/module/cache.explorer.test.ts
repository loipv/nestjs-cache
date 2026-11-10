import 'reflect-metadata';
import { Controller, Injectable, Scope } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger, Module } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheEvict } from '../../../src/decorators/cache-evict.js';
import { CachePut } from '../../../src/decorators/cache-put.js';
import { Cacheable } from '../../../src/decorators/cacheable.js';
import { memoryStore } from '../../../src/stores/memory.store.js';
import { CacheConfigError } from '../../../src/errors.js';
import { FakeLock } from '../helpers/fake-lock.js';
import { FakeStore } from '../helpers/fake-store.js';
import { CacheModule } from '../../../src/module/cache.module.js';

describe('CacheExplorer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails startup for an unknown store on a provider', async () => {
    class Bad {
      @Cacheable({ store: 'nope' })
      find(): Promise<number> {
        return Promise.resolve(1);
      }
    }
    const ref = await Test.createTestingModule({
      imports: [CacheModule.forRoot()],
      providers: [Bad],
    }).compile();
    await expect(ref.init()).rejects.toThrow(
      'Unknown cache store "nope" in Bad.find (@Cacheable). Configured stores: default',
    );
  });

  it('names the decorator kind for @CacheEvict and @CachePut', async () => {
    class BadEvict {
      @CacheEvict({ store: 'nope' })
      drop(): Promise<void> {
        return Promise.resolve();
      }
    }
    class BadPut {
      @CachePut({ store: 'nope' })
      save(): Promise<number> {
        return Promise.resolve(1);
      }
    }
    const a = await Test.createTestingModule({
      imports: [CacheModule.forRoot()],
      providers: [BadEvict],
    }).compile();
    await expect(a.init()).rejects.toThrow('(@CacheEvict)');
    const b = await Test.createTestingModule({
      imports: [CacheModule.forRoot()],
      providers: [BadPut],
    }).compile();
    await expect(b.init()).rejects.toThrow('(@CachePut)');
  });

  it('checks controllers', async () => {
    @Controller()
    class BadController {
      @Cacheable({ store: 'nope' })
      find(): Promise<number> {
        return Promise.resolve(1);
      }
    }
    const ref = await Test.createTestingModule({
      imports: [CacheModule.forRoot()],
      controllers: [BadController],
    }).compile();
    await expect(ref.init()).rejects.toThrow('in BadController.find (@Cacheable)');
  });

  it('checks request-scoped providers that have no instance yet', async () => {
    @Injectable({ scope: Scope.REQUEST })
    class Scoped {
      @Cacheable({ store: 'nope' })
      find(): Promise<number> {
        return Promise.resolve(1);
      }
    }
    const ref = await Test.createTestingModule({
      imports: [CacheModule.forRoot()],
      providers: [Scoped],
    }).compile();
    await expect(ref.init()).rejects.toThrow('in Scoped.find (@Cacheable)');
  });

  it('starts normally when every store exists', async () => {
    class Good {
      @Cacheable({ store: 'sessions' })
      find(): Promise<number> {
        return Promise.resolve(1);
      }
    }
    const ref = await Test.createTestingModule({
      imports: [
        CacheModule.forRoot({ stores: { default: memoryStore(), sessions: memoryStore() } }),
      ],
      providers: [Good],
    }).compile();
    await expect(ref.init()).resolves.toBeDefined();
    await ref.close();
  });

  it('ignores providers without cache metadata and value providers', async () => {
    class Plain {}
    const ref = await Test.createTestingModule({
      imports: [CacheModule.forRoot()],
      providers: [Plain, { provide: 'x', useValue: 1 }, { provide: 'f', useFactory: () => 2 }],
    }).compile();
    await expect(ref.init()).resolves.toBeDefined();
    await ref.close();
  });

  it('warns for lock: true on a store without a lock and still starts', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    class Locky {
      @Cacheable({ lock: true })
      find(): Promise<number> {
        return Promise.resolve(1);
      }
    }
    const ref = await Test.createTestingModule({
      imports: [CacheModule.forRoot()],
      providers: [Locky],
    }).compile();
    await expect(ref.init()).resolves.toBeDefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'Locky.find sets lock: true but cache store "default" has no distributed lock; falling back to in-process coalescing',
    );
    await ref.close();
    warnSpy.mockRestore();
  });

  it('does not warn when lock is not requested', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    class Plain2 {
      @Cacheable({ lock: false })
      find(): Promise<number> {
        return Promise.resolve(1);
      }
    }
    const ref = await Test.createTestingModule({
      imports: [CacheModule.forRoot()],
      providers: [Plain2],
    }).compile();
    await ref.init();
    expect(warnSpy).not.toHaveBeenCalled();
    await ref.close();
    warnSpy.mockRestore();
  });

  it('warns once for the same class provided in two modules', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    class Shared {
      @Cacheable({ lock: true })
      find(): Promise<number> {
        return Promise.resolve(1);
      }
    }
    @Module({ providers: [Shared] })
    class A {}
    @Module({ providers: [Shared] })
    class B {}
    const ref = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ isGlobal: true }), A, B],
    }).compile();
    await ref.init();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    await ref.close();
  });

  it('warns once per method and store, across two modules', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    class Multi {
      @Cacheable({ lock: true, store: 'a' })
      @Cacheable({ lock: true, store: 'b' })
      find(): Promise<number> {
        return Promise.resolve(1);
      }
      @Cacheable({ lock: true, store: 'a' })
      list(): Promise<number> {
        return Promise.resolve(2);
      }
    }
    @Module({ providers: [Multi] })
    class A {}
    @Module({ providers: [Multi] })
    class B {}
    const ref = await Test.createTestingModule({
      imports: [
        CacheModule.forRoot({
          isGlobal: true,
          stores: { default: memoryStore(), a: memoryStore(), b: memoryStore() },
        }),
        A,
        B,
      ],
    }).compile();
    await ref.init();
    const messages = warnSpy.mock.calls.map((call) => String(call[0]));
    expect([...messages].sort()).toEqual([
      'Multi.find sets lock: true but cache store "a" has no distributed lock; falling back to in-process coalescing',
      'Multi.find sets lock: true but cache store "b" has no distributed lock; falling back to in-process coalescing',
      'Multi.list sets lock: true but cache store "a" has no distributed lock; falling back to in-process coalescing',
    ]);
    await ref.close();
  });

  it('does not warn when the store has a lock', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const store = new FakeStore();
    Object.assign(store, { lock: new FakeLock() });
    class Locked {
      @Cacheable({ lock: true })
      find(): Promise<number> {
        return Promise.resolve(1);
      }
    }
    const ref = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ stores: { default: store } })],
      providers: [Locked],
    }).compile();
    await ref.init();
    expect(warnSpy).not.toHaveBeenCalled();
    await ref.close();
  });

  it('still throws for an unknown store and logs no warning', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    class Unknown {
      @Cacheable({ store: 'nope', lock: true })
      find(): Promise<number> {
        return Promise.resolve(1);
      }
    }
    const ref = await Test.createTestingModule({
      imports: [CacheModule.forRoot()],
      providers: [Unknown],
    }).compile();
    await expect(ref.init()).rejects.toThrow(CacheConfigError);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
