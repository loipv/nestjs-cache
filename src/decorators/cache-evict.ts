import { CacheConfigError } from '../errors.js';
import { addCacheMetadata, describeMethod } from './metadata.js';
import type { AsyncMethodDecorator, CacheEvictOptions } from './options.js';

export function CacheEvict<K extends unknown[] = never[]>(
  options?: CacheEvictOptions<K>,
): AsyncMethodDecorator<K, never[], unknown> {
  return (target, propertyKey) => {
    if (options?.allEntries === true) {
      const where = describeMethod(target, propertyKey);
      const loose = options as { namespace?: string; key?: unknown };
      if (typeof loose.namespace !== 'string' || loose.namespace === '') {
        throw new CacheConfigError(`${where}: allEntries requires a namespace`);
      }
      if (loose.key !== undefined) {
        throw new CacheConfigError(`${where}: allEntries cannot be combined with key`);
      }
    }
    addCacheMetadata(target, {
      kind: 'evict',
      method: propertyKey,
      store: options?.store ?? 'default',
    });
  };
}
