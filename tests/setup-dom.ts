/**
 * Setup file for DOM/React component tests.
 * Loaded via vitest `setupFiles` — adds @testing-library/jest-dom matchers.
 * Node-environment tests skip it: loading React Testing Library cost each about 150 ms.
 */
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');
  const React = await import('react');

  // React's development build captures a stack (an Error and a console task) for
  // every element it creates, for the owner stacks in its warnings, until it has
  // captured 10,000 in a second. That was about a seventh of a component test's
  // time. Holding the count at the limit skips the capture; a React warning in a
  // test still names the component, without the owner stack.
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: object;
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  Object.defineProperty(internals, 'recentlyCreatedOwnerStacks', {
    configurable: true,
    get: () => 10_000,
    set: () => {},
  });

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
