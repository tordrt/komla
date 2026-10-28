/**
 * Setup file for DOM/React component tests.
 * Loaded via vitest `setupFiles` — adds @testing-library/jest-dom matchers.
 * Node-environment tests skip it: loading React Testing Library cost each about 150 ms.
 */
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');

  // Auto-cleanup is gated on `globalThis.afterEach` being present at import
  // time. With vitest's `environment: 'node'` default, this file may be
  // evaluated before vitest's globals are wired up for files that opt into
  // jsdom via `@vitest-environment` — so register cleanup explicitly.
  afterEach(() => {
    cleanup();
  });
}

// jsdom has no canvas: getContext() logs "Not implemented" and returns null.
// Return the null without the log.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = () => null;
}
