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
 * `softTimeout` (swr only): on a stale hit, wait up to this many ms for the background refresh
 * and return its value if it lands in time, else the stale one.
 */
export type StrategyOptions =
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
export type CacheableOptions<
  K extends unknown[],
  C extends unknown[],
  R,
  G extends unknown[] = never[],
> = TargetOptions &
  StrategyOptions &
  WritePolicy<C, R> & { key?: KeySpec<K>; lock?: boolean; tags?: TagSpec<G, R> };
export type CachePutOptions<
  K extends unknown[],
  C extends unknown[],
  R,
  G extends unknown[] = never[],
> = TargetOptions &
  StrategyOptions &
  WritePolicy<C, R> & { key?: KeySpec<K>; tags?: TagSpec<G, R> };
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
