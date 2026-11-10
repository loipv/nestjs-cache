import { addCacheMetadata, assertPositiveFinite } from './metadata.js';
import type { AsyncMethodDecorator, CacheableOptions } from './options.js';

export function Cacheable<
  K extends unknown[] = never[],
  C extends unknown[] = never[],
  R = unknown,
>(options?: CacheableOptions<K, C, R>): AsyncMethodDecorator<K, C, R> {
  return (target, propertyKey) => {
    assertPositiveFinite(target, propertyKey, 'ttl', options?.ttl);
    assertPositiveFinite(target, propertyKey, 'nullTtl', options?.nullTtl);
    addCacheMetadata(target, {
      kind: 'cacheable',
      method: propertyKey,
      store: options?.store ?? 'default',
    });
  };
}
