import { createClient, createCluster, createSentinel } from 'redis';
import {
  nodeRedisAdapter,
  type NodeRedisClusterLike,
  type NodeRedisLike,
  type NodeRedisSentinelLike,
} from '../../src/stores/node-redis.adapter.js';
import { redisStore } from '../../src/stores/redis.store.js';

// A real node-redis client (v5 or v6) is a NodeRedisLike without a cast, and redisStore accepts its adapter.
const client = createClient();
export const real: NodeRedisLike = client;
export const store = redisStore({ client: nodeRedisAdapter(createClient()) });

// A hand-written client with every member is a NodeRedisLike; ping is optional.
const base = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve('OK'),
  getEx: () => Promise.resolve(null),
  eval: () => Promise.resolve(0),
  unlink: () => Promise.resolve(0),
  mGet: () => Promise.resolve([]),
  scan: () => Promise.resolve({ cursor: '0', keys: [] }),
  publish: () => Promise.resolve(0),
  connect: () => Promise.resolve(undefined),
  subscribe: () => Promise.resolve(),
  close: () => Promise.resolve(),
  destroy: () => undefined,
  on: () => undefined,
};
export const minimal: NodeRedisLike = { ...base, duplicate: () => minimal };

// @ts-expect-error get must resolve string | null, not a number
export const badGet: NodeRedisLike = { ...minimal, get: () => Promise.resolve(1) };

// A real node-redis cluster (v5 or v6) is a NodeRedisClusterLike without a cast, and redisStore accepts
// its adapter.
const cluster = createCluster({ rootNodes: [] });
export const realCluster: NodeRedisClusterLike = cluster;
export const clusterStore = redisStore({
  client: nodeRedisAdapter(createCluster({ rootNodes: [] })),
});

// A hand-written cluster with every member is a NodeRedisClusterLike; it needs no scan of its own.
const { scan: _scan, ...clusterBase } = base;
export const minimalCluster: NodeRedisClusterLike = {
  ...clusterBase,
  masters: [],
  nodeClient: () => Promise.resolve(minimal),
  sPublish: () => Promise.resolve(0),
  sSubscribe: () => Promise.resolve(),
  duplicate: () => minimalCluster,
};

// @ts-expect-error nodeClient is required: without it the adapter cannot scan every master
export const noNodeClient: NodeRedisClusterLike = { ...minimalCluster, nodeClient: undefined };

// A real node-redis Sentinel is a NodeRedisSentinelLike without a cast, and redisStore accepts its
// adapter.
const sentinel = createSentinel({ name: 'mymaster', sentinelRootNodes: [] });
export const realSentinel: NodeRedisSentinelLike = sentinel;
export const sentinelStore = redisStore({
  client: nodeRedisAdapter(createSentinel({ name: 'mymaster', sentinelRootNodes: [] })),
});
