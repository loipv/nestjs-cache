import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthCheckService, TerminusModule } from '@nestjs/terminus';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheConfigError } from '../../../src/errors.js';
import { CacheHealthIndicator } from '../../../src/health/cache-health.indicator.js';
import { CacheModule } from '../../../src/module/cache.module.js';
import type { ResolvedCacheOptions } from '../../../src/module/cache.options.js';
import { circuitBreaker } from '../../../src/resilience/circuit-breaker.store.js';
import type { CacheStore } from '../../../src/stores/cache-store.interface.js';
import { FakeStore } from '../helpers/fake-store.js';

function withPing(ping: () => Promise<void>): FakeStore & { ping: () => Promise<void> } {
  return Object.assign(new FakeStore(), { ping });
}

/** Rejects with a non-Error value, as a misbehaving store might. */
function nonErrorRejection(reason: unknown): Promise<void> {
  return new Promise((_, reject: (reason: unknown) => void) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the test
    reject(reason);
  });
}

function indicatorFor(stores: Record<string, CacheStore>): CacheHealthIndicator {
  const options = { stores: new Map(Object.entries(stores)) } as unknown as ResolvedCacheOptions;
  return new CacheHealthIndicator(options);
}

describe('CacheHealthIndicator', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports up when ping resolves', async () => {
    const indicator = indicatorFor({ default: withPing(() => Promise.resolve()) });
    expect(await indicator.check('cache')).toEqual({ cache: { status: 'up' } });
  });

  it('reports up with ping unsupported for a store without ping', async () => {
    const indicator = indicatorFor({ default: new FakeStore() });
    expect(await indicator.check('cache')).toEqual({
      cache: { status: 'up', ping: 'unsupported' },
    });
  });

  it('checks the named store', async () => {
    const down = withPing(() => Promise.reject(new Error('boom')));
    const indicator = indicatorFor({ default: new FakeStore(), other: down });
    expect(await indicator.check('c', { store: 'other' })).toEqual({
      c: { status: 'down', message: 'boom' },
    });
  });

  it('reports down with the error message', async () => {
    const indicator = indicatorFor({
      default: withPing(() => Promise.reject(new Error('ECONNREFUSED'))),
    });
    expect(await indicator.check('cache')).toEqual({
      cache: { status: 'down', message: 'ECONNREFUSED' },
    });
  });

  it('reports down with String(error) for a non-Error rejection', async () => {
    const indicator = indicatorFor({
      default: withPing(() => nonErrorRejection('nope')),
    });
    expect(await indicator.check('cache')).toEqual({ cache: { status: 'down', message: 'nope' } });
  });

  it('treats a synchronous throw from ping as down', async () => {
    const indicator = indicatorFor({
      default: withPing(() => {
        throw new Error('sync');
      }),
    });
    expect(await indicator.check('cache')).toEqual({ cache: { status: 'down', message: 'sync' } });
  });

  it('reports down after the timeout and clears the timer', async () => {
    vi.useFakeTimers();
    const indicator = indicatorFor({ default: withPing(() => new Promise<void>(() => undefined)) });
    const pending = indicator.check('cache', { timeout: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({
      cache: { status: 'down', message: 'timed out after 500 ms' },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer when ping settles first', async () => {
    vi.useFakeTimers();
    const indicator = indicatorFor({ default: withPing(() => Promise.resolve()) });
    await indicator.check('cache');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defaults the timeout to 1000 ms', async () => {
    vi.useFakeTimers();
    const indicator = indicatorFor({ default: withPing(() => new Promise<void>(() => undefined)) });
    const pending = indicator.check('cache');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({
      cache: { status: 'down', message: 'timed out after 1000 ms' },
    });
  });

  it('swallows a late ping rejection (Review Focus 3)', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const indicator = indicatorFor({
        default: withPing(
          () =>
            new Promise<void>((_, reject) => {
              setTimeout(() => {
                reject(new Error('late'));
              }, 20);
            }),
        ),
      });
      for (let i = 0; i < 3; i += 1) {
        expect(await indicator.check('cache', { timeout: 5 })).toEqual({
          cache: { status: 'down', message: 'timed out after 5 ms' },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('reports circuit open through a real breaker', async () => {
    const inner = withPing(() => Promise.reject(new Error('down')));
    const breaker = circuitBreaker(inner, { failureThreshold: 1 });
    const indicator = indicatorFor({ default: breaker });
    expect(await indicator.check('cache')).toEqual({
      cache: { status: 'down', message: 'down' },
    });
    expect(await indicator.check('cache')).toEqual({
      cache: { status: 'down', message: 'circuit open' },
    });
  });

  it('rejects an unknown store and an invalid timeout', async () => {
    const indicator = indicatorFor({ default: new FakeStore(), b: new FakeStore() });
    await expect(indicator.check('c', { store: 'x' })).rejects.toThrow(
      new CacheConfigError('Unknown cache store "x". Configured stores: default, b'),
    );
    for (const timeout of [0, 2_147_483_648, Number.NaN]) {
      const error = await indicator.check('c', { timeout }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CacheConfigError);
      expect((error as Error).message).toBe(
        `Invalid timeout: ${String(timeout)}. It must be a finite number between 1 and 2147483647.`,
      );
    }
  });

  it('is provided and exported by CacheModule', async () => {
    const ref = await Test.createTestingModule({ imports: [CacheModule.forRoot()] }).compile();
    await ref.init();
    try {
      const indicator = ref.get(CacheHealthIndicator);
      expect(indicator).toBeInstanceOf(CacheHealthIndicator);
      expect(await indicator.check('cache')).toEqual({ cache: { status: 'up' } });
    } finally {
      await ref.close();
    }
  });

  it('terminus marks a down result as 503 (assumption 2)', async () => {
    const down = withPing(() => Promise.reject(new Error('ECONNREFUSED')));
    const up = withPing(() => Promise.resolve());
    const ref = await Test.createTestingModule({
      imports: [TerminusModule.forRoot({ logger: false })],
    }).compile();
    try {
      const health = ref.get(HealthCheckService);
      const bad = indicatorFor({ default: down });
      const error = await health.check([() => bad.check('cache')]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getStatus()).toBe(503);
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
        status: 'error',
        error: { cache: { status: 'down', message: 'ECONNREFUSED' } },
      });
      const good = indicatorFor({ default: up });
      expect(await health.check([() => good.check('cache')])).toMatchObject({
        status: 'ok',
        info: { cache: { status: 'up' } },
      });
    } finally {
      await ref.close();
    }
  });
});
