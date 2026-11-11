import { Body, Controller, Get, Inject, NotFoundException, Param, Patch } from '@nestjs/common';
import { HttpCache } from '@loipv/nestjs-cache';
import { ProductsService, type Product } from './products.service.js';

@Controller()
export class ProductsController {
  /** How many times the catalog handler really ran. */
  catalogRuns = 0;

  constructor(@Inject(ProductsService) private readonly products: ProductsService) {}

  // Cached by the library: the handler runs only on a miss. Tagged, so a rename evicts it.
  @Get('catalog')
  @HttpCache({ namespace: 'catalog', ttl: 60_000, tags: ['catalog'] })
  catalog(): { products: Product[] } {
    this.catalogRuns += 1;
    return { products: this.products.list() };
  }

  @Get('products/:id')
  async find(@Param('id') id: string): Promise<Product> {
    const product = await this.products.find(id);
    if (!product) throw new NotFoundException();
    return product;
  }

  @Patch('products/:id')
  async rename(@Param('id') id: string, @Body() body: { name: string }): Promise<Product> {
    const product = await this.products.rename(id, body.name);
    if (!product) throw new NotFoundException();
    return product;
  }

  // Plain counters, so a client (the smoke test) can tell a cache hit from a miss.
  @Get('stats')
  stats(): { loads: number; catalogRuns: number } {
    return { loads: this.products.loads, catalogRuns: this.catalogRuns };
  }
}
