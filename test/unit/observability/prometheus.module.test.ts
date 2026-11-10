import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as ioClient from '@prometheus-io/client';
import * as promClient from 'prom-client';
import { describe, expect, it } from 'vitest';
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
    await expect(build()).rejects.toThrow();
  });
});
