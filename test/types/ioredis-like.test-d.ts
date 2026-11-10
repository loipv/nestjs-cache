import { Redis } from 'ioredis';
import type { IoredisLike } from '../../src/stores/ioredis.adapter.js';

// A real ioredis client (with mget and ping) is an IoredisLike.
export const real: IoredisLike = new Redis({ lazyConnect: true });

// A hand-written client without ping and without mget is still an IoredisLike.
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
};
export const minimal: IoredisLike = { ...base, duplicate: () => minimal };

// @ts-expect-error mget must resolve (string | null)[]
export const badMget: IoredisLike = { ...minimal, mget: () => Promise.resolve(1) };
