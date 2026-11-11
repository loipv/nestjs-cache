import { expectTypeOf } from 'vitest';
import {
  CacheEvict,
  CachePut,
  Cacheable,
  HttpCache,
  type CacheService,
  type HttpCacheRequest,
  type TagSpec,
} from '../../src/index.js';

interface User {
  id: string;
}
interface SearchQuery {
  term: string;
}

export class Accepted {
  @Cacheable({ namespace: 'users', key: 'user:{0}', ttl: 60_000 })
  a(id: string): Promise<User | null> {
    return Promise.resolve(null);
  }

  @Cacheable({
    namespace: 'users',
    key: (query: SearchQuery, page: number) => `search:${query.term}:${page}`,
    condition: (query: SearchQuery) => query.term.length > 2,
  })
  b(query: SearchQuery, page: number): Promise<User[]> {
    return Promise.resolve([]);
  }

  @Cacheable({
    condition: (query: SearchQuery, page: number) => page > 0,
    key: (query: SearchQuery) => query.term,
  })
  b2(query: SearchQuery, page: number): Promise<User[]> {
    return Promise.resolve([]);
  }

  @Cacheable()
  c(id: string): Promise<User> {
    return Promise.resolve({ id });
  }

  @Cacheable({ key: (id: string) => id })
  d(id: string, opts?: { deep: boolean }): Promise<User> {
    return Promise.resolve({ id });
  }

  @Cacheable({ unless: (r: User | null) => r === null })
  e(id: string): Promise<User | null> {
    return Promise.resolve(null);
  }

  @CachePut({ key: 'user:{0}', unless: (r: User) => r.id === '' })
  f(id: string, dto: { name: string }): Promise<User> {
    return Promise.resolve({ id });
  }

  @CacheEvict({ key: ['user:{0}', (id: string) => `profile:${id}`] })
  @CacheEvict({ namespace: 'users', allEntries: true })
  g(id: string): Promise<void> {
    return Promise.resolve();
  }
}

export class Rejected {
  // @ts-expect-error method đồng bộ
  @Cacheable({ key: 'x' })
  a(id: string): User {
    return { id };
  }
  // @ts-expect-error kiểu tham số của key callback không khớp
  @Cacheable({ key: (id: number) => String(id) })
  b(id: string): Promise<User> {
    return Promise.resolve({ id });
  }
  // @ts-expect-error kiểu tham số của unless không khớp
  @Cacheable({ unless: (r: string) => r === '' })
  c(id: string): Promise<User> {
    return Promise.resolve({ id });
  }
  // @ts-expect-error kiểu tham số của condition không khớp
  @Cacheable({ condition: (id: number) => id > 0 })
  d(id: string): Promise<User> {
    return Promise.resolve({ id });
  }
  // @ts-expect-error condition sai kiểu bên cạnh key đúng
  @Cacheable({ key: (id: string) => id, condition: (id: number) => id > 0 })
  h(id: string): Promise<User> {
    return Promise.resolve({ id });
  }
  // @ts-expect-error CachePut trên method đồng bộ
  @CachePut()
  e(id: string): User {
    return { id };
  }
  // @ts-expect-error allEntries cần namespace
  @CacheEvict({ allEntries: true })
  f(): Promise<void> {
    return Promise.resolve();
  }
  // @ts-expect-error allEntries không đi cùng key
  @CacheEvict({ namespace: 'users', allEntries: true, key: 'x' })
  g(): Promise<void> {
    return Promise.resolve();
  }
}

export class Accepted02 {
  @Cacheable({ strategy: 'swr', staleTtl: 300_000 })
  a(): Promise<number> {
    return Promise.resolve(1);
  }
  @Cacheable({ strategy: 'sliding', maxTtl: 3_600_000, ttl: 60_000 })
  b(): Promise<number> {
    return Promise.resolve(1);
  }
  @Cacheable({ lock: true, strategy: 'fixed' })
  c(): Promise<number> {
    return Promise.resolve(1);
  }
  @CachePut({ key: 'user:{0}', strategy: 'swr', staleTtl: 1_000 })
  d(id: string): Promise<User> {
    return Promise.resolve({ id });
  }
  @Cacheable({
    key: (q: SearchQuery, page: number) => `${q.term}:${page}`,
    condition: (q: SearchQuery) => q.term.length > 2,
    strategy: 'swr',
    staleTtl: 10_000,
    lock: true,
  })
  e(q: SearchQuery, page: number): Promise<User[]> {
    return Promise.resolve([]);
  }
}

export class Rejected02 {
  // @ts-expect-error swr cần staleTtl
  @Cacheable({ strategy: 'swr' })
  a(): Promise<number> {
    return Promise.resolve(1);
  }
  // @ts-expect-error sliding không nhận staleTtl
  @Cacheable({ strategy: 'sliding', staleTtl: 1 })
  b(): Promise<number> {
    return Promise.resolve(1);
  }
  // @ts-expect-error fixed không nhận staleTtl
  @Cacheable({ staleTtl: 1 })
  c(): Promise<number> {
    return Promise.resolve(1);
  }
  // @ts-expect-error CachePut không có lock
  @CachePut({ lock: true })
  d(): Promise<number> {
    return Promise.resolve(1);
  }
  // @ts-expect-error CacheEvict không có strategy
  @CacheEvict({ strategy: 'swr', staleTtl: 1 })
  e(): Promise<void> {
    return Promise.resolve();
  }
}

// TagSpec callback parameter types are checked against the decorated method (spec 2.1).
export class AcceptedTags {
  @Cacheable({ key: 'user:{0}', tags: ['user:{0}', 'users'] })
  a(id: string): Promise<User> {
    return Promise.resolve({ id });
  }

  @Cacheable({ tags: (r: User, id: string) => [`user:${r.id}`, id] })
  b(id: string): Promise<User> {
    return Promise.resolve({ id });
  }

  @Cacheable({
    key: (id: string) => id,
    condition: (id: string, page: number) => page > 0,
    unless: (r: User | null) => r === null,
    tags: (r: User | null, id: string, page: number) => [id, String(page)],
  })
  c(id: string, page: number): Promise<User | null> {
    return Promise.resolve(null);
  }

  @CachePut({
    key: 'user:{0}',
    tags: (r: User, id: string, dto: { name: string }) => [r.id, dto.name],
  })
  d(id: string, dto: { name: string }): Promise<User> {
    return Promise.resolve({ id });
  }

  @CacheEvict({ tags: ['user:{0}'] })
  @CacheEvict({ namespace: 'users', key: 'user:{0}', tags: (id: string) => [`user:${id}`] })
  @CacheEvict({ namespace: 'users', allEntries: true, tags: ['users'] })
  e(id: string): Promise<void> {
    return Promise.resolve();
  }

  @HttpCache({
    tags: (body, req) => {
      expectTypeOf(body).toEqualTypeOf<unknown>();
      expectTypeOf(req).toEqualTypeOf<HttpCacheRequest>();
      return [req.path];
    },
  })
  f(): void {}

  @HttpCache({ tags: ['items'] })
  g(): void {}
}

export class RejectedTags {
  // @ts-expect-error kiểu result của tags callback không khớp
  @Cacheable({ tags: (r: string) => [r] })
  a(id: string): Promise<User> {
    return Promise.resolve({ id });
  }
  // @ts-expect-error kiểu tham số của tags callback không khớp
  @Cacheable({ tags: (r: User, id: number) => [String(id)] })
  b(id: string): Promise<User> {
    return Promise.resolve({ id });
  }
  // @ts-expect-error CachePut: kiểu tham số của tags callback không khớp
  @CachePut({ tags: (r: User, id: number) => [String(id)] })
  c(id: string): Promise<User> {
    return Promise.resolve({ id });
  }
  // @ts-expect-error CacheEvict: kiểu tham số của tags callback không khớp
  @CacheEvict({ tags: (id: number) => [String(id)] })
  d(id: string): Promise<void> {
    return Promise.resolve();
  }
  // @ts-expect-error tag phải là chuỗi
  @Cacheable({ tags: [1] })
  e(): Promise<number> {
    return Promise.resolve(1);
  }
  // @ts-expect-error tags callback phải trả mảng chuỗi
  @Cacheable({ tags: (r: number) => r })
  f(): Promise<number> {
    return Promise.resolve(1);
  }
}

// TagSpec infers the callback's parameters from its type arguments.
export const spec: TagSpec<[id: string, page: number], User> = (result, id, page) => {
  expectTypeOf(result).toEqualTypeOf<User>();
  expectTypeOf(id).toEqualTypeOf<string>();
  expectTypeOf(page).toEqualTypeOf<number>();
  return [result.id];
};

// CacheService tag callbacks infer their parameter types from the value (deferred from Task 4).
export async function serviceTags(service: CacheService, user: User): Promise<void> {
  await service.set('k', user, {
    tags: (u) => {
      expectTypeOf(u).toEqualTypeOf<User>();
      return [u.id];
    },
  });
  await service.getOrSet('k', () => Promise.resolve(user), {
    tags: (u) => {
      expectTypeOf(u).toEqualTypeOf<User>();
      return [u.id];
    },
  });
  await service.setMany([['a', user]], {
    tags: (value, key) => {
      expectTypeOf(value).toEqualTypeOf<User>();
      expectTypeOf(key).toEqualTypeOf<string>();
      return [value.id, key];
    },
  });
  await service.getOrSetMany(['a'], () => Promise.resolve(new Map([['a', user]])), {
    tags: (value, key) => {
      expectTypeOf(value).toEqualTypeOf<User>();
      expectTypeOf(key).toEqualTypeOf<string>();
      return [value.id, key];
    },
  });
}
