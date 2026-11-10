import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { CacheEvents } from '../core/events.js';
import type { CacheLogger } from './cache.logger.js';
import type { ResolvedCacheOptions } from './cache.options.js';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `namespace:key`, or the bare key when there is no namespace. */
function fullKey(namespace: string | undefined, key: string): string {
  return namespace === undefined ? key : `${namespace}:${key}`;
}

export class CacheLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    private readonly options: ResolvedCacheOptions,
    private readonly events: CacheEvents,
    private readonly logger: CacheLogger,
  ) {}

  onModuleInit(): void {
    const { level } = this.logger;
    // Logging listeners go first, so errors emitted while binding stores are logged.
    if (level !== 'off') this.logErrorsAndBreakers();
    if (level === 'debug') this.logEventsAtDebug();
    if (this.options.defaults.lock.enabled) {
      for (const [name, store] of this.options.stores) {
        if (store.lock !== undefined) continue;
        this.logger.warn(
          `Cache store "${name}" has no distributed lock; defaults.lock.enabled falls back to in-process coalescing`,
        );
      }
    }
    for (const [name, store] of this.options.stores) {
      store.bind?.(this.events.sinkFor(name, level));
    }
  }

  async onApplicationShutdown(): Promise<void> {
    for (const [name, store] of this.options.stores) {
      try {
        await store.close?.();
      } catch (error) {
        this.logger.error(`Failed to close cache store "${name}": ${messageOf(error)}`);
      }
    }
  }

  private logErrorsAndBreakers(): void {
    const { events, logger } = this;
    events.on('error', ({ store, operation, error }) => {
      logger.storeError(store, operation, error);
    });
    events.on('breaker', ({ store, state }) => {
      if (state === 'open') logger.warn(`Circuit breaker for cache store "${store}" opened`);
      else if (state === 'closed') logger.log(`Circuit breaker for cache store "${store}" closed`);
    });
  }

  private logEventsAtDebug(): void {
    const { events, logger } = this;
    events.on('hit', ({ store, namespace, key, stale }) => {
      logger.debug(`Cache hit ${store} ${fullKey(namespace, key)}${stale ? ' stale' : ''}`);
    });
    events.on('miss', ({ store, namespace, key }) => {
      logger.debug(`Cache miss ${store} ${fullKey(namespace, key)}`);
    });
    events.on('set', ({ store, namespace, key, ttl }) => {
      logger.debug(`Cache set ${store} ${fullKey(namespace, key)} ttl=${String(ttl)}ms`);
    });
    events.on('delete', ({ store, namespace, keys }) => {
      const joined = keys.map((key) => fullKey(namespace, key)).join(',');
      logger.debug(`Cache delete ${store} ${joined}`);
    });
    events.on('clear', ({ store, namespace }) => {
      logger.debug(`Cache clear ${store} ${namespace}`);
    });
    events.on('load', ({ store, namespace, key, durationMs, success }) => {
      const outcome = success ? 'ok' : 'failed';
      logger.debug(
        `Cache load ${store} ${fullKey(namespace, key)} ${String(durationMs)}ms ${outcome}`,
      );
    });
    events.on('lock', ({ store, namespace, key, waitedMs, acquired }) => {
      const outcome = acquired ? 'acquired' : 'not acquired';
      logger.debug(
        `Cache lock ${store} ${fullKey(namespace, key)} waited ${String(waitedMs)}ms ${outcome}`,
      );
    });
  }
}
