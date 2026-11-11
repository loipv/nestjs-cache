/**
 * A cache key: a template rendered against the method arguments (`'user:{0}'`, `'{0.id}'`), or
 * a callback of the arguments. Without one, the key is built from all the arguments.
 */
export type KeySpec<A extends unknown[]> = string | ((...args: A) => string);
/**
 * The tags of a cached method (spec 2.1): templates with the key syntax (`'{0}'`, `'{0.id}'`),
 * rendered against the call's arguments, or a callback of the result then the arguments.
 */
export type TagSpec<A extends unknown[], R> =
  readonly string[] | ((result: R, ...args: A) => readonly string[]);
/** The tags `@CacheEvict` invalidates: templates over the arguments, or a callback of them. */
type EvictTagSpec<A extends unknown[]> = readonly string[] | ((...args: A) => readonly string[]);
/**
 * The expiry strategy of a call that does not load (`@CachePut`, `set`, `setMany`, `get`,
 * `getMany`): `'fixed'` (the default), `'swr'` with `staleTtl` (ms an entry is served stale
 * after `ttl`), or `'sliding'` with an optional `maxTtl` cap (ms). `softTimeout` is not
 * supported here; see `LoadStrategyOptions`.
 */
export type StrategyOptions =
  | { strategy?: 'fixed'; staleTtl?: never; maxTtl?: never; softTimeout?: never }
  | { strategy: 'swr'; staleTtl: number; maxTtl?: never; softTimeout?: never }
  | { strategy: 'sliding'; maxTtl?: number; staleTtl?: never; softTimeout?: never };
/**
 * The expiry strategy of a call that loads (`@Cacheable`, `@HttpCache`, `getOrSet`,
 * `getOrSetMany`): `StrategyOptions` plus `softTimeout` (swr only). On a stale hit, wait up to
 * `softTimeout` ms for the background refresh and return its value if it lands in time, else
 * the stale one.
 */
export type LoadStrategyOptions =
  | { strategy?: 'fixed'; staleTtl?: never; maxTtl?: never; softTimeout?: never }
  | { strategy: 'swr'; staleTtl: number; maxTtl?: never; softTimeout?: number }
  | { strategy: 'sliding'; maxTtl?: number; staleTtl?: never; softTimeout?: never };
interface TargetOptions {
  namespace?: string;
  store?: string;
}
interface WritePolicy<C extends unknown[], R> {
  ttl?: number;
  cacheNull?: boolean;
  nullTtl?: number;
  condition?: (...args: C) => boolean;
  unless?: (result: R) => boolean;
}
/**
 * Options of `@Cacheable`. `K`, `C` and `G` are the argument lists the `key`, `condition` and
 * `tags` callbacks declare; `R` is the method's resolved result.
 */
export type CacheableOptions<
  K extends unknown[],
  C extends unknown[],
  R,
  G extends unknown[] = never[],
> = TargetOptions &
  LoadStrategyOptions &
  WritePolicy<C, R> & { key?: KeySpec<K>; lock?: boolean; tags?: TagSpec<G, R> };
/** Options of `@CachePut`: those of `@Cacheable` without `lock` and `softTimeout`. */
export type CachePutOptions<
  K extends unknown[],
  C extends unknown[],
  R,
  G extends unknown[] = never[],
> = TargetOptions &
  StrategyOptions &
  WritePolicy<C, R> & { key?: KeySpec<K>; tags?: TagSpec<G, R> };
/**
 * Options of `@CacheEvict`: evict `key` (one spec or several) and invalidate `tags`, or clear
 * the whole `namespace` with `allEntries: true`. `beforeInvocation: true` evicts before the
 * method runs; by default eviction follows a successful call.
 */
export type CacheEvictOptions<A extends unknown[], G extends unknown[] = never[]> =
  | (TargetOptions & {
      key?: KeySpec<A> | readonly KeySpec<A>[];
      allEntries?: false;
      beforeInvocation?: boolean;
      tags?: EvictTagSpec<G>;
    })
  | {
      namespace: string;
      store?: string;
      allEntries: true;
      key?: never;
      beforeInvocation?: boolean;
      tags?: EvictTagSpec<G>;
    };
type MethodFn<A extends unknown[], R> = (...args: [...A, ...never[]]) => Promise<R>;
/** `G` is the argument list a tags callback declares; it is checked like `K` and `C`. */
export type AsyncMethodDecorator<
  K extends unknown[],
  C extends unknown[],
  R,
  G extends unknown[] = never[],
> = <T extends MethodFn<K, R> & MethodFn<C, R> & MethodFn<G, R>>(
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<T>,
) => void;
