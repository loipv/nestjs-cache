import 'reflect-metadata';
import { Logger, Module, type DynamicModule } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { CacheService } from '../../../src/core/cache.service.js';
import { CacheEvents, type CacheEventSink } from '../../../src/core/events.js';
import { CacheConfigError } from '../../../src/errors.js';
import { CacheModule } from '../../../src/module/cache.module.js';
import { CACHE_ENGINE } from '../../../src/module/tokens.js';
import { FakeStore } from '../helpers/fake-store.js';

describe('CacheModule', () => {
  const refs: TestingModule[] = [];

  async function boot(...imports: (DynamicModule | (new () => object))[]): Promise<TestingModule> {
    const ref = await Test.createTestingModule({ imports }).compile();
    refs.push(ref);
    await ref.init();
    return ref;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const ref of refs.splice(0)) await ref.close();
  });

  it('forRoot() with no arguments works on memory', async () => {
    const cache = (await boot(CacheModule.forRoot())).get(CacheService);
    await cache.set('a', { n: 1 });
    expect(await cache.get('a')).toEqual({ n: 1 });
  });

  it('exposes CacheEvents and the engine token', async () => {
    const ref = await boot(CacheModule.forRoot());
    expect(ref.get(CacheEvents)).toBeInstanceOf(CacheEvents);
    expect(ref.get(CACHE_ENGINE)).toBeInstanceOf(CacheEngine);
  });

  it('forRootAsync resolves options from injected providers', async () => {
    const store = new FakeStore();
    const SETTINGS = Symbol('settings');
    @Module({
      providers: [{ provide: SETTINGS, useValue: { prefix: 'app' } }],
      exports: [SETTINGS],
    })
    class SettingsModule {}
    const ref = await boot(
      CacheModule.forRootAsync({
        imports: [SettingsModule],
        inject: [SETTINGS],
        useFactory: (settings: { prefix: string }) => ({
          prefix: settings.prefix,
          stores: { default: store },
        }),
      }),
    );
    await ref.get(CacheService).set('k', 1, { namespace: 'ns' });
    expect([...store.data.keys()]).toEqual(['app:ns:k']);
  });

  it('forRootAsync accepts an async factory', async () => {
    const ref = await boot(CacheModule.forRootAsync({ useFactory: async () => ({}) }));
    const cache = ref.get(CacheService);
    await cache.set('a', 1);
    expect(await cache.get('a')).toBe(1);
  });

  it('isGlobal makes CacheService injectable without importing the module', async () => {
    @Module({
      providers: [{ provide: 'probe', useFactory: (c: CacheService) => c, inject: [CacheService] }],
    })
    class Feature {}
    const ref = await boot(CacheModule.forRoot({ isGlobal: true }), Feature);
    expect(ref.get('probe', { strict: false })).toBeInstanceOf(CacheService);
  });

  it('forRootAsync isGlobal is honoured', () => {
    expect(CacheModule.forRootAsync({ isGlobal: true, useFactory: () => ({}) }).global).toBe(true);
    expect(CacheModule.forRootAsync({ useFactory: () => ({}) }).global).toBe(false);
  });

  it('forRoot throws CacheConfigError synchronously on bad options', () => {
    expect(() => CacheModule.forRoot({ defaults: { ttl: 0 } })).toThrow(CacheConfigError);
  });

  it('forRootAsync fails startup on bad options', async () => {
    await expect(
      boot(CacheModule.forRootAsync({ useFactory: () => ({ defaults: { jitter: 2 } }) })),
    ).rejects.toThrow(CacheConfigError);
  });

  it('binds every store with a sink that names it', async () => {
    const a = new FakeStore();
    const b = new FakeStore();
    const ref = await boot(CacheModule.forRoot({ stores: { default: a, sessions: b } }));
    const seen: unknown[] = [];
    ref.get(CacheEvents).on('error', (p) => seen.push(p));
    const sink = b.bind.mock.calls[0]?.[0] as CacheEventSink;
    const error = new Error('x');
    sink.emit('error', { operation: 'get', error });
    expect(a.bind).toHaveBeenCalledOnce();
    expect(seen).toEqual([{ store: 'sessions', operation: 'get', error }]);
  });

  it('logs delete and clear errors at error level, others at warn', async () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const events = (await boot(CacheModule.forRoot())).get(CacheEvents);
    events.emit('error', { store: 'default', operation: 'get', error: new Error('down') });
    events.emit('error', { store: 'default', operation: 'delete', error: new Error('down') });
    events.emit('error', { store: 'default', operation: 'clear', error: 'plain' });
    expect(warnSpy).toHaveBeenCalledWith('Cache get failed on store "default": down');
    expect(errorSpy).toHaveBeenCalledWith('Cache delete failed on store "default": down');
    expect(errorSpy).toHaveBeenCalledWith('Cache clear failed on store "default": plain');
  });

  it('registers the error listener before binding stores', async () => {
    const store = new FakeStore();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    store.bind.mockImplementation((sink: CacheEventSink) => {
      sink.emit('error', { operation: 'subscribe', error: new Error('early') });
    });
    await boot(CacheModule.forRoot({ stores: { default: store } }));
    expect(warnSpy).toHaveBeenCalledWith('Cache subscribe failed on store "default": early');
  });

  it('closes every store once on shutdown, even if one close rejects', async () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const a = new FakeStore();
    const b = new FakeStore();
    a.close.mockRejectedValueOnce(new Error('x'));
    const ref = await boot(CacheModule.forRoot({ stores: { default: a, sessions: b } }));
    await expect(ref.close()).resolves.toBeUndefined();
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith('Failed to close cache store "default": x');
  });

  describe('error log throttling and lock warnings', () => {
    const err = (store: string, operation: 'get' | 'set') => ({
      store,
      operation,
      error: new Error('down'),
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('logs one line per store+operation per 30 s, then reports the suppressed count', async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const events = (await boot(CacheModule.forRoot())).get(CacheEvents);
      for (let i = 0; i < 5; i++) events.emit('error', err('default', 'get'));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(29_999);
      events.emit('error', err('default', 'get'));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      events.emit('error', err('default', 'get'));
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenLastCalledWith(
        'Cache get failed on store "default": down (+5 similar errors suppressed)',
      );
      vi.advanceTimersByTime(30_000);
      events.emit('error', err('default', 'get'));
      expect(warnSpy).toHaveBeenLastCalledWith('Cache get failed on store "default": down');
    });

    it('throttles store+operation pairs independently', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const events = (await boot(CacheModule.forRoot())).get(CacheEvents);
      events.emit('error', err('default', 'get'));
      events.emit('error', err('default', 'set'));
      events.emit('error', err('other', 'get'));
      events.emit('error', err('default', 'get'));
      expect(warnSpy).toHaveBeenCalledTimes(3);
    });

    it('still emits every error event', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const events = (await boot(CacheModule.forRoot())).get(CacheEvents);
      const seen = vi.fn();
      events.on('error', seen);
      for (let i = 0; i < 5; i++) events.emit('error', err('default', 'get'));
      expect(seen).toHaveBeenCalledTimes(5);
    });

    it('warns per store without a lock when defaults.lock.enabled', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await boot(CacheModule.forRoot({ defaults: { lock: { enabled: true } } }));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        'Cache store "default" has no distributed lock; defaults.lock.enabled falls back to in-process coalescing',
      );
    });

    it('logs the startup lock warning before any store is bound', async () => {
      const order: string[] = [];
      vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
        order.push(
          `warn ${/^Cache store "([^"]+)"/.exec(String(message))?.[1] ?? String(message)}`,
        );
      });
      const first = new FakeStore();
      const second = new FakeStore();
      first.bind.mockImplementation(() => order.push('bind default'));
      second.bind.mockImplementation(() => order.push('bind other'));
      await boot(
        CacheModule.forRoot({
          stores: { default: first, other: second },
          defaults: { lock: { enabled: true } },
        }),
      );
      expect(order).toEqual(['warn default', 'warn other', 'bind default', 'bind other']);
    });

    it('no lock warnings when nothing asks for a lock', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await boot(CacheModule.forRoot());
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
