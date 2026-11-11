import { probePubSub, type ProbeClient } from './pubsub-probe.js';

/**
 * Set to `1` where every selected adapter's pub/sub must be reachable (the CI cells on redis v6):
 * an unreachable one then fails the file instead of skipping its pub/sub cases.
 */
export const REQUIRE_PUBSUB_ENV = 'CACHE_IT_REQUIRE_PUBSUB';

/** How long the probe waits for the adapter it started to stop. */
const STOP_WAIT_MS = 10_000;

/** An adapter started for the probe: its raw client and how to stop it. */
export interface ProbeTarget {
  probe: ProbeClient;
  stop(): Promise<void>;
}

/** Returns `reachable`, or throws when it is `false` and `REQUIRE_PUBSUB_ENV` is `1`. */
export function requireReachable(
  name: string,
  reachable: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!reachable && env[REQUIRE_PUBSUB_ENV] === '1') {
    throw new Error(
      `The pub/sub of ${name} is unreachable from this host, and ${REQUIRE_PUBSUB_ENV}=1 requires it`,
    );
  }
  return reachable;
}

/** Awaits `stop`, giving up after `ms`; never rejects. */
async function stopWithin(stop: () => Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      stop().catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts an adapter, probes its pub/sub with the raw client and stops it (within `stopWaitMs`).
 * A startup error rejects: it is a broken run, not an unreachable pub/sub, so the file fails
 * instead of skipping its pub/sub cases. An unreachable result goes through `requireReachable`.
 */
export async function checkPubSub(
  name: string,
  start: () => Promise<ProbeTarget>,
  options: {
    probe?: (client: ProbeClient) => Promise<boolean>;
    env?: NodeJS.ProcessEnv;
    stopWaitMs?: number;
  } = {},
): Promise<boolean> {
  const { probe = probePubSub, env = process.env, stopWaitMs = STOP_WAIT_MS } = options;
  const started = await start();
  let reachable: boolean;
  try {
    reachable = await probe(started.probe);
  } finally {
    await stopWithin(() => started.stop(), stopWaitMs);
  }
  return requireReachable(name, reachable, env);
}
