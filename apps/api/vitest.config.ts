import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Tests that need MongoDB share one database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
