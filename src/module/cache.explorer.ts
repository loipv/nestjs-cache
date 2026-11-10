import { Logger, type OnModuleInit } from '@nestjs/common';
import type { DiscoveryService } from '@nestjs/core';
import type { CacheEngine } from '../core/cache-engine.js';
import { getCacheMetadata, type CacheMetadataEntry } from '../decorators/metadata.js';
import { CacheConfigError } from '../errors.js';

/**
 * `<method>\u0000<store>` pairs already warned about, per class constructor, so repeated
 * modules and explorers warn once per method and store.
 */
const warnedLocks = new WeakMap<object, Set<string>>();

const KIND_LABELS: Record<CacheMetadataEntry['kind'], string> = {
  cacheable: '@Cacheable',
  put: '@CachePut',
  evict: '@CacheEvict',
};

/**
 * Validates, at app startup, that every store named by a cache decorator is configured.
 * Reads metadata from `wrapper.metatype`, so request-scoped providers without an instance are covered.
 *
 * Known limitation: with several `CacheModule.forRoot` calls in one app, each explorer checks
 * every provider and controller in the app against its own stores.
 */
export class CacheExplorer implements OnModuleInit {
  private readonly logger = new Logger('CacheModule');

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly engine: CacheEngine,
  ) {}

  onModuleInit(): void {
    const wrappers = [...this.discovery.getProviders(), ...this.discovery.getControllers()];
    for (const wrapper of wrappers) {
      const { metatype } = wrapper;
      if (typeof metatype !== 'function' || wrapper.isFactory) continue;
      for (const entry of getCacheMetadata(metatype)) {
        if (this.engine.hasStore(entry.store)) {
          // At 'off' nothing is logged, and nothing is marked as warned for another module.
          if (this.engine.logLevel === 'off') continue;
          const warned = warnedLocks.get(metatype) ?? new Set<string>();
          warnedLocks.set(metatype, warned);
          const warnKey = `${String(entry.method)}\u0000${entry.store}`;
          if (entry.lock === true && !this.engine.hasLock(entry.store) && !warned.has(warnKey)) {
            warned.add(warnKey);
            this.logger.warn(
              `${metatype.name}.${String(entry.method)} sets lock: true but cache store "${entry.store}" ` +
                'has no distributed lock; falling back to in-process coalescing',
            );
          }
          continue;
        }
        throw new CacheConfigError(
          `Unknown cache store "${entry.store}" in ${metatype.name}.${String(entry.method)} ` +
            `(${KIND_LABELS[entry.kind]}). Configured stores: ${this.engine.storeNames().join(', ')}`,
        );
      }
    }
  }
}
