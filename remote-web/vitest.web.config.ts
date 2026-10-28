import { defineConfig } from 'vitest/config';

// Node-environment vitest run for the static pair page's pure helpers.
// Separate from the Workers-pool config (`vitest.config.ts`) because these
// tests don't need the Workers runtime — only globals available in Node 18+
// (`atob`, `btoa`, `Uint8Array`, `ArrayBuffer`).
export default defineConfig({
  test: {
    include: ['web/src/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
