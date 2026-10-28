import { useToastStore } from '@/stores/toast.store';

const PANE_MENU_HINT_STORAGE_KEY = 'komla:pane-menu-hint';

// Panes have no headers by default, so the first split tab says where split, close and drag went.
// The hint stays until it is closed: one that times out in a background window is never seen.
export function showPaneMenuHintOnce(): void {
  try {
    if (window.localStorage.getItem(PANE_MENU_HINT_STORAGE_KEY)) return;
    window.localStorage.setItem(PANE_MENU_HINT_STORAGE_KEY, 'shown');
  } catch {
    return;
  }
  useToastStore
    .getState()
    .addToast(
      'Right-click a pane to split or close it, or drag the grip at its top to move it.',
      'info',
      { dismissOnTimeout: false }
    );
}

// Someone who changes the pane header setting already knows where it is.
export function markPaneMenuHintSeen(): void {
  try {
    window.localStorage.setItem(PANE_MENU_HINT_STORAGE_KEY, 'shown');
  } catch {
    // Without storage the hint can't be remembered either way.
  }
}
