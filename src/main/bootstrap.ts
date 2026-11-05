// The main process's entry (out/main/index.js). It turns on Node's compile cache before loading
// the rest of the main process (index.ts, built to out/main/app.js), so later launches reuse
// V8's compiled code for its few megabytes of JavaScript instead of compiling them again, which
// takes about 70ms. The cache checks each file's contents, so an update recompiles what changed.
import { enableCompileCache, flushCompileCache } from 'module';
import { join } from 'path';

import { app } from 'electron';

/** How long after loading the main process its cache is written, rather than only at quit. */
const FLUSH_DELAY_MS = 10_000;

try {
  // In the profile's own folder, rather than Node's default in the OS's temp folder, which is
  // shared on Linux: another user could create it first and write code this process would run.
  // Staging moves its profile later, so it shares production's; Node checks each entry against
  // its file's contents before using it.
  enableCompileCache(join(app.getPath('userData'), 'Node Compile Cache'));
} catch {
  // Startup only takes longer without it.
}

await import('./index');

// Written now too, so a launch that never quits normally still leaves a cache for the next one.
setTimeout(() => {
  try {
    flushCompileCache();
  } catch {
    // The next launch compiles again.
  }
}, FLUSH_DELAY_MS).unref();
