import { RedisContainer } from '@testcontainers/redis';

export async function startRedis(): Promise<{ url: string; stop(): Promise<void> }> {
  const container = await new RedisContainer('redis:7.4-alpine').start();
  return {
    url: container.getConnectionUrl(),
    stop: async () => {
      await container.stop();
    },
  };
}
