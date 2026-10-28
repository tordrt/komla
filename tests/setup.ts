/**
 * Global test setup file.
 *
 * This file is loaded before all tests via vitest.config.ts setupFiles.
 * It provides common utilities and resets state between tests.
 */

import { vi, beforeEach, afterEach } from 'vitest';

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

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Restore real timers after each test (in case fake timers were used)
afterEach(() => {
  vi.useRealTimers();
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
