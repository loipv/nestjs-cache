import { GenericContainer } from 'testcontainers';

const PORTS = [7000, 7001, 7002] as const;

export interface RedisClusterHandle {
  /** Seed nodes for a cluster client, reachable from the host. */
  startupNodes: { host: string; port: number }[];
  /**
   * Maps each address the nodes announce (`127.0.0.1:700x`) to its published host port. ioredis
   * takes it as `natMap`; node-redis's `nodeAddressMap` has the same shape.
   */
  natMap: Record<string, { host: string; port: number }>;
  stop(): Promise<void>;
}

/**
 * Starts a three-master Redis 7 cluster (no replicas) in one container. Every node answers PING
 * before `cluster create` runs, which otherwise races the daemons and stops the container. It
 * returns only once every node agrees on the slot map (see `waitForClusterAgreement`).
 */
export async function startRedisCluster(): Promise<RedisClusterHandle> {
  const script = [
    PORTS.map(
      (port) =>
        `redis-server --port ${String(port)} --cluster-enabled yes --cluster-config-file nodes-${String(port)}.conf --cluster-announce-ip 127.0.0.1 --daemonize yes`,
    ).join(' && '),
    `for p in ${PORTS.join(' ')}; do until redis-cli -p $p ping >/dev/null 2>&1; do sleep 0.1; done; done`,
    `redis-cli --cluster create ${PORTS.map((port) => `127.0.0.1:${String(port)}`).join(' ')} --cluster-replicas 0 --cluster-yes`,
    'tail -f /dev/null',
  ].join(' && ');

  const container = await new GenericContainer('redis:7.4-alpine')
    .withExposedPorts(...PORTS)
    .withEntrypoint(['sh', '-c'])
    .withCommand([script])
    .start();

  try {
    await waitForClusterAgreement(container);
  } catch (error) {
    await container.stop();
    throw error;
  }

  // ioredis resolves 'localhost' to ::1, where Colima refuses the connection.
  const host = container.getHost() === 'localhost' ? '127.0.0.1' : container.getHost();
  const natMap: Record<string, { host: string; port: number }> = {};
  for (const port of PORTS) {
    natMap[`127.0.0.1:${String(port)}`] = { host, port: container.getMappedPort(port) };
  }
  return {
    startupNodes: PORTS.map((port) => ({ host, port: container.getMappedPort(port) })),
    natMap,
    stop: async () => {
      await container.stop();
    },
  };
}

/** How long `startRedisCluster` waits for the nodes to agree on the slot map. */
const AGREEMENT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;

/**
 * Polls until every node reports `cluster_state:ok` and `cluster_slots_ok:16384` and all of them
 * answer the same CLUSTER SLOTS. A node can report `cluster_state:ok` while the others still learn
 * the slot owners through gossip; a client that loads the slot map from such a node then follows
 * MOVED replies until it gives up ("Too many Cluster redirections").
 */
async function waitForClusterAgreement(container: {
  exec(command: string[]): Promise<{ output: string }>;
}): Promise<void> {
  // One exec per poll: each node's CLUSTER INFO, then its CLUSTER SLOTS, between markers.
  const script = PORTS.map(
    (port) =>
      `echo '@@info ${String(port)}'; redis-cli -p ${String(port)} cluster info; echo '@@slots ${String(port)}'; redis-cli -p ${String(port)} cluster slots`,
  ).join('; ');
  const deadline = Date.now() + AGREEMENT_TIMEOUT_MS;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    const { output } = await container.exec(['sh', '-c', script]);
    const nodes = PORTS.map((port) => ({
      port,
      info: section(output, `@@info ${String(port)}`),
      slots: section(output, `@@slots ${String(port)}`).trim(),
    }));
    const notOk = nodes.filter(
      ({ info }) => !info.includes('cluster_state:ok') || !info.includes('cluster_slots_ok:16384'),
    );
    const slotMaps = new Set(nodes.map(({ slots }) => slots));
    if (notOk.length === 0 && slotMaps.size === 1 && !slotMaps.has('')) return;
    last =
      notOk.length > 0
        ? `nodes ${notOk.map(({ port }) => String(port)).join(', ')} not at cluster_state:ok with 16384 slots ok`
        : `the nodes answer ${String(slotMaps.size)} different CLUSTER SLOTS maps`;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Redis cluster nodes did not agree on the slot map within ${String(AGREEMENT_TIMEOUT_MS / 1_000)} s (${last})`,
  );
}

/** The lines after `marker`, up to the next `@@` marker or the end of `output`. */
function section(output: string, marker: string): string {
  const start = output.indexOf(`${marker}\n`);
  if (start === -1) return '';
  const body = output.slice(start + marker.length + 1);
  const end = body.indexOf('@@');
  return end === -1 ? body : body.slice(0, end);
}
