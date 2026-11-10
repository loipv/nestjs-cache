import { describe, expect, it, vi } from 'vitest';
import { SingleFlight } from '../../../src/core/single-flight.js';

describe('SingleFlight', () => {
  it('runs one task for concurrent calls with the same key', async () => {
    const sf = new SingleFlight();
    const task = vi.fn(async () => {
      await Promise.resolve();
      return 7;
    });
    expect(await Promise.all([sf.run('k', task), sf.run('k', task), sf.run('k', task)])).toEqual([
      7, 7, 7,
    ]);
    expect(task).toHaveBeenCalledOnce();
  });

  it('runs separate tasks for different keys', async () => {
    const sf = new SingleFlight();
    const task = vi.fn(async () => 1);
    await Promise.all([sf.run('a', task), sf.run('b', task)]);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('runs again after the previous call settled', async () => {
    const sf = new SingleFlight();
    const task = vi.fn(async () => 1);
    await sf.run('k', task);
    await sf.run('k', task);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('shares a rejection, then forgets it (Review Focus 3)', async () => {
    const sf = new SingleFlight();
    const boom = new Error('boom');
    const failing = vi.fn(async () => {
      await Promise.resolve();
      throw boom;
    });
    const results = await Promise.allSettled([sf.run('k', failing), sf.run('k', failing)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(failing).toHaveBeenCalledOnce();
    expect(await sf.run('k', async () => 1)).toBe(1);
  });

  it('turns a synchronous throw into a rejection and forgets it', async () => {
    const sf = new SingleFlight();
    await expect(
      sf.run('k', () => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(await sf.run('k', async () => 2)).toBe(2);
  });

  it('lets a waiter start a new run for the same key right after settling', async () => {
    const sf = new SingleFlight();
    const second = vi.fn(async () => 'second');
    const first = sf.run('k', async () => 'first');
    const chained = first.then(() => sf.run('k', second));
    expect(await chained).toBe('second');
    expect(second).toHaveBeenCalledOnce();
  });
});
