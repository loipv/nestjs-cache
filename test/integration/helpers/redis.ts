import { RedisContainer } from '@testcontainers/redis';
import { Wait } from 'testcontainers';

/**
 * Starts a single Redis 7 node. RedisContainer waits only for the "Ready to accept connections"
 * log line; on Colima the published host port can still refuse connections at that point, so it
 * also waits until the port accepts a connection from the host.
 */
export async function startRedis(): Promise<{ url: string; stop(): Promise<void> }> {
  const container = await new RedisContainer('redis:7.4-alpine')
    .withWaitStrategy(
      Wait.forAll([Wait.forLogMessage('Ready to accept connections'), Wait.forListeningPorts()]),
    )
    .start();
  return {
    url: container.getConnectionUrl(),
    stop: async () => {
      await container.stop();
    },
  };
}
