import 'reflect-metadata';
import { Injectable, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheEvict, CacheModule, Cacheable } from '../../../src/index.js';
import { FakeStore } from '../helpers/fake-store.js';

class Standalone {
  calls = 0;

  @Cacheable({ key: 'standalone:{0}' })
  async find(id: string): Promise<{ id: string }> {
    this.calls++;
    return { id };
  }
}

class Stacked {
  calls = 0;

  @CacheEvict({ key: 'a' })
  @Cacheable({ key: 'b' })
  async find(): Promise<number> {
    this.calls++;
    return this.calls;
  }
}

@Injectable()
class Stateless {
  @Cacheable({ key: 'ping' })
  async ping(): Promise<string> {
    return 'pong';
  }

  @Cacheable({ key: 'sync' })
  syncThrow(): Promise<string> {
    throw new Error('sync');
  }
}

describe('wrapMethod', () => {
  let app: TestingModule;
  let fake: FakeStore;

  beforeEach(async () => {
    fake = new FakeStore();
    app = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ stores: { default: fake, sessions: new FakeStore() } })],
      providers: [Stateless],
    }).compile();
    await app.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('keeps metadata and name set by a decorator applied below (Review Focus 2)', () => {
    const Route =
      (path: string): MethodDecorator =>
      (_t, _k, d) => {
        Reflect.defineMetadata('route', path, d.value as object);
      };
    class C {
      @Cacheable() @Route('/x') find(): Promise<number> {
        return Promise.resolve(1);
      }
    }
    expect(Reflect.getMetadata('route', C.prototype.find)).toBe('/x');
    expect(C.prototype.find.name).toBe('find');
  });

  it('calls the method directly and warns once outside Nest DI', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const svc = new Standalone();
    expect(await svc.find('1')).toEqual({ id: '1' });
    await svc.find('1');
    expect(svc.calls).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'Standalone.find was called on an instance not created by Nest; caching is skipped.',
    );
    await new Standalone().find('2');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('runs a stacked method once outside DI and warns once', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const svc = new Stacked();
    expect(await svc.find()).toBe(1);
    expect(svc.calls).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('survives a detached call', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { ping } = app.get(Stateless);
    await expect(ping()).resolves.toBe('pong');
    expect(fake.calls).toEqual([]);
  });

  it('returns a rejected promise when the method throws synchronously', async () => {
    const pending = app.get(Stateless).syncThrow();
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow('sync');
  });
});
