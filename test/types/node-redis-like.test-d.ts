import { createClient } from 'redis';
import { nodeRedisAdapter, type NodeRedisLike } from '../../src/stores/node-redis.adapter.js';
import { redisStore } from '../../src/stores/redis.store.js';

// A real node-redis v5 client is a NodeRedisLike without a cast, and redisStore accepts its adapter.
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
