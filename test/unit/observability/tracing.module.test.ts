import 'reflect-metadata';
import { Injectable, Module, type ModuleMetadata } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cacheable } from '../../../src/decorators/cacheable.js';
import { CacheConfigError } from '../../../src/errors.js';
import { CacheLogger } from '../../../src/module/cache.logger.js';
import { CacheModule } from '../../../src/module/cache.module.js';
import { CACHE_LOGGER } from '../../../src/module/tokens.js';
import { CacheTracing } from '../../../src/observability/cache-tracing.js';
import { CacheTracingModule } from '../../../src/observability/tracing.module.js';
import type { CacheTracingOptions } from '../../../src/observability/tracing.types.js';
import { FakeTracer } from '../helpers/fake-tracer.js';

@Injectable()
class Users {
  loads = 0;

  @Cacheable({ namespace: 'users', key: 'u:{0}' })
  find(id: string): Promise<string> {
    this.loads += 1;
    return Promise.resolve(`user ${id}`);
  }
}

describe('CacheTracingModule', () => {
  let ref: TestingModule | undefined;
  const tracers: FakeTracer[] = [];

  function tracer(): FakeTracer {
    const created = new FakeTracer();
    tracers.push(created);
    return created;
  }

  async function start(imports: ModuleMetadata['imports']): Promise<Users> {
    ref = await Test.createTestingModule({ imports, providers: [Users] }).compile();
    await ref.init();
    return ref.get(Users);
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await ref?.close();
    ref = undefined;
    for (const t of tracers.splice(0)) t.assertAllEnded();
  });

  it('forRoot registers the tracer: a @Cacheable call is traced', async () => {
    const fake = tracer();
    const users = await start([
      CacheModule.forRoot({ isGlobal: true }),
      CacheTracingModule.forRoot({ tracer: fake }),
    ]);
    expect(await users.find('1')).toBe('user 1');
    const span = fake.span('cache.getOrSet');
    expect(span.attributes).toEqual({
      'cache.store': 'default',
      'cache.namespace': 'users',
      'cache.result': 'miss',
    });
    expect(fake.span('cache.load').parent).toBe(span);
  });

  it('forRootAsync resolves the options from injected providers', async () => {
    const fake = tracer();
    const TOKEN = Symbol('cfg');
    @Module({ providers: [{ provide: TOKEN, useValue: { fake } }], exports: [TOKEN] })
    class ConfigModule {}
    const users = await start([
      CacheModule.forRoot({ isGlobal: true }),
      CacheTracingModule.forRootAsync({
        imports: [ConfigModule],
        inject: [TOKEN],
        useFactory: async (cfg: { fake: FakeTracer }) =>
          Promise.resolve({ tracer: cfg.fake, recordKeys: true }),
      }),
    ]);
    await users.find('7');
    expect(String(fake.span('cache.getOrSet').attributes['cache.key'])).toMatch(/users:u:7$/);
  });

  it('forRootAsync without inject or imports calls the factory with no argument', async () => {
    const fake = tracer();
    const factory = vi.fn(() => ({ tracer: fake }));
    const users = await start([
      CacheModule.forRoot({ isGlobal: true }),
      CacheTracingModule.forRootAsync({ useFactory: factory }),
    ]);
    await users.find('1');
    expect(factory).toHaveBeenCalledWith();
    expect(fake.spans('cache.getOrSet')).toHaveLength(1);
  });

  it('without the module, tracing stays disabled and caching works as before', async () => {
    const users = await start([CacheModule.forRoot({ isGlobal: true })]);
    expect(ref!.get(CacheTracing).enabled).toBe(false);
    expect(await users.find('1')).toBe('user 1');
    expect(await users.find('1')).toBe('user 1');
    expect(users.loads).toBe(1);
  });

  it('a failing tracer is logged through the CacheModule logger, as tracing', async () => {
    const fake = tracer();
    const users = await start([
      CacheModule.forRoot({ isGlobal: true }),
      CacheTracingModule.forRoot({ tracer: fake }),
    ]);
    const logger = ref!.get<CacheLogger>(CACHE_LOGGER);
    expect(logger).toBeInstanceOf(CacheLogger);
    const storeError = vi.spyOn(logger, 'storeError').mockImplementation(() => undefined);
    fake.failOn('setAttribute');
    expect(await users.find('1')).toBe('user 1');
    expect(storeError).toHaveBeenCalledWith('default', 'tracing', expect.any(Error));
  });

  it('importing forRoot twice fails init with CacheConfigError', async () => {
    const build = start([
      CacheModule.forRoot({ isGlobal: true }),
      CacheTracingModule.forRoot({ tracer: tracer() }),
      CacheTracingModule.forRoot({ tracer: tracer() }),
    ]);
    await expect(build).rejects.toBeInstanceOf(CacheConfigError);
    await expect(build).rejects.toThrow('CacheTracingModule is already registered');
  });

  it('forRoot and forRootAsync together also fail init with CacheConfigError', async () => {
    const build = start([
      CacheModule.forRoot({ isGlobal: true }),
      CacheTracingModule.forRoot({ tracer: tracer() }),
      CacheTracingModule.forRootAsync({ useFactory: () => ({ tracer: tracer() }) }),
    ]);
    await expect(build).rejects.toThrow(CacheConfigError);
  });

  it.each([
    [{}, 'tracer'],
    [{ tracer: { startActiveSpan: () => undefined } }, 'tracer'],
    [{ tracer: new FakeTracer(), recordKeys: 'yes' }, 'recordKeys'],
  ])('forRoot rejects invalid options %#', async (bad, field) => {
    const options = bad as unknown as CacheTracingOptions;
    const build = async (): Promise<unknown> =>
      start([CacheModule.forRoot({ isGlobal: true }), CacheTracingModule.forRoot(options)]);
    await expect(build()).rejects.toBeInstanceOf(CacheConfigError);
    await expect(build()).rejects.toThrow(`Invalid cacheTracing option ${field}`);
  });

  it.each([
    [{}, 'tracer'],
    [{ tracer: new FakeTracer(), recordKeys: 1 }, 'recordKeys'],
  ])('forRootAsync rejects invalid factory options at init %#', async (bad, field) => {
    const build = start([
      CacheModule.forRoot({ isGlobal: true }),
      CacheTracingModule.forRootAsync({
        useFactory: () => bad as unknown as CacheTracingOptions,
      }),
    ]);
    await expect(build).rejects.toBeInstanceOf(CacheConfigError);
    await expect(build).rejects.toThrow(`Invalid cacheTracing option ${field}`);
  });

  it('requires a global CacheModule', async () => {
    const build = start([CacheTracingModule.forRoot({ tracer: tracer() })]);
    // Nest's own resolution error, not ours: init rejects and names the missing provider.
    const thrown: unknown = await build.catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CacheConfigError);
    expect((thrown as Error).message).toContain('CacheTracing');
  });

  it('the module reaches the engine whatever the import order', async () => {
    const fake = tracer();
    const users = await start([
      CacheTracingModule.forRoot({ tracer: fake }),
      CacheModule.forRoot({ isGlobal: true }),
    ]);
    await users.find('1');
    expect(fake.spans('cache.getOrSet')).toHaveLength(1);
  });
});
