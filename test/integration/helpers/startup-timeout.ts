/**
 * The budget for starting containers and clients while a file is collected (top-level `await`),
 * which Vitest does not time out; it matches the integration project's `hookTimeout`.
 */
export const STARTUP_TIMEOUT_MS = 120_000;

/** A startup that did not finish within its budget. */
export class StartupTimeoutError extends Error {
  override readonly name = 'StartupTimeoutError';
}

/**
 * Resolves as `starting` does, or rejects with a `StartupTimeoutError` naming `what` once `ms` have
 * passed. After a timeout, a value that `starting` still resolves with is passed to `stopLate`, so
 * nothing it started keeps running; errors from that late stop are ignored.
 */
export async function withinStartup<T>(
  starting: Promise<T>,
  what: string,
  stopLate: (value: T) => Promise<unknown> = () => Promise.resolve(),
  ms = STARTUP_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // From now on, whatever `starting` still starts is stopped.
      starting.then(stopLate).catch(() => undefined);
      reject(new StartupTimeoutError(`${what} did not finish within ${String(ms / 1000)} s`));
    }, ms);
  });
  try {
    return await Promise.race([starting, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
