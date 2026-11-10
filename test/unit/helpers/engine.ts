import { CacheEngine } from '../../../src/core/cache-engine.js';
import { CacheEvents, type CacheEventMap } from '../../../src/core/events.js';
import { resolveOptions, type CacheModuleOptions } from '../../../src/module/cache.options.js';
import { FakeStore } from './fake-store.js';

const EVENT_FLAGS: Record<keyof CacheEventMap, true> = {
  hit: true,
  miss: true,
  set: true,
  delete: true,
  clear: true,
  load: true,
  error: true,
};
export const EVENT_NAMES = Object.keys(EVENT_FLAGS) as (keyof CacheEventMap)[];

export function makeEngine(options: CacheModuleOptions = {}): {
  engine: CacheEngine;
  events: CacheEvents;
  store: FakeStore;
  emitted: { event: keyof CacheEventMap; payload: unknown }[];
} {
  const supplied = options.stores?.default;
  const store = supplied instanceof FakeStore ? supplied : new FakeStore();
  const stores = { ...options.stores, default: store };
  const events = new CacheEvents();
  const engine = new CacheEngine(resolveOptions({ ...options, stores }), events);
  const emitted: { event: keyof CacheEventMap; payload: unknown }[] = [];
  for (const event of EVENT_NAMES) {
    events.on(event, (payload) => emitted.push({ event, payload }));
  }
  return { engine, events, store, emitted };
}
