import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readdirSync, readFileSync } from 'fs';
import { resolve, sep } from 'path';

// Component tests opt into jsdom with a `@vitest-environment jsdom` comment,
// matched the way vitest reads it.
const domTests = readdirSync(resolve(__dirname, 'tests'), { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.test\.tsx?$/.test(file))
  .map((file) => `tests/${file.split(sep).join('/')}`)
  .filter((file) =>
    /@(?:vitest|jest)-environment\s+jsdom\b/.test(readFileSync(resolve(__dirname, file), 'utf8'))
  );

export default defineConfig({
  plugins: [react()],
  // Keep the optimizer cache out of node_modules: a worktree still on the old
  // shared layout symlinks it, so another worktree could replace a bundle these
  // tests are loading.
  cacheDir: resolve(__dirname, '.cache/vite/test'),
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 15000,
    // Integration tests (e.g. tests/integration/ssh-workspace/) drive real
    // containers and must be run via their own config — see
    // vitest.integration.config.ts and the `test:integration` script.
    exclude: ['node_modules/**', 'dist/**', 'out/**', 'tests/integration/**'],
    setupFiles: ['tests/setup.ts', 'tests/setup-dom.ts'],
    // VM workers keep growing, so each is replaced once it passes 300 MB, which
    // keeps it near a forks worker's size. 512 MB saved little time for 45% more
    // memory. Vitest reads this only from the root config, not from a project.
    vmMemoryLimit: '300MB',
    // Projects inherit the settings above, with arrays merged, so each project
    // owns its `include`.
    projects: [
      {
        extends: true,
        test: { name: 'node', include: ['tests/**/*.test.{ts,tsx}'], exclude: domTests },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          include: domTests,
          // Reused workers skip rebuilding jsdom for every file, about 0.75 s each.
          // The files a worker runs share its `process`, so a test that changes
          // process.env or process.platform must restore it.
          pool: 'vmForks',
          // The icon package ships one module per icon, thousands in all, and
          // loading them took each component test about 2 s. Bundle it once instead.
          deps: {
            optimizer: { client: { enabled: true, include: ['@phosphor-icons/react'] } },
          },
        },
        // The VM pool adds a Vite environment that would otherwise scan the app and
        // pre-bundle about 40 packages, 80 MB, that tests never load.
        environments: { __vitest_vm__: { optimizeDeps: { noDiscovery: true } } },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/preload/**',
        'src/renderer/main.tsx',
        'src/main/index.ts',
        // Vite worker query imports are not parseable by coverage remapper.
        'src/renderer/lib/monaco-loader.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@komla/remote-protocol': resolve(__dirname, 'packages/remote-protocol/src/index.ts'),
    },
  },
});
