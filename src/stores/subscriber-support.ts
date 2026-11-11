/** How long a subscriber's `close` waits for a graceful close before it drops the connection. */
export const CLOSE_TIMEOUT_MS = 1_000;

/** Calls every handler; a throwing handler never reaches the others or the client's emitter. */
export function notifyAll<A extends unknown[]>(
  handlers: readonly ((...args: A) => void)[],
  ...args: A
): void {
  for (const handler of handlers) {
    try {
      handler(...args);
    } catch {
      // swallowed: this runs inside the client's event listeners
    }
  }
}

/**
 * Runs `close`, or `destroy` when `close` rejects, throws or has not settled after
 * `CLOSE_TIMEOUT_MS`. Never rejects; the timer is unref'd and always cleared.
 */
export async function closeWithTimeout(close: () => unknown, destroy: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(true);
    }, CLOSE_TIMEOUT_MS);
    timer.unref();
  });
  // The executor turns a synchronous throw into a rejection.
  const closed = new Promise((resolve) => {
    resolve(close());
  }).then(
    () => false,
    () => true,
  );
  const force = await Promise.race([closed, timedOut]);
  clearTimeout(timer);
  if (!force) return;
  try {
    destroy();
  } catch {
    // close never rejects
  }
}
