import * as promClient from 'prom-client';
import * as ioClient from '@prometheus-io/client';
import type {
  CachePrometheusOptions,
  PrometheusClientLike,
  RegistryLike,
} from '../../src/index.js';
export const a: PrometheusClientLike = promClient;
export const b: PrometheusClientLike = ioClient;
export const r1: RegistryLike = new promClient.Registry();
export const r2: RegistryLike = new ioClient.Registry();
export const o: CachePrometheusOptions = {
  client: ioClient,
  registry: r2,
  prefix: 'x_',
  buckets: [0.1, 1],
};
// @ts-expect-error client is required
export const bad: CachePrometheusOptions = {};
import { construct } from '../../src/observability/prometheus.types.js';
import type { PrometheusMetricConfig } from '../../src/index.js';
declare const cfg: PrometheusMetricConfig;
construct(a.Counter, cfg).inc({ x: '1' });
construct(a.Histogram, { ...cfg, buckets: [1] }).observe({ x: '1' }, 1);
construct(a.Gauge, cfg).set({ x: '1' }, 1);
