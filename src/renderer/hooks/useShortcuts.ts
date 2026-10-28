import { useEffect, useCallback } from 'react';

import {
  getOrCreateDetector,
  getDetector,
  removeDetector,
  configKeyToEventKey,
} from '@/lib/double-tap-detector';
import { executeShortcutAction } from '@/lib/shortcut-actions';
import { isShortcutEventClaimed } from '@/lib/shortcut-claims';
import { useShortcutsStore, isDoubleTapShortcut, getDoubleTapKey } from '@/stores/shortcuts.store';

type ShortcutHandlers = Record<string, (event: KeyboardEvent) => void>;

/**
 * Hook to handle keyboard shortcuts.
 * Automatically skips when typing in inputs/textareas.
 * Skips DoubleTap+ shortcuts (those are handled by useDoubleTapShortcuts).
 *
 * @param handlers - Map of action IDs to handler functions
 * @param enabled - Optional flag to enable/disable shortcuts (default: true)
 */
export function useShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  const { config, matchesEvent } = useShortcutsStore();

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!config || !enabled || isShortcutEventClaimed(event)) return;

      // Skip if typing in an input, textarea, or Monaco editor
      const target = event.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        target.closest('.monaco-editor')
      ) {
        return;
      }

      // Check each handler's action to see if it matches
      for (const [action, handler] of Object.entries(handlers)) {
        // matchesEvent already returns false for DoubleTap+ shortcuts
        if (matchesEvent(action, event)) {
          event.preventDefault();
          event.stopPropagation();
          handler(event);
          return;
        }
      }
    },
    [config, enabled, handlers, matchesEvent]
  );

  useEffect(() => {
    if (!enabled) return;

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, handleKeyDown]);
}

/**
 * Hook to handle DoubleTap+ shortcuts at the window level.
 *
 * Creates detector instances in the singleton registry so that xterm's
 * custom key handler can also feed keydown/keyup events into the same
 * detectors (sharing timing state).
 *
 * Window-level listeners handle double-tap when focus is NOT in xterm.
 * The xterm custom key handler feeds events when focus IS in xterm.
 */
export function useDoubleTapShortcuts(enabled = true): void {
  const config = useShortcutsStore((state) => state.config);

  useEffect(() => {
    if (!config || !enabled) return;

    const registeredKeys: string[] = [];

    // Find all DoubleTap+ shortcuts and create registry detectors
    for (const [actionId, shortcut] of Object.entries(config.shortcuts)) {
      if (!isDoubleTapShortcut(shortcut)) continue;
      const configKey = getDoubleTapKey(shortcut);
      if (!configKey) continue;
      const key = configKeyToEventKey(configKey);
      if (registeredKeys.includes(key)) continue;

      registeredKeys.push(key);
      getOrCreateDetector(key, () => {
        executeShortcutAction(actionId);
      });
    }

    // Window-level listeners (for when focus is not in xterm)
    // No INPUT/TEXTAREA guard here — modifier keys like Shift don't produce
    // input, and the wasModifierOnly flag in the detector prevents false
    // triggers when the user is actually typing (Shift + letter).
    const handleKeyDown = (event: KeyboardEvent) => {
      for (const key of registeredKeys) {
        getDetector(key)?.handleKeyDown(event);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      for (const key of registeredKeys) {
        getDetector(key)?.handleKeyUp(event);
      }
    };

    const handleBlur = () => {
      for (const key of registeredKeys) {
        getDetector(key)?.reset();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      for (const key of registeredKeys) {
        removeDetector(key);
      }
    };
  }, [config, enabled]);
}

/**
 * Hook to get the display string for a shortcut action.
 * Returns platform-appropriate symbols (e.g., "⌘W" on Mac, "Ctrl+W" on Windows).
 *
 * @param action - The action ID (e.g., 'pane.close')
 * @returns Display string for the shortcut
 */
export function useShortcutDisplay(action: string): string {
  const getDisplayShortcut = useShortcutsStore((state) => state.getDisplayShortcut);
  return getDisplayShortcut(action);
}
