/**
 * Global test setup file.
 *
 * This file is loaded before all tests via vitest.config.ts setupFiles.
 * It provides common utilities and resets state between tests.
 */

import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi, beforeEach, afterEach } from 'vitest';

import { restoreHostPlatform } from './helpers/platform';

// Inherited from `git rebase --exec`, hooks or `git -c`, these would point the
// real-git fixture tests at the caller's repository instead of their temp dirs.
for (const key of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
]) {
  delete process.env[key];
}

// Shell scripts the tests run, such as an SSH workspace's setup, may write under $HOME (its
// ~/.ssh/known_hosts, for one). Each test worker gets a home of its own so they never change
// the real one on a developer's computer or a CI runner.
// Rust's toolchain lives under the real home, and some tests build the companion with cargo.
const realHome = homedir();
process.env.RUSTUP_HOME ??= join(realHome, '.rustup');
process.env.CARGO_HOME ??= join(realHome, '.cargo');
process.env.HOME = mkdtempSync(join(tmpdir(), 'komla-test-home-'));

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Restore real timers after each test (in case fake timers were used), and the host's platform
// (in case a test pinned another), which would otherwise reach the worker's next file in the
// dom project, whose files share a `process`.
afterEach(() => {
  vi.useRealTimers();
  restoreHostPlatform();
});

/**
 * Helper to import a service module fresh (after mocks are set up).
 * Use this pattern when testing services that have side effects on import.
 *
 * @example
 * ```ts
 * // In your test:
 * const { configService } = await importFresh('../../../src/main/services/config.service')
 * ```
 */
export async function importFresh<T>(modulePath: string): Promise<T> {
  vi.resetModules();
  return import(modulePath);
}

/**
 * Create a deferred promise for testing async operations.
 * Useful when you need to control when a promise resolves.
 *
 * @example
 * ```ts
 * const { promise, resolve, reject } = createDeferred<string>()
 * // Later in test:
 * resolve('result')
 * await expect(promise).resolves.toBe('result')
 * ```
 */
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Wait for all pending microtasks to complete.
 * Useful when testing code that uses queueMicrotask or Promise.resolve().
 */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

/**
 * Wait for pending promises and advance timers.
 * Combines flushMicrotasks with vi.advanceTimersByTime for comprehensive async control.
 */
export async function flushTimersAndMicrotasks(ms: number): Promise<void> {
  await flushMicrotasks();
  vi.advanceTimersByTime(ms);
  await flushMicrotasks();
}
