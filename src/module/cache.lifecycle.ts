import { Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { CacheEvents } from '../core/events.js';
import type { ResolvedCacheOptions } from './cache.options.js';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CacheLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('CacheModule');

  constructor(
    private readonly options: ResolvedCacheOptions,
    private readonly events: CacheEvents,
  ) {}

  onModuleInit(): void {
    this.events.on('error', ({ store, operation, error }) => {
      const text = `Cache ${operation} failed on store "${store}": ${messageOf(error)}`;
      if (operation === 'delete' || operation === 'clear') this.logger.error(text);
      else this.logger.warn(text);
    });
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
