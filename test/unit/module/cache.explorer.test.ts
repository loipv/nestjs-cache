import 'reflect-metadata';
import { Controller, Injectable, Scope } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { CacheEvict } from '../../../src/decorators/cache-evict.js';
import { CachePut } from '../../../src/decorators/cache-put.js';
import { Cacheable } from '../../../src/decorators/cacheable.js';
import { memoryStore } from '../../../src/stores/memory.store.js';
import { CacheModule } from '../../../src/module/cache.module.js';

describe('CacheExplorer', () => {
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
});
