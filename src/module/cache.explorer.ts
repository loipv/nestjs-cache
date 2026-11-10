import type { OnModuleInit } from '@nestjs/common';
import type { DiscoveryService } from '@nestjs/core';
import type { CacheEngine } from '../core/cache-engine.js';
import { getCacheMetadata, type CacheMetadataEntry } from '../decorators/metadata.js';
import { CacheConfigError } from '../errors.js';

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
        if (this.engine.hasStore(entry.store)) continue;
        throw new CacheConfigError(
          `Unknown cache store "${entry.store}" in ${metatype.name}.${String(entry.method)} ` +
            `(${KIND_LABELS[entry.kind]}). Configured stores: ${this.engine.storeNames().join(', ')}`,
        );
      }
    }
  }
}
