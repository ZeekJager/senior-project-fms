import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/support/global-setup.ts'],
          // env-setup must run first: it sets DB_NAME to the test database.
          setupFiles: ['test/support/env-setup.ts', 'test/support/transaction-per-test.ts'],
          // One database: files run one at a time so their transactions never wait on each other.
          fileParallelism: false,
          testTimeout: 15_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types/**', 'src/server.ts'],
      reporter: ['text-summary', 'html', 'lcov'],
    },
  },
});
