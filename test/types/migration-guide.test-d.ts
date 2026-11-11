// Every "after" snippet of docs/migration-from-cache-manager.md, verbatim (imports merged).
import { Body, Controller, Delete, Get, Injectable, Module, Param, Post } from '@nestjs/common';
import {
  CacheEvict,
  CacheModule,
  CacheService,
  HttpCache,
  ioredisAdapter,
  memoryStore,
  redisStore,
  tieredStore,
} from '../../src/index.js';
import { Redis } from 'ioredis';

@Module({
  imports: [CacheModule.forRoot({ isGlobal: true, defaults: { ttl: 60_000 } })],
})
export class AppModule {}

export const asyncCacheModule = CacheModule.forRootAsync({
  isGlobal: true,
  useFactory: () => ({ defaults: { ttl: Number(process.env.CACHE_TTL) } }),
});

const redis = new Redis('redis://localhost:6379');

export const redisCacheModule = CacheModule.forRoot({
  isGlobal: true,
  prefix: 'myapp-v2',
  stores: {
    default: redisStore({ client: ioredisAdapter(redis) }),
  },
});

// Optional: an in-memory L1 in front of Redis, kept in sync over Pub/Sub.
export const tieredCacheModule = CacheModule.forRoot({
  isGlobal: true,
  prefix: 'myapp-v2',
  stores: {
    default: tieredStore({
      l1: memoryStore({ maxEntries: 5_000 }),
      l2: redisStore({ client: ioredisAdapter(redis) }),
      l1Ttl: 10_000,
    }),
  },
});

@Injectable()
export class ProfileService {
  constructor(private readonly cache: CacheService) {}

  async run(id: string): Promise<{ id: string } | undefined> {
    await this.cache.set(`profile:${id}`, { id }, { namespace: 'profiles', ttl: 30_000 });
    const hit = await this.cache.get<{ id: string }>(`profile:${id}`, { namespace: 'profiles' });
    await this.cache.delete(`profile:${id}`, { namespace: 'profiles' });
    await this.cache.clear('profiles');
    return hit;
  }
}

@Controller('articles')
export class ArticlesController {
  @Get()
  @HttpCache({ ttl: 30_000, key: 'articles' })
  list(): string[] {
    return [];
  }
}

@Controller('catalog')
export class CatalogController {
  // The default key is the URL with the query sorted: /catalog?b=2&a=1 is stored as /catalog?a=1&b=2.
  @Get()
  @HttpCache({ ttl: 60_000, namespace: 'catalog' })
  list(): string[] {
    return [];
  }

  // Authenticated requests skip the cache; anonymous ones share an entry.
  @Get('featured')
  @HttpCache({ key: (req) => (req.headers.authorization ? undefined : req.url) })
  featured(): string[] {
    return [];
  }

  // One entry per record, so a write can evict exactly that record.
  @Get(':id')
  @HttpCache({ namespace: 'catalog', key: (req) => `item:${req.params.id}` })
  item(@Param('id') id: string): { id: string } {
    return { id };
  }
}

export const usersCacheModule = CacheModule.forRoot({
  isGlobal: true,
  namespaces: { users: { versioned: true } },
});

@Controller('users')
export class UsersController {
  @Get()
  @HttpCache({ namespace: 'users', ttl: 60_000 })
  list(): string[] {
    return [];
  }

  @Get(':id')
  @HttpCache({ namespace: 'users', key: (req) => `user:${req.params.id}` })
  find(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @CacheEvict({ namespace: 'users', allEntries: true })
  create(@Body() body: { name: string }): Promise<{ name: string }> {
    return Promise.resolve(body);
  }

  @Delete(':id')
  @CacheEvict({ namespace: 'users', key: 'user:{0}' })
  remove(@Param('id') id: string): Promise<void> {
    return Promise.resolve(id).then(() => undefined);
  }
}
