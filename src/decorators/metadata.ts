import { CacheConfigError } from '../errors.js';
import { CACHE_METADATA } from '../module/tokens.js';

export interface CacheMetadataEntry {
  kind: 'cacheable' | 'put' | 'evict';
  method: string | symbol;
  store: string;
}

type Holder = { [CACHE_METADATA]?: CacheMetadataEntry[] };

export function getCacheMetadata(ctor: object): readonly CacheMetadataEntry[] {
  return (ctor as Holder)[CACHE_METADATA] ?? [];
}

export function describeMethod(target: object, method: string | symbol): string {
  const name = (target as { constructor: { name: string } }).constructor.name;
  return `${name}.${String(method)}`;
}

export function addCacheMetadata(target: object, entry: CacheMetadataEntry): void {
  const ctor = (target as { constructor: Holder }).constructor;
  const own = Object.prototype.hasOwnProperty.call(ctor, CACHE_METADATA);
  const current = own ? (ctor[CACHE_METADATA] ?? []) : [...getCacheMetadata(ctor)];
  const clash = current.find(
    (e) =>
      e.method === entry.method &&
      ((e.kind === 'cacheable' && entry.kind === 'put') ||
        (e.kind === 'put' && entry.kind === 'cacheable')),
  );
  if (clash) {
    throw new CacheConfigError(
      `${describeMethod(target, entry.method)}: @Cacheable and @CachePut cannot be combined on one method`,
    );
  }
  current.push(entry);
  ctor[CACHE_METADATA] = current;
}

export function assertPositiveFinite(
  target: object,
  method: string | symbol,
  field: string,
  value: number | undefined,
): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new CacheConfigError(
      `${describeMethod(target, method)}: ${field} must be a finite number > 0, got ${String(value)}`,
    );
  }
}
