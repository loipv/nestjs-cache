import { CacheConfigError } from '../errors.js';
import { isReservedNamespace } from '../core/key-builder.js';
import { CACHE_METADATA } from '../module/tokens.js';

export interface CacheMetadataEntry {
  kind: 'cacheable' | 'put' | 'evict' | 'http';
  method: string | symbol;
  store: string;
  lock: boolean | undefined;
}

type Holder = { [CACHE_METADATA]?: CacheMetadataEntry[] };

export function getCacheMetadata(ctor: object): readonly CacheMetadataEntry[] {
  return (ctor as Holder)[CACHE_METADATA] ?? [];
}

/** The `method` of the entry a class-level `@HttpCache` registers. Internal; messages name the class alone. */
export const CLASS_LEVEL = '*';

/** `Class.method`, or `Class` for a class-level entry. */
export function memberName(className: string, method: string | symbol): string {
  return method === CLASS_LEVEL ? className : `${className}.${String(method)}`;
}

export function describeMethod(target: object, method: string | symbol): string {
  return memberName((target as { constructor: { name: string } }).constructor.name, method);
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

export function assertBoolean(
  target: object,
  method: string | symbol,
  field: string,
  value: boolean | undefined,
): void {
  if (value === undefined || typeof value === 'boolean') return;
  throw new CacheConfigError(
    `${describeMethod(target, method)}: ${field} must be a boolean, got ${String(value)}`,
  );
}

export function assertNamespace(
  target: object,
  method: string | symbol,
  namespace: string | undefined,
): void {
  if (typeof namespace === 'string' && isReservedNamespace(namespace)) {
    throw new CacheConfigError(
      `${describeMethod(target, method)}: namespace "${namespace}" is reserved (names starting with "__")`,
    );
  }
}

/** Validates `staleTtl`/`maxTtl` and the `maxTtl >= ttl` relation at definition time. */
export function assertStrategyTtls(
  target: object,
  method: string | symbol,
  options: { ttl?: number; staleTtl?: number; maxTtl?: number } | undefined,
): void {
  assertPositiveFinite(target, method, 'staleTtl', options?.staleTtl);
  assertPositiveFinite(target, method, 'maxTtl', options?.maxTtl);
  const { ttl, maxTtl } = options ?? {};
  if (ttl !== undefined && maxTtl !== undefined && maxTtl < ttl) {
    throw new CacheConfigError(
      `${describeMethod(target, method)}: maxTtl (${String(maxTtl)}) must be >= ttl (${String(ttl)})`,
    );
  }
}

/** `tags` must be an array of non-empty strings or a function (spec 2.5). */
export function assertTags(target: object, method: string | symbol, tags: unknown): void {
  if (tags === undefined || typeof tags === 'function') return;
  if (Array.isArray(tags) && tags.every((tag) => typeof tag === 'string' && tag !== '')) return;
  throw new CacheConfigError(
    `${describeMethod(target, method)}: tags must be an array of non-empty strings or a function`,
  );
}
