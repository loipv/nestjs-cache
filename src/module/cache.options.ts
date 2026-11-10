import type { FactoryProvider, ModuleMetadata } from '@nestjs/common';
import { CacheConfigError } from '../errors.js';
import { jsonSerializer, type Serializer } from '../serializers/json.serializer.js';
import type { CacheStore } from '../stores/cache-store.interface.js';
import { memoryStore } from '../stores/memory.store.js';

export interface CacheLockDefaults {
  enabled?: boolean;
  ttl?: number;
  waitTimeout?: number;
  retryDelay?: number;
}

export interface CacheDefaults {
  ttl?: number;
  jitter?: number;
  cacheNull?: boolean;
  nullTtl?: number;
  lock?: CacheLockDefaults;
}

export interface CacheModuleOptions {
  prefix?: string;
  stores?: { default: CacheStore; [name: string]: CacheStore };
  defaults?: CacheDefaults;
  serializer?: Serializer;
}

export interface CacheModuleAsyncOptions {
  isGlobal?: boolean;
  imports?: ModuleMetadata['imports'];
  inject?: FactoryProvider['inject'];
  useFactory: (...args: never[]) => CacheModuleOptions | Promise<CacheModuleOptions>;
}

export interface ResolvedDefaults {
  ttl: number;
  jitter: number;
  cacheNull: boolean;
  nullTtl: number;
  lock: { enabled: boolean; ttl: number; waitTimeout: number; retryDelay: number };
}

export interface ResolvedCacheOptions {
  prefix: string | undefined;
  stores: ReadonlyMap<string, CacheStore>;
  defaults: ResolvedDefaults;
  serializer: Serializer;
}

const DEFAULT_TTL = 60_000;
const DEFAULT_NULL_TTL = 30_000;

function invalid(path: string, value: unknown, rule: string): CacheConfigError {
  return new CacheConfigError(`Invalid cache option ${path}: ${String(value)} (${rule})`);
}

function positiveDuration(path: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalid(path, value, 'must be a finite number > 0');
  }
  return value;
}

function lockEnabled(value: boolean | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean')
    throw invalid('defaults.lock.enabled', value, 'must be a boolean');
  return value;
}

/** `undefined` means the defaults; anything else that is not a plain object is rejected. */
function lockDefaults(value: unknown): CacheLockDefaults {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('defaults.lock', value, 'must be an object');
  }
  return value;
}

function jitterOf(value: number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw invalid('defaults.jitter', value, 'must be a number >= 0 and < 1');
  }
  return value;
}

function isCacheStore(value: unknown): value is CacheStore {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ['get', 'set', 'delete', 'clear'].every((m) => typeof candidate[m] === 'function');
}

function resolveStores(stores: CacheModuleOptions['stores']): ReadonlyMap<string, CacheStore> {
  if (stores === undefined) return new Map([['default', memoryStore()]]);
  if (!('default' in stores)) {
    throw new CacheConfigError('Invalid cache option stores: missing required store "default"');
  }
  const map = new Map<string, CacheStore>();
  for (const [name, store] of Object.entries(stores)) {
    if (!isCacheStore(store)) {
      throw new CacheConfigError(`Cache store "${name}" does not implement CacheStore`);
    }
    map.set(name, store);
  }
  return map;
}

export function resolveOptions(options: CacheModuleOptions = {}): ResolvedCacheOptions {
  const defaults = options.defaults ?? {};
  const lock = lockDefaults(defaults.lock);
  return {
    prefix: options.prefix === undefined || options.prefix === '' ? undefined : options.prefix,
    stores: resolveStores(options.stores),
    defaults: {
      ttl: positiveDuration('defaults.ttl', defaults.ttl, DEFAULT_TTL),
      jitter: jitterOf(defaults.jitter),
      cacheNull: defaults.cacheNull ?? false,
      nullTtl: positiveDuration('defaults.nullTtl', defaults.nullTtl, DEFAULT_NULL_TTL),
      lock: {
        enabled: lockEnabled(lock.enabled),
        ttl: positiveDuration('defaults.lock.ttl', lock.ttl, 10_000),
        waitTimeout: positiveDuration('defaults.lock.waitTimeout', lock.waitTimeout, 3_000),
        retryDelay: positiveDuration('defaults.lock.retryDelay', lock.retryDelay, 50),
      },
    },
    serializer: options.serializer ?? jsonSerializer,
  };
}
