import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerShortcutAction,
  executeShortcutAction,
  hasShortcutAction,
} from '../../../src/renderer/lib/shortcut-actions';

describe('shortcut-actions', () => {
  // Clean up between tests by registering then removing
  let cleanups: (() => void)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
  });

  function register(id: string, handler: () => void) {
    const cleanup = registerShortcutAction(id, handler);
    cleanups.push(cleanup);
    return cleanup;
  }

  describe('registerShortcutAction', () => {
    it('registers a handler that can be executed', () => {
      const handler = vi.fn();
      register('test.action', handler);

      executeShortcutAction('test.action');
      expect(handler).toHaveBeenCalledOnce();
    });

    it('returns a cleanup function that unregisters the handler', () => {
      const handler = vi.fn();
      const cleanup = registerShortcutAction('test.cleanup', handler);

      cleanup();

      expect(hasShortcutAction('test.cleanup')).toBe(false);
      expect(executeShortcutAction('test.cleanup')).toBe(false);
    });

    it('overwrites a previously registered handler', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      register('test.overwrite', handler1);
      register('test.overwrite', handler2);

      executeShortcutAction('test.overwrite');
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledOnce();
    });
  });

  describe('executeShortcutAction', () => {
    it('returns true when action is found and executed', () => {
      register('test.found', vi.fn());
      expect(executeShortcutAction('test.found')).toBe(true);
    });

    it('returns false when action is not registered', () => {
      expect(executeShortcutAction('nonexistent.action')).toBe(false);
    });
  });

  describe('hasShortcutAction', () => {
    it('returns true for registered action', () => {
      register('test.has', vi.fn());
      expect(hasShortcutAction('test.has')).toBe(true);
    });

    it('returns false for unregistered action', () => {
      expect(hasShortcutAction('nonexistent')).toBe(false);
    });
  });
});
