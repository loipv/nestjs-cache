import { Controller, Get, Header, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { DynamicModule, Type } from '@nestjs/common';
import * as client from '@prometheus-io/client';
import { Redis } from 'ioredis';
import { CacheModule, CachePrometheusModule, redisStore } from '@loipv/nestjs-cache';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';

@Controller('metrics')
class MetricsController {
  @Get()
  @Header('Content-Type', client.register.contentType)
  metrics(): Promise<string> {
    return client.register.metrics();
  }
}

/**
 * Builds the root module from the environment:
 * - `REDIS_URL` set: the default store is Redis (through ioredis); unset: the in-memory store.
 * - `METRICS` set: Prometheus metrics are recorded and served on `GET /metrics`.
 */
export function createAppModule(env: NodeJS.ProcessEnv): Type<OnApplicationShutdown> {
  // The app creates and closes its Redis client; the library only duplicates it for Pub/Sub.
  const redis = env['REDIS_URL'] ? new Redis(env['REDIS_URL']) : undefined;
  const metrics = Boolean(env['METRICS']);

  const imports: DynamicModule[] = [
    CacheModule.forRoot({
      isGlobal: true,
      prefix: 'example',
      stores: redis ? { default: redisStore({ client: redis }) } : undefined,
    }),
  ];
  if (metrics) imports.push(CachePrometheusModule.forRoot({ client }));

  @Module({
    imports,
    controllers: metrics ? [ProductsController, MetricsController] : [ProductsController],
    providers: [ProductsService],
  })
  class AppModule implements OnApplicationShutdown {
    async onApplicationShutdown(): Promise<void> {
      await redis?.quit();
    }
  }
  return AppModule;
}
