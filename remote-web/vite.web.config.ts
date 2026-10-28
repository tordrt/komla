import { randomUUID } from 'node:crypto';

import { defineConfig } from 'vite';

// Vite build for the remote web client. Source lives in `web/`; build output
// goes to `public/`, which Komla serves from its direct remote-control server.
// `public/` is gitignored; `npm run build:web` regenerates it. Files in
// `web/public/` (manifest, icons, service worker) are copied as they are.
//
// Each build gets an id, compiled into the page and written to `build.json`.
// The desktop reports the id it serves when a phone signs in, so a page left
// open across a Komla update reloads instead of running old code against it.
const build = randomUUID();

export default defineConfig({
  root: 'web',
  base: './',
  publicDir: 'public',
  define: {
    __REMOTE_APP_BUILD__: JSON.stringify(build),
  },
  plugins: [
    {
      name: 'komla-remote-build-id',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ build }) });
      },
    },
  ],
  build: {
    outDir: '../public',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    target: 'es2020',
    sourcemap: true,
  },
});
