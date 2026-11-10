import 'reflect-metadata';
import { Inject } from '@nestjs/common';
import { CACHE_ENGINE, CACHE_ENGINE_PROPERTY } from '../module/tokens.js';

const injected = new WeakSet<object>();

/**
 * Registers property injection of the cache engine on a class prototype.
 * Idempotent per prototype. Deliberately not `@Optional()`: a missing
 * CacheModule must fail at application start-up.
 */
export function injectEngine(target: object): void {
  if (injected.has(target)) return;
  injected.add(target);
  Inject(CACHE_ENGINE)(target, CACHE_ENGINE_PROPERTY);
}

/** Reads the engine injected into a provider instance, if any. */
export function engineOf(instance: unknown): unknown {
  if (typeof instance !== 'object' || instance === null) return undefined;
  return (instance as Record<symbol, unknown>)[CACHE_ENGINE_PROPERTY];
}
