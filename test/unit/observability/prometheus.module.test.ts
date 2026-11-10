import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as ioClient from '@prometheus-io/client';
import * as promClient from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import { CacheModule } from '../../../src/module/cache.module.js';
import { CachePrometheusModule } from '../../../src/observability/prometheus.module.js';
import type { CachePrometheusOptions } from '../../../src/observability/prometheus.types.js';

describe('CachePrometheusModule', () => {
  it.each([
    [{ client: {} }, 'client'],
    [{ prefix: '9x' }, 'prefix'],
    [{ buckets: [] }, 'buckets'],
    [{ buckets: [1, 1] }, 'buckets'],
    [{ buckets: [1, Number.NaN] }, 'buckets'],
  ])('rejects invalid options %j', (bad, field) => {
    const options = { client: promClient, ...bad } as unknown as CachePrometheusOptions;
    let thrown: unknown;
    try {
      CachePrometheusModule.forRoot(options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CacheConfigError);
    expect((thrown as Error).message).toContain(`option ${field}`);
  });

  it('forRootAsync resolves options from injected providers', async () => {
    const registry = new ioClient.Registry();
    const TOKEN = Symbol('cfg');
    @Module({
      providers: [{ provide: TOKEN, useValue: { prefix: 'async_' } }],
      exports: [TOKEN],
    })
    class ConfigModule {}
    const ref = await Test.createTestingModule({
      imports: [
        CacheModule.forRoot({ isGlobal: true }),
        CachePrometheusModule.forRootAsync({
          imports: [ConfigModule],
          inject: [TOKEN],
          useFactory: (cfg: { prefix: string }) => ({
            client: ioClient,
            registry,
            prefix: cfg.prefix,
          }),
        }),
      ],
    }).compile();
    await ref.init();
    expect(registry.getSingleMetric('async_requests_total')).toBeDefined();
    await ref.close();
    expect(registry.getSingleMetric('async_requests_total')).toBeUndefined();
  });

  it('requires a global CacheModule', async () => {
    const build = async (): Promise<void> => {
      const ref = await Test.createTestingModule({
        imports: [CachePrometheusModule.forRoot({ client: promClient })],
      }).compile();
      await ref.init();
    };
    let thrown: unknown;
    try {
      await build();
    } catch (error) {
      thrown = error;
    }
    // Nest's own resolution error (its class is not public API, so match by name), not ours.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CacheConfigError);
    expect((thrown as Error).constructor.name).toBe('UnknownDependenciesException');
    expect((thrown as Error).message).toContain(
      "Nest can't resolve dependencies of the CacheMetricsCollector (?, Symbol(@loipv/nestjs-cache:prometheus-options), Symbol(@loipv/nestjs-cache:logger)). Please make sure that the argument CacheEvents at index [0] is available in the CachePrometheusModule module.",
    );
  });

  it('forRootAsync rejects invalid factory options with the same message as forRoot', async () => {
    let sync: unknown;
    try {
      CachePrometheusModule.forRoot({ client: promClient, prefix: '9x' });
    } catch (error) {
      sync = error;
    }
    const build = async (): Promise<void> => {
      const ref = await Test.createTestingModule({
        imports: [
          CacheModule.forRoot({ isGlobal: true }),
          CachePrometheusModule.forRootAsync({
            useFactory: () => ({
              client: promClient,
              registry: new promClient.Registry(),
              prefix: '9x',
            }),
          }),
        ],
      }).compile();
      await ref.init();
    };
    const rejection = build();
    await expect(rejection).rejects.toBeInstanceOf(CacheConfigError);
    await expect(rejection).rejects.toThrow((sync as Error).message);
    expect((sync as Error).message).toBe('Invalid cachePrometheus option prefix: 9x');
  });

  describe.each([
    ['prom-client', promClient],
    ['@prometheus-io/client', ioClient],
  ])('default registry with %s', (_name, client) => {
    afterEach(() => {
      client.register.clear();
    });

    it('registers the cache metrics in client.register when no registry is given', async () => {
      const ref = await Test.createTestingModule({
        imports: [
          CacheModule.forRoot({ isGlobal: true }),
          CachePrometheusModule.forRoot({ client }),
        ],
      }).compile();
      await ref.init();
      try {
        expect(client.register.getSingleMetric('cache_requests_total')).toBeDefined();
      } finally {
        await ref.close();
      }
      expect(client.register.getSingleMetric('cache_requests_total')).toBeUndefined();
    });
  });
});
