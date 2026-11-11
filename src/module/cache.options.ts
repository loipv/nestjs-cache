import type { FactoryProvider, ModuleMetadata } from '@nestjs/common';
import type { CacheLogLevel } from '../core/events.js';
import { isReservedNamespace } from '../core/key-builder.js';
import { CacheConfigError } from '../errors.js';
import { jsonSerializer, type Serializer } from '../serializers/json.serializer.js';
import type { CacheStore } from '../stores/cache-store.interface.js';
import { memoryStore } from '../stores/memory.store.js';

/** `defaults.lock`: the distributed lock taken on a miss, for stores that have one. */
export interface CacheLockDefaults {
  /**
   * Whether `getOrSet`, `@Cacheable` and `@HttpCache` lock by default; a call's `lock` overrides
   * it. Default `false`.
   */
  enabled?: boolean;
  /** How long a lock is held at most, in ms. Default 10 000. */
  ttl?: number;
  /**
   * How long a caller that did not get the lock waits for the holder's value, in ms; then it
   * loads without the lock. Default 3 000.
   */
  waitTimeout?: number;
  /** Delay between two re-reads of the entry while waiting, in ms. Default 50. */
  retryDelay?: number;
}

/** `defaults`: what a call or decorator that does not set an option uses. */
export interface CacheDefaults {
  /** Entry TTL in ms. Default 60 000. */
  ttl?: number;
  /** Random TTL spread: `ttl x (1 + r)`, `r` in `[-jitter, +jitter]`; in `[0, 1)`. Default 0. */
  jitter?: number;
  /** Whether `null` and `undefined` results are stored. Default `false`. */
  cacheNull?: boolean;
  /** TTL of a stored empty value, in ms. Default 30 000. */
  nullTtl?: number;
  lock?: CacheLockDefaults;
}

/** Options of `CacheModule.forRoot`, and the value `forRootAsync`'s `useFactory` resolves. */
export interface CacheModuleOptions {
  /** Prepended to every key as `<prefix>:`. Default none. */
  prefix?: string;
  /**
   * Named stores; `default` is required when `stores` is set. Default
   * `{ default: memoryStore() }`.
   */
  stores?: { default: CacheStore; [name: string]: CacheStore };
  defaults?: CacheDefaults;
  /** Turns entry envelopes into the strings stores hold. Default `jsonSerializer`. */
  serializer?: Serializer;
  /** `level` defaults to `'error'`. */
  logging?: { level?: CacheLogLevel };
  /**
   * Percent-encodes `%` and `:` in string and number arguments rendered into template keys.
   * Defaults to `false`; key callbacks are never escaped.
   */
  escapeKeyArgs?: boolean;
  /**
   * Namespaces with `versioned: true` get O(1) `clear` through a version token in their keys.
   * Matching is exact: a sub-namespace such as `users:admin` does not follow a versioned `users`.
   */
  namespaces?: { [namespace: string]: { versioned?: boolean } };
  /** `cacheTtl` (ms, default 1000) is how long a version token is cached in this process. */
  versioning?: { cacheTtl?: number };
}

/** Options of `CacheModule.forRootAsync`: `useFactory` resolves the `CacheModuleOptions`. */
export interface CacheModuleAsyncOptions {
  /** Registers the module globally. Default `false`. */
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
  logging: { level: CacheLogLevel };
  escapeKeyArgs: boolean;
  versionedNamespaces: ReadonlySet<string>;
  versionCacheTtl: number;
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

function cacheNullOf(value: boolean | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw invalid('defaults.cacheNull', value, 'must be a boolean');
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

const LOG_LEVELS: readonly unknown[] = ['off', 'error', 'debug'] satisfies CacheLogLevel[];

function isLogLevel(value: unknown): value is CacheLogLevel {
  return LOG_LEVELS.includes(value);
}

/** `undefined` means the default level; anything else that is not a plain object is rejected. */
function loggingOf(value: unknown): { level: CacheLogLevel } {
  if (value === undefined) return { level: 'error' };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('logging', value, 'must be an object');
  }
  const { level } = value as { level?: unknown };
  if (level === undefined) return { level: 'error' };
  if (!isLogLevel(level)) {
    throw invalid('logging.level', level, "must be 'off', 'error' or 'debug'");
  }
  return { level };
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

function escapeKeyArgsOf(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw invalid('escapeKeyArgs', value, 'must be a boolean');
  return value;
}

function versionedNamespacesOf(value: unknown): ReadonlySet<string> {
  const set = new Set<string>();
  if (value === undefined) return set;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('namespaces', value, 'must be an object');
  }
  for (const [ns, entry] of Object.entries(value)) {
    if (isReservedNamespace(ns)) {
      throw new CacheConfigError(
        `Invalid cache option namespaces: ${ns} (names starting with "__" are reserved)`,
      );
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalid(`namespaces.${ns}`, entry, 'must be an object');
    }
    const { versioned } = entry as { versioned?: unknown };
    if (versioned === undefined) continue;
    if (typeof versioned !== 'boolean') {
      throw invalid(`namespaces.${ns}.versioned`, versioned, 'must be a boolean');
    }
    if (versioned) set.add(ns);
  }
  return set;
}

function versionCacheTtlOf(value: unknown): number {
  if (value === undefined) return 1_000;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('versioning', value, 'must be an object');
  }
  const { cacheTtl } = value as { cacheTtl?: unknown };
  if (cacheTtl === undefined) return 1_000;
  if (
    typeof cacheTtl !== 'number' ||
    !Number.isFinite(cacheTtl) ||
    cacheTtl < 1 ||
    cacheTtl > 2_147_483_647
  ) {
    throw invalid(
      'versioning.cacheTtl',
      cacheTtl,
      'must be a finite number between 1 and 2147483647',
    );
  }
  return cacheTtl;
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
      cacheNull: cacheNullOf(defaults.cacheNull),
      nullTtl: positiveDuration('defaults.nullTtl', defaults.nullTtl, DEFAULT_NULL_TTL),
      lock: {
        enabled: lockEnabled(lock.enabled),
        ttl: positiveDuration('defaults.lock.ttl', lock.ttl, 10_000),
        waitTimeout: positiveDuration('defaults.lock.waitTimeout', lock.waitTimeout, 3_000),
        retryDelay: positiveDuration('defaults.lock.retryDelay', lock.retryDelay, 50),
      },
    },
    serializer: options.serializer ?? jsonSerializer,
    logging: loggingOf(options.logging),
    escapeKeyArgs: escapeKeyArgsOf(options.escapeKeyArgs),
    versionedNamespaces: versionedNamespacesOf(options.namespaces),
    versionCacheTtl: versionCacheTtlOf(options.versioning),
  };
}
