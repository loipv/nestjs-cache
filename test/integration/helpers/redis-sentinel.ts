import { GenericContainer, Network, type StartedTestContainer } from 'testcontainers';

const NAME = 'mymaster';
const IMAGE = 'redis:7.4-alpine';
const SENTINEL_PORT = 26379;

export interface RedisSentinelHandle {
  /** The sentinel, reachable from the host. */
  sentinels: { host: string; port: number }[];
  name: typeof NAME;
  /**
   * Maps each address the sentinel announces (container-network `ip:port`, for the master, the
   * replica and the sentinel itself) to its published host port. ioredis takes it as `natMap`;
   * node-redis's `nodeAddressMap` has the same shape. It holds both data nodes, so it stays valid
   * after a failover swaps their roles.
   */
  natMap: Record<string, { host: string; port: number }>;
  /** Runs SENTINEL FAILOVER and resolves once the sentinel reports the other node as master. */
  failover(): Promise<void>;
  stop(): Promise<void>;
}

/** How long `startRedisSentinel` waits for the topology, and `failover` for a new master. */
const WAIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;

/**
 * Starts a Redis 7 master, one replica and one sentinel (quorum 1) on their own Docker network.
 * The sentinel gets a writable copy of its config (it rewrites it). It returns once the replica's
 * link to the master is up and the sentinel lists the replica, so a failover can promote it.
 */
export async function startRedisSentinel(): Promise<RedisSentinelHandle> {
  const network = await new Network().start();
  const started: StartedTestContainer[] = [];
  const stop = async (): Promise<void> => {
    for (const container of started.reverse()) await container.stop();
    await network.stop();
  };
  try {
    const networkName = network.getName();
    const master = await new GenericContainer(IMAGE)
      .withNetwork(network)
      .withExposedPorts(6379)
      .start();
    started.push(master);
    const masterIp = master.getIpAddress(networkName);

    const replica = await new GenericContainer(IMAGE)
      .withNetwork(network)
      .withExposedPorts(6379)
      .withCommand(['redis-server', '--replicaof', masterIp, '6379'])
      .start();
    started.push(replica);
    const replicaIp = replica.getIpAddress(networkName);

    const config = [
      `port ${String(SENTINEL_PORT)}`,
      `sentinel monitor ${NAME} ${masterIp} 6379 1`,
      `sentinel down-after-milliseconds ${NAME} 1000`,
      `sentinel failover-timeout ${NAME} 5000`,
      `sentinel parallel-syncs ${NAME} 1`,
      '',
    ].join('\n');
    const sentinel = await new GenericContainer(IMAGE)
      .withNetwork(network)
      .withExposedPorts(SENTINEL_PORT)
      // The mode lets the copy in /tmp be rewritten by the sentinel.
      .withCopyContentToContainer([{ content: config, target: '/etc/sentinel.conf', mode: 0o666 }])
      .withCommand(['sh', '-c', 'cp /etc/sentinel.conf /tmp/s.conf && redis-sentinel /tmp/s.conf'])
      .start();
    started.push(sentinel);
    const sentinelIp = sentinel.getIpAddress(networkName);

    await waitFor('the replica to sync and the sentinel to list it', async () => {
      const link = await redisCli(replica, 6379, ['info', 'replication']);
      const replicas = await redisCli(sentinel, SENTINEL_PORT, ['sentinel', 'replicas', NAME]);
      return link.includes('master_link_status:up') && replicas.includes(replicaIp);
    });

    // ioredis resolves 'localhost' to ::1, where Colima refuses the connection.
    const host = sentinel.getHost() === 'localhost' ? '127.0.0.1' : sentinel.getHost();
    const natMap: Record<string, { host: string; port: number }> = {
      [`${masterIp}:6379`]: { host, port: master.getMappedPort(6379) },
      [`${replicaIp}:6379`]: { host, port: replica.getMappedPort(6379) },
      [`${sentinelIp}:${String(SENTINEL_PORT)}`]: {
        host,
        port: sentinel.getMappedPort(SENTINEL_PORT),
      },
    };

    const masterAddress = async (): Promise<string> =>
      (await redisCli(sentinel, SENTINEL_PORT, ['sentinel', 'get-master-addr-by-name', NAME]))
        .split('\n')[0]
        ?.trim() ?? '';

    return {
      sentinels: [{ host, port: sentinel.getMappedPort(SENTINEL_PORT) }],
      name: NAME,
      natMap,
      failover: async () => {
        const before = await masterAddress();
        const reply = await redisCli(sentinel, SENTINEL_PORT, ['sentinel', 'failover', NAME]);
        if (!reply.includes('OK')) throw new Error(`SENTINEL FAILOVER answered: ${reply.trim()}`);
        await waitFor('the sentinel to report a new master', async () => {
          const now = await masterAddress();
          return now !== '' && now !== before;
        });
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function redisCli(
  container: StartedTestContainer,
  port: number,
  args: string[],
): Promise<string> {
  const { output } = await container.exec(['redis-cli', '-p', String(port), ...args]);
  return output;
}

async function waitFor(what: string, done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out after ${String(WAIT_TIMEOUT_MS / 1_000)} s waiting for ${what}`);
}
