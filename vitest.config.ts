import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/index.ts', 'src/stores/ioredis.adapter.ts'],
      thresholds: { lines: 90 },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          // The engine tests again, with a FakeTracer registered (test/unit/helpers/engine.ts):
          // tracing must not change behaviour or tick order.
          name: 'unit-traced',
          include: ['test/unit/core/cache-engine*.test.ts'],
          env: { CACHE_TEST_TRACING: '1' },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
