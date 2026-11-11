import { describe, expect, it, vi } from 'vitest';
import type { ProbeClient } from '../integration/helpers/pubsub-probe.js';
import {
  checkPubSub,
  requireReachable,
  REQUIRE_PUBSUB_ENV,
} from '../integration/helpers/pubsub-reachability.js';

const PROBE = { kind: 'ioredis', client: {} } as unknown as ProbeClient;

function started(stop: () => Promise<void> = () => Promise.resolve()) {
  return { probe: PROBE, stop: vi.fn(stop) };
}

describe('requireReachable', () => {
  it('returns the probe result when the env var is unset', () => {
    expect(requireReachable('ioredis', false, {})).toBe(false);
    expect(requireReachable('ioredis', true, {})).toBe(true);
  });

  it('throws for an unreachable adapter when the env var is 1', () => {
    expect(() =>
      requireReachable('node-redis-sentinel', false, { [REQUIRE_PUBSUB_ENV]: '1' }),
    ).toThrow(/node-redis-sentinel.*CACHE_IT_REQUIRE_PUBSUB/);
    expect(requireReachable('ioredis', true, { [REQUIRE_PUBSUB_ENV]: '1' })).toBe(true);
  });

  it('ignores values other than 1', () => {
    expect(requireReachable('ioredis', false, { [REQUIRE_PUBSUB_ENV]: '0' })).toBe(false);
    expect(requireReachable('ioredis', false, { [REQUIRE_PUBSUB_ENV]: '' })).toBe(false);
  });
});

describe('checkPubSub', () => {
  it('rejects with the startup error instead of reporting the adapter unreachable', async () => {
    const error = new Error('container failed to start');
    const probe = vi.fn(() => Promise.resolve(true));
    await expect(
      checkPubSub('ioredis', () => Promise.reject(error), { probe, env: {} }),
    ).rejects.toBe(error);
    expect(probe).not.toHaveBeenCalled();
  });

  it('returns the probe result and stops the adapter', async () => {
    const adapter = started();
    const probe = vi.fn(() => Promise.resolve(false));
    await expect(
      checkPubSub('ioredis', () => Promise.resolve(adapter), { probe, env: {} }),
    ).resolves.toBe(false);
    expect(probe).toHaveBeenCalledWith(PROBE);
    expect(adapter.stop).toHaveBeenCalledOnce();
  });

  it('rejects an unreachable adapter under the env var, after stopping it', async () => {
    const adapter = started();
    await expect(
      checkPubSub('node-redis-sentinel', () => Promise.resolve(adapter), {
        probe: () => Promise.resolve(false),
        env: { [REQUIRE_PUBSUB_ENV]: '1' },
      }),
    ).rejects.toThrow(/node-redis-sentinel/);
    expect(adapter.stop).toHaveBeenCalledOnce();
  });

  it('ignores a stop that rejects', async () => {
    const adapter = started(() => Promise.reject(new Error('already closed')));
    await expect(
      checkPubSub('ioredis', () => Promise.resolve(adapter), {
        probe: () => Promise.resolve(true),
        env: {},
      }),
    ).resolves.toBe(true);
  });

  it('gives up on a stop that never settles after stopWaitMs', async () => {
    vi.useFakeTimers();
    try {
      const adapter = started(() => new Promise<void>(() => undefined));
      const result = checkPubSub('ioredis', () => Promise.resolve(adapter), {
        probe: () => Promise.resolve(true),
        env: {},
        stopWaitMs: 5_000,
      });
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
