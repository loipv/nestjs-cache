import { Injectable } from '@nestjs/common';
import { CacheEvict, Cacheable } from '@loipv/nestjs-cache';

export interface Product {
  id: string;
  name: string;
}

@Injectable()
export class ProductsService {
  private readonly products = new Map<string, Product>([
    ['1', { id: '1', name: 'Keyboard' }],
    ['2', { id: '2', name: 'Mouse' }],
  ]);

  /** How many times `find` really ran, that is, how many cache misses it had. */
  loads = 0;

  // Each entry carries the tag `product:<id>`, so one product can be evicted without a scan.
  @Cacheable({ namespace: 'products', key: 'product:{0}', ttl: 60_000, tags: ['product:{0}'] })
  find(id: string): Promise<Product | null> {
    this.loads += 1; // stands in for a database call
    return Promise.resolve(this.products.get(id) ?? null);
  }

  // Evicts the product entry and the cached catalog page (`@HttpCache` with the tag `catalog`).
  @CacheEvict({ tags: (id: string) => [`product:${id}`, 'catalog'] })
  rename(id: string, name: string): Promise<Product | null> {
    const product = this.products.get(id);
    if (product) product.name = name;
    return Promise.resolve(product ?? null);
  }

  list(): Product[] {
    return [...this.products.values()];
  }
}
