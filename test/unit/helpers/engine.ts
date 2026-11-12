import { CacheEngine } from '../../../src/core/cache-engine.js';
import { CacheEvents, type CacheEventMap } from '../../../src/core/events.js';
import { resolveOptions, type CacheModuleOptions } from '../../../src/module/cache.options.js';
import { CacheTracing } from '../../../src/observability/cache-tracing.js';
import type { TracerLike } from '../../../src/observability/tracing.types.js';
import { FakeStore } from './fake-store.js';
import { FakeTracer } from './fake-tracer.js';

const EVENT_FLAGS: Record<keyof CacheEventMap, true> = {
  hit: true,
  miss: true,
  set: true,
  delete: true,
  clear: true,
  load: true,
  error: true,
  lock: true,
  breaker: true,
};
export const EVENT_NAMES = Object.keys(EVENT_FLAGS) as (keyof CacheEventMap)[];

/** Test-only engine options: a tracer to register, and whether it records keys. */
export interface TracingTestOptions {
  tracer?: TracerLike;
  recordKeys?: boolean;
}

/**
 * The `FakeTracer`s `makeEngine` installed under `CACHE_TEST_TRACING=1`, since the last
 * `takeInstalledTracers` call. The `unit-traced` setup file checks them after every test.
 */
const installed: FakeTracer[] = [];

/** Returns and forgets the tracers `makeEngine` installed (see `installed`). */
export function takeInstalledTracers(): FakeTracer[] {
  return installed.splice(0);
}

/**
 * An engine over a `FakeStore`. With `tracer`, the engine traces into it. With
 * `CACHE_TEST_TRACING=1` (the `unit-traced` project) and no `tracer`, a fresh `FakeTracer` that
 * records keys is installed, so the existing tests also run with tracing on.
 */
export function makeEngine(options: CacheModuleOptions & TracingTestOptions = {}): {
  engine: CacheEngine;
  events: CacheEvents;
  store: FakeStore;
  emitted: { event: keyof CacheEventMap; payload: unknown }[];
  tracing: CacheTracing;
} {
  const { tracer, recordKeys, ...cacheOptions } = options;
  const supplied = cacheOptions.stores?.default;
  const store = supplied instanceof FakeStore ? supplied : new FakeStore();
  const stores = { ...cacheOptions.stores, default: store };
  const events = new CacheEvents();
  const tracing = new CacheTracing();
  if (tracer !== undefined) {
    tracing.use({ tracer, recordKeys: recordKeys ?? false });
  } else if (process.env.CACHE_TEST_TRACING === '1') {
    const installedTracer = new FakeTracer();
    installed.push(installedTracer);
    tracing.use({ tracer: installedTracer, recordKeys: recordKeys ?? true });
  }
  const engine = new CacheEngine(resolveOptions({ ...cacheOptions, stores }), events, tracing);
  const emitted: { event: keyof CacheEventMap; payload: unknown }[] = [];
  for (const event of EVENT_NAMES) {
    events.on(event, (payload) => emitted.push({ event, payload }));
  }
  return { engine, events, store, emitted, tracing };
}
