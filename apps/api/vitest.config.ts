import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/helpers/globalSetup.ts'],
    setupFiles: ['tests/helpers/setupEnv.ts'],
    include: ['tests/**/*.test.ts'],
    fileParallelism: false, // all suites share one MySQL test database
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
