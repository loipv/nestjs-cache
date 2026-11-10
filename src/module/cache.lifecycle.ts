import { Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { CacheEvents } from '../core/events.js';
import type { ResolvedCacheOptions } from './cache.options.js';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const WINDOW_MS = 30_000;

export class CacheLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('CacheModule');

  private readonly throttle = new Map<string, { windowStart: number; suppressed: number }>();

  constructor(
    private readonly options: ResolvedCacheOptions,
    private readonly events: CacheEvents,
  ) {}

  onModuleInit(): void {
    this.events.on('error', ({ store, operation, error }) => {
      const key = `${store}\u0000${operation}`;
      const now = Date.now();
      const entry = this.throttle.get(key);
      if (entry && now - entry.windowStart < WINDOW_MS) {
        entry.suppressed += 1;
        return;
      }
      const suffix =
        entry && entry.suppressed > 0
          ? ` (+${String(entry.suppressed)} similar errors suppressed)`
          : '';
      this.throttle.set(key, { windowStart: now, suppressed: 0 });
      const text = `Cache ${operation} failed on store "${store}": ${messageOf(error)}${suffix}`;
      if (operation === 'delete' || operation === 'clear') this.logger.error(text);
      else this.logger.warn(text);
    });
    if (this.options.defaults.lock.enabled) {
      for (const [name, store] of this.options.stores) {
        if (store.lock !== undefined) continue;
        this.logger.warn(
          `Cache store "${name}" has no distributed lock; defaults.lock.enabled falls back to in-process coalescing`,
        );
      }
    }
    for (const [name, store] of this.options.stores) {
      store.bind?.(this.events.sinkFor(name));
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
}
