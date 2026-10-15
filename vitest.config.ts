import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Run in Node.js - no browser / jsdom needed.
     */
    environment: 'node',

    /**
     * Glob that picks up every test file.
     */
    include: ['tests/**/*.test.ts'],

    testTimeout: 30_000,
    hookTimeout: 30_000,

    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',

      /** Keep the suite honest: any coverage regression fails CI. */
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
