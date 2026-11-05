import { useShortcutsStore } from '@/stores/shortcuts.store';

import {
  NEW_WORKSPACE_DIALOG_ACTIONS,
  type NewWorkspaceDialogAction,
} from '../../shared/constants/shortcut-scopes';

/** A menu in the new workspace dialog that a shortcut can open. */
export type NewWorkspaceMenu = 'agent' | 'effort' | 'model' | 'environment' | 'branch';

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

/**
 * The Go to workspace 1–9 keys, which the dialog claims so they never act
 * behind it.
 */
export function isWorkspaceSelectShortcut(event: ShortcutEvent): boolean {
  for (let number = 1; number <= 9; number++) {
    if (matches(`workspace.select.${number}`, event)) return true;
  }
  return false;
}
