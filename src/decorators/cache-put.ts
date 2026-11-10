import { addCacheMetadata, assertPositiveFinite } from './metadata.js';
import type { AsyncMethodDecorator, CachePutOptions } from './options.js';

export function CachePut<K extends unknown[] = never[], C extends unknown[] = never[], R = unknown>(
  options?: CachePutOptions<K, C, R>,
): AsyncMethodDecorator<K, C, R> {
  return (target, propertyKey) => {
    assertPositiveFinite(target, propertyKey, 'ttl', options?.ttl);
    assertPositiveFinite(target, propertyKey, 'nullTtl', options?.nullTtl);
    addCacheMetadata(target, {
      kind: 'put',
      method: propertyKey,
      store: options?.store ?? 'default',
    });
  };
}
