import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Vitest config for integration tests that drive real external resources
 * (Docker containers). Kept separate from the unit-test config so `npm test`
 * stays fast, hermetic, and CI-friendly.
 *
 * Run them with `npm run test:integration`.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.{ts,tsx}'],
    // Building the image and starting the container is the long pole. Bound generously.
    testTimeout: 600_000,
    hookTimeout: 900_000,
    // Single fork, so suites driving real external resources never run side by
    // side. Vitest 4 replaces the old
    // `poolOptions.forks.singleFork: true` with the top-level
    // `fileParallelism: false` plus `pool: 'forks'`.
    pool: 'forks',
    fileParallelism: false,
    // No setupFiles — integration tests do their own narrow `vi.mock(...)`
    // calls.
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
});
