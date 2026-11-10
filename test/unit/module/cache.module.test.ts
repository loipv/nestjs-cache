import 'reflect-metadata';
import { Injectable, Logger, Module, type DynamicModule } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { CacheService } from '../../../src/core/cache.service.js';
import { CacheEvents, type CacheEventSink } from '../../../src/core/events.js';
import { Cacheable } from '../../../src/decorators/cacheable.js';
import { CacheConfigError } from '../../../src/errors.js';
import { CacheLogger } from '../../../src/module/cache.logger.js';
import { CacheModule } from '../../../src/module/cache.module.js';
import { resolveOptions } from '../../../src/module/cache.options.js';
import { CACHE_ENGINE, CACHE_LOGGER } from '../../../src/module/tokens.js';
import { circuitBreaker } from '../../../src/resilience/circuit-breaker.store.js';
import { memoryStore } from '../../../src/stores/memory.store.js';
import { tieredStore } from '../../../src/stores/tiered.store.js';
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

  describe('log levels', () => {
    type Level = 'error' | 'warn' | 'log' | 'debug';

    /** Records the messages of the library's 'CacheModule' loggers only, not Nest's own. */
    function spyAll(): Record<Level, string[]> {
      const seen: Record<Level, string[]> = { error: [], warn: [], log: [], debug: [] };
      for (const level of ['error', 'warn', 'log', 'debug'] as const) {
        vi.spyOn(Logger.prototype, level).mockImplementation(function (
          this: Logger,
          message: unknown,
        ) {
          if ((this as unknown as { context?: string }).context === 'CacheModule') {
            seen[level].push(String(message));
          }
        });
      }
      return seen;
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('off writes no log and still emits every event (Review Focus 4)', async () => {
      /* forRoot({ logging:{level:'off'}, defaults:{lock:{enabled:true}} }) + explorer lock warning + TieredStore không bus + breaker open
         → warn/error/log/debug spy đều 0; một listener events.on('error') nhận đủ 3 lần */
      vi.useFakeTimers();
      const s = spyAll();
      @Injectable()
      class OffLocky {
        @Cacheable({ lock: true })
        find(): Promise<number> {
          return Promise.resolve(1);
        }
      }
      const closing = new FakeStore();
      closing.close.mockRejectedValueOnce(new Error('x'));
      const flaky = new FakeStore();
      flaky.failNext('get');
      const ref = await Test.createTestingModule({
        imports: [
          CacheModule.forRoot({
            logging: { level: 'off' },
            defaults: { lock: { enabled: true } },
            stores: {
              default: tieredStore({ l1: memoryStore(), l2: new FakeStore() }),
              closing,
              flaky: circuitBreaker(flaky, { failureThreshold: 1 }),
            },
          }),
        ],
        providers: [OffLocky],
      }).compile();
      refs.push(ref);
      await ref.init();
      const events = ref.get(CacheEvents);
      const errors = vi.fn<(p: { store: string }) => void>();
      const breakers = vi.fn();
      const hits = vi.fn();
      events.on('error', errors);
      events.on('breaker', breakers);
      events.on('hit', hits);
      events.on('miss', () => {
        throw new Error('listener');
      });
      for (let i = 0; i < 3; i++) {
        events.emit('error', { store: 'default', operation: 'get', error: new Error('down') });
      }
      events.emit('hit', { store: 'default', namespace: undefined, key: 'k', stale: false });
      events.emit('miss', { store: 'default', namespace: undefined, key: 'k' });
      // A real breaker-wrapped store that fails and opens.
      await ref.get(CacheService).get('k', { store: 'flaky' });
      await ref.get(CacheService).get('k');
      await ref.close();
      refs.splice(refs.indexOf(ref), 1);
      expect(errors.mock.calls.filter(([p]) => p.store === 'default')).toHaveLength(3);
      expect(breakers).toHaveBeenCalledWith({ store: 'flaky', state: 'open' });
      expect(hits).toHaveBeenCalledOnce();
      expect(closing.close).toHaveBeenCalledOnce();
      expect(s).toEqual({ error: [], warn: [], log: [], debug: [] });
    });

    it('error keeps the 0.2 throttling and adds breaker open/closed logs', async () => {
      /* emit breaker open → warn 'Circuit breaker for cache store "default" opened'; half-open → không; closed → log '… closed' */
      const s = spyAll();
      const events = (await boot(CacheModule.forRoot())).get(CacheEvents);
      events.emit('breaker', { store: 'default', state: 'open' });
      expect(s.warn).toEqual(['Circuit breaker for cache store "default" opened']);
      events.emit('breaker', { store: 'default', state: 'half-open' });
      expect(s.warn).toHaveLength(1);
      expect(s.log).toEqual([]);
      events.emit('breaker', { store: 'default', state: 'closed' });
      expect(s.log).toEqual(['Circuit breaker for cache store "default" closed']);
      // Breaker logs are not throttled.
      events.emit('breaker', { store: 'default', state: 'open' });
      events.emit('breaker', { store: 'default', state: 'closed' });
      expect(s.warn).toHaveLength(2);
      expect(s.log).toHaveLength(2);
      // Error throttling is unchanged and independent of breaker logs.
      events.emit('error', { store: 'default', operation: 'get', error: new Error('down') });
      events.emit('error', { store: 'default', operation: 'get', error: new Error('down') });
      expect(s.warn).toHaveLength(3);
      expect(s.warn[2]).toBe('Cache get failed on store "default": down');
      events.emit('hit', { store: 'default', namespace: undefined, key: 'k', stale: false });
      expect(s.debug).toEqual([]);
    });

    it('error reports a throwing listener with the 0.2 text and level', async () => {
      const s = spyAll();
      const events = (await boot(CacheModule.forRoot())).get(CacheEvents);
      events.on('miss', () => {
        throw new Error('listener');
      });
      events.emit('miss', { store: 'default', namespace: undefined, key: 'k' });
      expect(s.error).toEqual(['A cache event listener threw: listener']);
    });

    it('debug logs one line per event with exact formats (Review Focus 5)', async () => {
      /* hit không namespace → 'Cache hit default k'; hit stale ns → 'Cache hit default users:k stale';
         delete keys ['a','b'] ns 'n' → 'Cache delete default n:a,n:b'; load → 'Cache load default k 12ms ok'; lock → '… waited 50ms not acquired' */
      const s = spyAll();
      const events = (await boot(CacheModule.forRoot({ logging: { level: 'debug' } }))).get(
        CacheEvents,
      );
      const ns = undefined;
      events.emit('hit', { store: 'default', namespace: ns, key: 'k', stale: false });
      events.emit('hit', { store: 'default', namespace: 'users', key: 'k', stale: true });
      events.emit('miss', { store: 'default', namespace: ns, key: 'k' });
      events.emit('miss', { store: 'default', namespace: 'users', key: 'user:1' });
      events.emit('set', { store: 'default', namespace: ns, key: 'k', ttl: 1_000 });
      events.emit('set', { store: 'default', namespace: 'users', key: 'k', ttl: 60_000 });
      events.emit('delete', { store: 'default', namespace: 'n', keys: ['a', 'b'] });
      events.emit('delete', { store: 'default', namespace: ns, keys: ['a', 'b'] });
      events.emit('delete', { store: 'default', namespace: ns, keys: ['a'] });
      events.emit('clear', { store: 'default', namespace: 'users' });
      const load = { store: 'default', namespace: ns, key: 'k', durationMs: 12 };
      events.emit('load', { ...load, success: true });
      events.emit('load', { ...load, namespace: 'users', success: false });
      const lock = { store: 'default', namespace: ns, key: 'k', waitedMs: 50 };
      events.emit('lock', { ...lock, acquired: false });
      events.emit('lock', { ...lock, namespace: 'users', key: 'user:1', acquired: true });
      expect(s.debug).toEqual([
        'Cache hit default k',
        'Cache hit default users:k stale',
        'Cache miss default k',
        'Cache miss default users:user:1',
        'Cache set default k ttl=1000ms',
        'Cache set default users:k ttl=60000ms',
        'Cache delete default n:a,n:b',
        'Cache delete default a,b',
        'Cache delete default a',
        'Cache clear default users',
        'Cache load default k 12ms ok',
        'Cache load default users:k 12ms failed',
        'Cache lock default k waited 50ms not acquired',
        'Cache lock default users:user:1 waited 50ms acquired',
      ]);
      // error and breaker events are not debug lines; debug keeps the 'error' logs.
      events.emit('error', { store: 'default', operation: 'get', error: new Error('down') });
      events.emit('breaker', { store: 'default', state: 'open' });
      expect(s.debug).toHaveLength(14);
      expect(s.warn).toEqual([
        'Cache get failed on store "default": down',
        'Circuit breaker for cache store "default" opened',
      ]);
    });

    it('debug logs real engine traffic without undefined', async () => {
      const s = spyAll();
      const cache = (await boot(CacheModule.forRoot({ logging: { level: 'debug' } }))).get(
        CacheService,
      );
      await cache.get('k');
      await cache.set('k', 1, { ttl: 500 });
      await cache.delete(['k', 'j']);
      expect(s.debug).toEqual([
        'Cache miss default k',
        'Cache set default k ttl=500ms',
        'Cache delete default k,j',
      ]);
    });

    it('rejects an invalid logging level and a non-object logging', () => {
      /* thông báo đúng chữ */
      const badLevel = { logging: { level: 'warn' } } as unknown as Parameters<
        typeof CacheModule.forRoot
      >[0];
      expect(() => CacheModule.forRoot(badLevel)).toThrow(CacheConfigError);
      expect(() => CacheModule.forRoot(badLevel)).toThrow(
        "Invalid cache option logging.level: warn (must be 'off', 'error' or 'debug')",
      );
      const badLogging = { logging: 'debug' } as unknown as Parameters<
        typeof CacheModule.forRoot
      >[0];
      expect(() => CacheModule.forRoot(badLogging)).toThrow(
        'Invalid cache option logging: debug (must be an object)',
      );
    });

    it('provides and exports CACHE_LOGGER at the configured level', async () => {
      const ref = await boot(CacheModule.forRoot({ logging: { level: 'debug' } }));
      const logger = ref.get<CacheLogger>(CACHE_LOGGER);
      expect(logger).toBeInstanceOf(CacheLogger);
      expect(logger.level).toBe('debug');
      expect(CacheModule.forRoot().exports).toContain(CACHE_LOGGER);
      expect(CacheModule.forRootAsync({ useFactory: () => ({}) }).exports).toContain(CACHE_LOGGER);
      expect((await boot(CacheModule.forRoot())).get<CacheLogger>(CACHE_LOGGER).level).toBe(
        'error',
      );
    });

    it('binds every store with a sink carrying the log level', async () => {
      const a = new FakeStore();
      await boot(CacheModule.forRoot({ logging: { level: 'off' }, stores: { default: a } }));
      expect((a.bind.mock.calls[0]?.[0] as CacheEventSink).logLevel).toBe('off');
      const b = new FakeStore();
      await boot(CacheModule.forRoot({ stores: { default: b } }));
      expect((b.bind.mock.calls[0]?.[0] as CacheEventSink).logLevel).toBe('error');
    });

    it('CacheEngine.logLevel reflects options', async () => {
      /* … */
      const ref = await boot(CacheModule.forRoot({ logging: { level: 'off' } }));
      expect(ref.get<CacheEngine>(CACHE_ENGINE).logLevel).toBe('off');
      expect(new CacheEngine(resolveOptions(), new CacheEvents()).logLevel).toBe('error');
      const debug = resolveOptions({ logging: { level: 'debug' } });
      expect(new CacheEngine(debug, new CacheEvents()).logLevel).toBe('debug');
    });
  });
});
