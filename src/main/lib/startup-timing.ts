/**
 * Startup milestones for `scripts/measure-startup.mjs`. With KOMLA_STARTUP_TIMING=1 each mark is
 * printed to stdout as `[komla-startup] <name> <epoch ms>`; otherwise marking does nothing.
 *
 * index.ts imports this module first, so its first mark is taken before the rest of the main
 * bundle is evaluated.
 */
const enabled = process.env.KOMLA_STARTUP_TIMING === '1';

/** Epoch milliseconds, with sub-millisecond precision, comparable across processes. */
function now(): number {
  return performance.timeOrigin + performance.now();
}

export function markStartup(name: string): void {
  if (!enabled) return;
  process.stdout.write(`[komla-startup] main:${name} ${now().toFixed(1)}\n`);
}

if (enabled) {
  // When Node started in this process, before Electron's own init ran the bundle.
  process.stdout.write(`[komla-startup] main:process-start ${performance.timeOrigin.toFixed(1)}\n`);
}
markStartup('bundle-start');
