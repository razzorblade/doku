import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Encryption tests need a built CLI: git runs it as the filter.
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 30000,
  },
});
