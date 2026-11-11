import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartupTimeoutError, withinStartup } from '../integration/helpers/startup-timeout.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('withinStartup', () => {
  it('resolves with the started value and leaves no timer', async () => {
    /* scenario (final review M-2): a startup that finishes in time is returned as is. */
    vi.useFakeTimers();
    const stopLate = vi.fn(() => Promise.resolve());
    expect(await withinStartup(Promise.resolve('up'), 'Starting x', stopLate, 1_000)).toBe('up');
    expect(stopLate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes a startup error through', async () => {
    /* scenario: a container that fails to start rejects with its own error, not a timeout. */
    await expect(
      withinStartup(Promise.reject(new Error('no image')), 'Starting x', undefined, 1_000),
    ).rejects.toThrow('no image');
  });

  it('rejects with a clear message at the budget, and stops what starts later', async () => {
    /* scenario (M-2): a container start that hangs during collection would hang the file forever;
       the budget turns it into a named error, and a value that arrives afterwards is stopped. */
    vi.useFakeTimers();
    let finish: ((value: string) => void) | undefined;
    const starting = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const stopLate = vi.fn(() => Promise.resolve());
    const result = withinStartup(starting, 'Starting the Sentinel set', stopLate, 120_000);
    const outcome = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(119_999);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(StartupTimeoutError);
    expect(error).toHaveProperty(
      'message',
      'Starting the Sentinel set did not finish within 120 s',
    );
    finish?.('late handle');
    await vi.advanceTimersByTimeAsync(0);
    expect(stopLate).toHaveBeenCalledWith('late handle');
  });

  it('ignores a startup that fails after the budget', async () => {
    /* scenario: a start that rejects late has nothing to stop and raises no unhandled rejection. */
    vi.useFakeTimers();
    let fail: ((error: Error) => void) | undefined;
    const starting = new Promise<string>((_, reject) => {
      fail = reject;
    });
    const stopLate = vi.fn(() => Promise.resolve());
    const outcome = withinStartup(starting, 'Starting x', stopLate, 10).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toBeInstanceOf(StartupTimeoutError);
    fail?.(new Error('gave up'));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopLate).not.toHaveBeenCalled();
  });
});
