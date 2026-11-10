import { CacheEvict, CachePut, Cacheable } from '../../src/index.js';

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
