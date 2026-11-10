export type KeySpec<A extends unknown[]> = string | ((...args: A) => string);
export type StrategyOptions =
  | { strategy?: 'fixed'; staleTtl?: never; maxTtl?: never }
  | { strategy: 'swr'; staleTtl: number; maxTtl?: never }
  | { strategy: 'sliding'; maxTtl?: number; staleTtl?: never };
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
export type CacheableOptions<K extends unknown[], C extends unknown[], R> = TargetOptions &
  StrategyOptions &
  WritePolicy<C, R> & { key?: KeySpec<K>; lock?: boolean };
export type CachePutOptions<K extends unknown[], C extends unknown[], R> = TargetOptions &
  StrategyOptions &
  WritePolicy<C, R> & { key?: KeySpec<K> };
export type CacheEvictOptions<A extends unknown[]> =
  | (TargetOptions & {
      key?: KeySpec<A> | readonly KeySpec<A>[];
      allEntries?: false;
      beforeInvocation?: boolean;
    })
  | {
      namespace: string;
      store?: string;
      allEntries: true;
      key?: never;
      beforeInvocation?: boolean;
    };
type MethodFn<A extends unknown[], R> = (...args: [...A, ...never[]]) => Promise<R>;
export type AsyncMethodDecorator<K extends unknown[], C extends unknown[], R> = <
  T extends MethodFn<K, R> & MethodFn<C, R>,
>(
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<T>,
) => void;
