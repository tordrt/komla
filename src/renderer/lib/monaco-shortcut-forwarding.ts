/**
 * Forward app-level keyboard shortcuts from Monaco editors.
 *
 * Monaco captures keyboard events internally, preventing them from reaching
 * the window-level shortcut listeners in useShortcuts(). This mirrors the
 * pattern used in TerminalView's custom key handler: intercept keydowns,
 * check against registered app shortcuts, and call executeShortcutAction().
 *
 * Only a curated set of navigation/workspace shortcuts are forwarded to avoid
 * conflicting with Monaco's built-in keybindings (Cmd+D, Cmd+K, Cmd+F, etc.).
 */

import { isDoubleTapShortcut, useShortcutsStore } from '@/stores/shortcuts.store';

import { executeShortcutAction } from './shortcut-actions';

import type { IDisposable, editor as monacoEditor } from 'monaco-editor';

/**
 * Shortcuts that should be forwarded from Monaco. Only actions whose default
 * keybindings do NOT conflict with Monaco's built-in keybindings or with
 * the file viewer's own shortcuts.
 *
 * Notably excluded:
 * - workspace.next/previous (Cmd+Arrow — Monaco: cursor to top/bottom)
 * - workspace.overview (Cmd+Shift+O — Monaco: Go to Symbol)
 * - workspace.trash (Cmd+Shift+Backspace)
 * - workspace.select.1-9 (Cmd+1/2/3 — file viewer: mode switching)
 * - tab.next/previous (Cmd+]/[ — Monaco: indent/outdent)
 */
const FORWARDED_ACTIONS = new Set([
  'workspace.new',
  'workspace.openFolder',
  'tab.newAgent',
  'commandCenter.open',
  'note.new',
]);

/**
 * Attach an onKeyDown handler to a Monaco editor that intercepts app shortcuts
 * and forwards them via executeShortcutAction().
 *
 * @returns IDisposable to clean up the listener (auto-disposed when editor unmounts)
 */
export function addMonacoShortcutForwarding(
  editor: monacoEditor.IStandaloneCodeEditor
): IDisposable {
  return editor.onKeyDown((e) => {
    if (forwardAppShortcut(e.browserEvent)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

/**
 * Runs the app shortcut a key press in an editor matches, for editors that
 * keep key presses from the window listeners. Returns whether one ran.
 */
export function forwardAppShortcut(event: KeyboardEvent): boolean {
  const { config, matchesEvent } = useShortcutsStore.getState();
  if (!config) return false;

  for (const action of FORWARDED_ACTIONS) {
    const shortcut = config.shortcuts[action];
    if (!shortcut) continue;
    if (isDoubleTapShortcut(shortcut)) continue;
    if (matchesEvent(action, event)) return executeShortcutAction(action);
  }
  return false;
}
