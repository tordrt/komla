import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

import { thirdPartyLicenses } from './scripts/third-party-licenses.mjs';

const isDev = process.env.NODE_ENV === 'development';
const komlaEnv = process.env.KOMLA_ENV || (isDev ? 'staging' : 'production');
// Only scripts/release.sh sets KOMLA_DISTRIBUTION=official; any other build is
// a build from source, which telemetry reports separately.
const distribution = process.env.KOMLA_DISTRIBUTION === 'official' ? 'official' : 'source';
// The managed utility token comes from the environment or a gitignored .env file;
// builds from source have none.
const utilityToken =
  loadEnv(isDev ? 'development' : 'production', process.cwd(), 'KOMLA_UTILITY_TOKEN')
    .KOMLA_UTILITY_TOKEN || '';
if (distribution === 'official' && !utilityToken) {
  throw new Error('KOMLA_DISTRIBUTION=official needs KOMLA_UTILITY_TOKEN (see .env.example)');
}
const buildInfoDefines = {
  __KOMLA_DISTRIBUTION__: JSON.stringify(distribution),
  __KOMLA_UTILITY_TOKEN__: JSON.stringify(utilityToken),
};

export default defineConfig({
  main: {
    // `@komla/remote-protocol` is intentionally source-only (bundler-mode
    // moduleResolution, no `.js` build artifacts) — externalising it leaves
    // Node's ESM loader to walk extensionless relative imports and fail. We
    // bundle it into the main entry instead, which is what its README calls
    // out as the supported consumption mode.
    plugins: [externalizeDepsPlugin({ exclude: ['@komla/remote-protocol'] }), thirdPartyLicenses()],
    define: {
      __KOMLA_ENV__: JSON.stringify(komlaEnv),
      ...buildInfoDefines,
    },
    build: {
      rolldownOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'workers/voice-transcription.worker': resolve(
            'src/main/workers/voice-transcription.worker.ts'
          ),
        },
        output: {
          // MAIN_BUNDLE_DIR (lib/module-path.ts) comes from import.meta.url, and
          // Rolldown may move it into a shared chunk, so chunks sit beside
          // index.js instead of in a chunks/ subfolder.
          chunkFileNames: '[name]-[hash].js',
          // Rollup ran main's module bodies in import order; Rolldown only
          // guarantees that across chunks with this on.
          strictExecutionOrder: true,
        },
        // Without this, Rolldown may export shared code (its runtime helpers)
        // from the voice worker's entry chunk, and index.js importing it would
        // run the worker's top-level code in the main process.
        preserveEntrySignatures: 'strict',
        external: ['node-pty'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin(), thirdPartyLicenses()],
    define: {
      __KOMLA_ENV__: JSON.stringify(komlaEnv),
      __KOMLA_DISTRIBUTION__: JSON.stringify(distribution),
      // Whether the managed AI helpers can run; the token itself stays in the main process.
      __KOMLA_HAS_UTILITY_TOKEN__: JSON.stringify(utilityToken !== ''),
    },
    build: {
      rolldownOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    // Keep the optimizer cache out of node_modules: a worktree still on the old
    // shared layout symlinks it, so another worktree could replace chunks this
    // dev server is serving.
    cacheDir: resolve('.cache/vite/renderer'),
    resolve: {
      alias: {
        '@': resolve('src/renderer'),
      },
    },
    plugins: [react(), tailwindcss(), thirdPartyLicenses()],
    build: {
      rolldownOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          // Toasts drawn above browser previews (see toast-overlay.service.ts).
          'toast-overlay': resolve('src/renderer/toast-overlay.html'),
          // The macOS menu bar's agents popover (see agents-menu-bar.service.ts).
          'agents-menu-bar': resolve('src/renderer/agents-menu-bar.html'),
        },
      },
      // AudioWorklet processors must be emitted as standalone files — Vite's
      // default inlining of small assets as data: URLs would be blocked by
      // our CSP `script-src 'self'`.
      assetsInlineLimit: (filePath: string) => {
        if (filePath.endsWith('.worklet.js')) return false;
        return undefined;
      },
    },
    // Pre-bundle lazily loaded runtime entries (file tree, editor, Settings) up front.
    // Discovering a deep import after Monaco has loaded makes Vite re-optimize
    // and invalidate the browser's cached Monaco chunk.
    // The stale request then gets 504 Outdated Optimize Dep until reload.
    optimizeDeps: {
      include: [
        '@pierre/trees',
        '@pierre/trees/react',
        '@pierre/theming/color',
        'monaco-editor',
        'monaco-editor/esm/vs/language/json/monaco.contribution.js',
        'monaco-editor/esm/vs/language/json/jsonMode.js',
        'monaco-editor/esm/vs/editor/browser/widget/diffEditor/features/overviewRulerFeature.js',
        'shiki',
        '@shikijs/monaco',
        'monaco-vim',
        // Only the lazily loaded Settings dialog imports it.
        'qrcode',
      ],
    },
    server: {
      fs: {
        // Worktrees still on the old shared layout symlink node_modules to
        // ../_<platform>/node_modules. Vite's renderer root is src/renderer, so the
        // default allow-list doesn't reach far enough — serving monaco-editor's
        // codicon.ttf (and other bundled assets) 403s without this.
        allow: [resolve('.'), resolve('..')],
      },
    },
  },
});
