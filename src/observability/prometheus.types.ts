/** Structural subset of a Prometheus registry; satisfied by prom-client and @prometheus-io/client. */
export interface RegistryLike {
  getSingleMetric(name: string): unknown;
  removeSingleMetric(name: string): void;
  /** Real clients call this on every entry of `registers` while constructing a metric. */
  registerMetric(metric: unknown): void;
}

export interface PrometheusMetricConfig {
  name: string;
  help: string;
  labelNames: readonly string[];
  registers: readonly RegistryLike[];
}

/*
 * The real clients declare `new <T extends string>(config: CounterConfiguration<T>)`, where
 * `registers` is a mutable array of their concrete `Registry` class. Construct signatures are
 * compared contravariantly, so no config type built on `RegistryLike` is accepted: the
 * parameter must be a subtype of what the real constructors take. `never` is that subtype, which
 * makes both client modules assignable without a cast. The price is that the constructors are not
 * directly callable through this type; use `construct()` below (one internal cast, not exported
 * from the package index).
 */
export type PrometheusConstructor<TInstance> = new (config: never) => TInstance;

/** Calls a client constructor with a typed config. Internal helper for the metrics collector. */
export function construct<TInstance>(
  ctor: PrometheusConstructor<TInstance>,
  config: PrometheusMetricConfig & { buckets?: readonly number[] },
): TInstance {
  return new (
    ctor as unknown as new (
      config: PrometheusMetricConfig & { buckets?: readonly number[] },
    ) => TInstance
  )(config);
}

/**
 * Structural subset of a Prometheus client module; pass `import * as client from '...'`.
 *
 * A minimal hand-written fake, for tests:
 *
 * ```ts
 * const registry: RegistryLike = {
 *   getSingleMetric: () => undefined,
 *   removeSingleMetric: () => undefined,
 *   registerMetric: () => undefined,
 * };
 * class FakeMetric {
 *   inc(): void {}
 *   observe(): void {}
 *   set(): void {}
 * }
 * const client: PrometheusClientLike = {
 *   Counter: FakeMetric,
 *   Histogram: FakeMetric,
 *   Gauge: FakeMetric,
 *   register: registry,
 * };
 * ```
 */
export interface PrometheusClientLike {
  Counter: PrometheusConstructor<{ inc(labels: Record<string, string>): void }>;
  Histogram: PrometheusConstructor<{
    observe(labels: Record<string, string>, value: number): void;
  }>;
  Gauge: PrometheusConstructor<{ set(labels: Record<string, string>, value: number): void }>;
  register: RegistryLike;
}

export interface CachePrometheusOptions {
  client: PrometheusClientLike;
  registry?: RegistryLike;
  prefix?: string;
  buckets?: readonly number[];
}
