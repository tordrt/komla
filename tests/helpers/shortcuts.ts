import { useShortcutsStore } from '../../src/renderer/stores/shortcuts.store';

/** The Windows/Linux defaults the new workspace dialog answers to. */
export const NEW_WORKSPACE_DIALOG_SHORTCUTS: Record<string, string> = {
  'workspace.new': 'Cmd+N',
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [`workspace.select.${index + 1}`, `Cmd+${index + 1}`])
  ),
  'newWorkspace.cycleAgent': 'Cmd+.',
  'newWorkspace.cycleLaunchMode': 'Shift+Tab',
};

/** Loads shortcuts into the store as if read from shortcuts.json. */
export function seedShortcuts(overrides: Record<string, string> = {}): void {
  useShortcutsStore.setState({
    config: { shortcuts: { ...NEW_WORKSPACE_DIALOG_SHORTCUTS, ...overrides } },
  });
}
