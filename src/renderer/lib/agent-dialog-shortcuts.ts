import { useShortcutsStore } from '@/stores/shortcuts.store';

import {
  NEW_WORKSPACE_DIALOG_ACTIONS,
  type NewWorkspaceDialogAction,
} from '../../shared/constants/shortcut-scopes';

/** A menu in the new workspace dialog that a shortcut can open. */
export type NewWorkspaceMenu = 'agent' | 'effort' | 'environment' | 'branch';

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

function matches(action: string, event: ShortcutEvent): boolean {
  return useShortcutsStore.getState().matchesEvent(action, event as KeyboardEvent);
}

/** The dialog action bound to the keys pressed, if any. */
export function getNewWorkspaceDialogAction(event: ShortcutEvent): NewWorkspaceDialogAction | null {
  return (
    NEW_WORKSPACE_DIALOG_ACTIONS.find((action) => matches(`newWorkspace.${action}`, event)) ?? null
  );
}

/** Shift+Tab, with no other modifier, moves focus back everywhere but the prompt. */
export function movesFocus(event: ShortcutEvent): boolean {
  return event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** The keys of a dialog action as displayed, or '' while it is unbound. */
export function useNewWorkspaceShortcutLabel(action: NewWorkspaceDialogAction): string {
  return (
    useShortcutsStore(
      (state) => state.config && state.getDisplayShortcut(`newWorkspace.${action}`)
    ) ?? ''
  );
}

/** The keys that open the project search: New workspace pressed again, else its own. */
export function useProjectSearchShortcutLabel(): string {
  return (
    useShortcutsStore(
      (state) =>
        state.config &&
        (state.getDisplayShortcut('workspace.new') ||
          state.getDisplayShortcut('newWorkspace.projectSearch'))
    ) || ''
  );
}

const PROJECT_SHORTCUT_COUNT = 9;

/** The Go to workspace keys for this project's position, such as "⌘1"; '' when unbound. */
export function useProjectShortcutLabel(index: number): string {
  return (
    useShortcutsStore(
      (state) =>
        index < PROJECT_SHORTCUT_COUNT &&
        state.config &&
        state.getDisplayShortcut(`workspace.select.${index + 1}`)
    ) || ''
  );
}

/** Index of the project that the Go to workspace 1–9 keys pick, or null for any other key. */
export function getProjectShortcutIndex(event: ShortcutEvent): number | null {
  for (let index = 0; index < PROJECT_SHORTCUT_COUNT; index++) {
    if (matches(`workspace.select.${index + 1}`, event)) return index;
  }
  return null;
}
