import { CacheConfigError } from '../errors.js';
import type { ResolvedCacheOptions } from '../module/cache.options.js';
import { CircuitOpenError } from '../resilience/circuit-breaker.store.js';

/** Terminus-compatible result for one indicator key. */
export type CacheHealthResult =
  { status: 'up'; ping?: 'unsupported' } | { status: 'down'; message: string };

const DEFAULT_TIMEOUT = 1_000;
const MAX_TIMEOUT = 2_147_483_647;

/**
 * Probes a configured store with `ping()` and returns a result in the shape `@nestjs/terminus`
 * expects, without importing it. `check` never rejects except with `CacheConfigError` for an
 * unknown store or an invalid timeout; a failing store is reported as `down`.
 */
export class CacheHealthIndicator {
  /** Created by `CacheModule`; do not construct it, inject it. */
  constructor(private readonly options: ResolvedCacheOptions) {}

  async check<K extends string>(
    key: K,
    options: { store?: string; timeout?: number } = {},
  ): Promise<Record<K, CacheHealthResult>> {
    const name = options.store ?? 'default';
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const store = this.options.stores.get(name);
    if (store === undefined) {
      throw new CacheConfigError(
        `Unknown cache store "${name}". Configured stores: ${[...this.options.stores.keys()].join(', ')}`,
      );
    }
    if (
      typeof timeout !== 'number' ||
      !Number.isFinite(timeout) ||
      timeout < 1 ||
      timeout > MAX_TIMEOUT
    ) {
      throw new CacheConfigError(
        `Invalid timeout: ${String(timeout)}. It must be a finite number between 1 and ${String(MAX_TIMEOUT)}.`,
      );
    }
    if (store.ping === undefined) {
      return { [key]: { status: 'up', ping: 'unsupported' } } as Record<K, CacheHealthResult>;
    }
    const result = await probe(() => store.ping?.() ?? Promise.resolve(), timeout);
    return { [key]: result } as Record<K, CacheHealthResult>;
  }
}

async function probe(ping: () => Promise<void>, timeout: number): Promise<CacheHealthResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<CacheHealthResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ status: 'down', message: `timed out after ${String(timeout)} ms` });
    }, timeout);
    timer.unref();
  });
  // The executor turns a synchronous throw into a rejection. Settling to a value here also
  // handles a rejection that arrives after the timeout, so it is never unhandled.
  const pinged = new Promise<void>((resolve) => {
    resolve(ping());
  }).then(
    (): CacheHealthResult => ({ status: 'up' }),
    (error: unknown): CacheHealthResult => ({ status: 'down', message: describe(error) }),
  );
  try {
    return await Promise.race([pinged, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  if (error instanceof CircuitOpenError) return 'circuit open';
  return error instanceof Error ? error.message : String(error);
}
