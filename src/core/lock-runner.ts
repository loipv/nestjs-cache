import type { LockHandle, LockProvider } from '../stores/cache-store.interface.js';

/** Milliseconds. `ttl` goes to the store and must already be an integer >= 1. */
export interface LockSettings {
  ttl: number;
  waitTimeout: number;
  retryDelay: number;
}

/** Reads the entry again without emitting `hit`/`miss`; `found` means usable by the caller. */
export type Reread<T> = () => Promise<{ found: true; value: T } | { found: false }>;

/** Must not throw. */
export interface LockHooks {
  /** Called right before `acquire` (the `cache.lock` span starts here). */
  onAcquireStart?(): void;
  /** Called once: the lock was acquired, or the wait for it ended. */
  onLock(acquired: boolean, waitedMs: number): void;
  onError(error: unknown): void;
  /**
   * Runs the background release; the engine runs it outside the cache scope, so a release error
   * lands on no cache span. Without it, the release starts in place.
   */
  detach?(run: () => void): void;
}

/** A plain `setTimeout`, not unref'd, so fake timers drive the wait. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts the release without awaiting it (through `hooks.detach` when set); a failed or throwing
 * release is reported, never raised.
 */
function releaseInBackground(handle: LockHandle, hooks: LockHooks): void {
  const release = (): void => {
    try {
      handle.release().catch((error: unknown) => {
        hooks.onError(error);
      });
    } catch (error) {
      hooks.onError(error);
    }
  };
  if (hooks.detach === undefined) release();
  else hooks.detach(release);
}

/**
 * Releases in `finally` without delaying the caller; a failed release never replaces the load
 * outcome.
 */
async function whileHolding<T>(
  handle: LockHandle,
  load: () => Promise<T>,
  hooks: LockHooks,
): Promise<T> {
  try {
    return await load();
  } finally {
    releaseInBackground(handle, hooks);
  }
}

/**
 * Miss path (spec 0.2, 4.4). With the lock: re-read once, then load and release (the release
 * runs in the background). Without it: poll `reread` every `retryDelay` until a value appears or
 * `waitTimeout` passes, then load without the lock. When `acquire` throws, the error is reported
 * and the load runs without the lock.
 */
export async function loadWithLock<T>(
  lock: LockProvider,
  key: string,
  settings: LockSettings,
  reread: Reread<T>,
  load: () => Promise<T>,
  hooks: LockHooks,
): Promise<{ value: T; from: 'cache' | 'load' }> {
  const started = Date.now();
  let handle: LockHandle | undefined;
  hooks.onAcquireStart?.();
  try {
    handle = await lock.acquire(key, settings.ttl);
  } catch (error) {
    hooks.onError(error);
    return { value: await load(), from: 'load' };
  }
  if (handle !== undefined) {
    hooks.onLock(true, Date.now() - started);
    // Another holder may have written between the first miss and this acquire.
    let cached: Awaited<ReturnType<Reread<T>>> = { found: false };
    try {
      cached = await reread();
    } catch (error) {
      hooks.onError(error);
    }
    if (cached.found) {
      releaseInBackground(handle, hooks);
      return { value: cached.value, from: 'cache' };
    }
    return { value: await whileHolding(handle, load, hooks), from: 'load' };
  }
  for (;;) {
    // The last sleep is shortened so the wait never runs past waitTimeout.
    const remaining = settings.waitTimeout - (Date.now() - started);
    await sleep(Math.min(settings.retryDelay, Math.max(0, remaining)));
    const cached = await reread();
    const waited = Date.now() - started;
    if (cached.found) {
      hooks.onLock(false, waited);
      return { value: cached.value, from: 'cache' };
    }
    if (waited >= settings.waitTimeout) {
      hooks.onLock(false, waited);
      return { value: await load(), from: 'load' };
    }
  }
}

/**
 * Background refresh (spec 0.2, 4.3): one attempt, no wait. A held lock skips the load; a
 * failing `acquire` is reported and the load runs without the lock.
 */
export async function refreshWithLock(
  lock: LockProvider,
  key: string,
  ttl: number,
  load: () => Promise<void>,
  hooks: LockHooks,
): Promise<void> {
  const started = Date.now();
  let handle: LockHandle | undefined;
  hooks.onAcquireStart?.();
  try {
    handle = await lock.acquire(key, ttl);
  } catch (error) {
    hooks.onError(error);
    await load();
    return;
  }
  hooks.onLock(handle !== undefined, Date.now() - started);
  if (handle === undefined) return;
  await whileHolding(handle, load, hooks);
}
