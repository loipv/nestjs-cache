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
 * before `cluster create` runs, which otherwise races the daemons and stops the container.
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
    await waitForClusterOk(container);
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

async function waitForClusterOk(container: {
  exec(command: string[]): Promise<{ output: string }>;
}): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const result = await container.exec(['redis-cli', '-p', '7000', 'cluster', 'info']);
    if (result.output.includes('cluster_state:ok')) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Redis cluster did not reach cluster_state:ok within 20 s');
}
