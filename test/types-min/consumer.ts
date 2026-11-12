/*
 * Type-checked by `npm run typecheck:min` with the minimum supported TypeScript (5.4) against the
 * built `dist/index.d.ts`, with `skipLibCheck: false`. Plain code, no test runner.
 */
import { Module, Injectable } from '@nestjs/common';
import {
  CacheModule,
  CacheService,
  CacheEvents,
  CacheHealthIndicator,
  HttpCacheInterceptor,
  Cacheable,
  CachePut,
  CacheEvict,
  HttpCache,
  CacheTracingModule,
  CachePrometheusModule,
  redisStore,
  tieredStore,
  circuitBreakerStore,
  memoryStore,
} from '@loipv/nestjs-cache';
import type {
  CacheHealthResult,
  RedisClientAdapter,
  TracerLike,
  PrometheusClientLike,
} from '@loipv/nestjs-cache';

declare const adapter: RedisClientAdapter;
declare const tracer: TracerLike;
declare const prom: PrometheusClientLike;

const l2 = circuitBreakerStore(redisStore({ client: adapter, channel: 'c' }));
const store = tieredStore({ l1: memoryStore(), l2, l1Ttl: 1000 });

@Injectable()
export class UserService {
  constructor(private readonly cache: CacheService) {}

  @Cacheable({
    namespace: 'users',
    key: (id: string) => id,
    ttl: 1000,
    tags: (r: { id: string }, id: string) => [id],
  })
  async find(id: string): Promise<{ id: string }> {
    return { id };
  }

  @CachePut({ namespace: 'users', key: (id: string) => id })
  async save(id: string): Promise<{ id: string }> {
    return { id };
  }

  @CacheEvict({ namespace: 'users', key: '{0}' })
  async remove(id: string): Promise<void> {
    void id;
  }

  @HttpCache({ ttl: 1000 })
  list(): string[] {
    return [];
  }

  async viaService(): Promise<number> {
    const n: number = await this.cache.getOrSet('k', async () => 42, { ttl: 5, namespace: 'n' });
    await this.cache.setMany<number>([['a', 1]], { namespace: 'n' });
    await this.cache.set('k', 1, { ttl: 1 });
    return n;
  }
}

@Injectable()
export class Probe {
  constructor(
    private readonly health: CacheHealthIndicator,
    private readonly events: CacheEvents,
    private readonly interceptor: HttpCacheInterceptor,
  ) {}

  async run(): Promise<CacheHealthResult> {
    const result = await this.health.check('cache', { store: 'default', timeout: 500 });
    const off: () => void = this.events.on('error', ({ operation, error }) => {
      void operation;
      void error;
    });
    off();
    void this.interceptor;
    return result.cache;
  }
}

@Module({
  imports: [
    CacheModule.forRootAsync({
      isGlobal: true,
      useFactory: () => ({ stores: { default: store } }),
    }),
    CacheTracingModule.forRoot({ tracer }),
    CachePrometheusModule.forRoot({ client: prom }),
  ],
  providers: [UserService, Probe],
})
export class AppModule {}
