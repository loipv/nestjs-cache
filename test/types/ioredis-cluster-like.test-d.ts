import { Cluster } from 'ioredis';
import type { IoredisClusterLike } from '../../src/stores/ioredis.adapter.js';
import { redisStore } from '../../src/stores/redis.store.js';

// A real ioredis Cluster is an IoredisClusterLike without a cast, and redisStore accepts it.
const cluster = new Cluster([], { lazyConnect: true });
export const real: IoredisClusterLike = cluster;
export const store = redisStore({ client: cluster });

// A hand-written cluster with every member is an IoredisClusterLike.
const base = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve('OK' as const),
  eval: () => Promise.resolve(null),
  getex: () => Promise.resolve(null),
  unlink: () => Promise.resolve(0),
  scan: () => Promise.resolve(['0', []] as [string, string[]]),
  publish: () => Promise.resolve(0),
  subscribe: () => Promise.resolve(0),
  on: () => undefined,
  quit: () => Promise.resolve('OK'),
  isCluster: true,
  spublish: () => Promise.resolve(0),
  ssubscribe: () => Promise.resolve(0),
};
export const minimal: IoredisClusterLike = {
  ...base,
  nodes: () => [],
  duplicate: () => minimal,
};

// @ts-expect-error nodes is required: without it the adapter cannot scan every master
export const noNodes: IoredisClusterLike = { ...base, duplicate: () => minimal };
