import { useEffect } from 'react';

import { getWorkspacePaneSurfaces } from '@/lib/pane-surfaces';
import { useLayoutStore } from '@/stores/layout.store';
import { useTerminalCloseStore } from '@/stores/terminal-close.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

const LAYOUT_SAVE_DEBOUNCE_MS = 500;

function saveWorkspaceLayouts(sync: boolean): void {
  const layoutStore = useLayoutStore.getState();
  const workspaceStore = useWorkspacesStore.getState();
  const windowId = useWindowStore.getState().windowId;
  const layouts: Record<string, unknown> = {};

  for (const workspace of workspaceStore.workspaces) {
    if (workspace.windowId !== windowId) continue;
    layouts[workspace.id] = {
      tabs: layoutStore.tabsByWorkspace[workspace.id] || [],
      layouts: layoutStore.layoutsByTab[workspace.id] || {},
      // Pane focus is used only when handing a live workspace to another window.
      focusedPanes: layoutStore.focusedPaneByTab[workspace.id] || {},
      activeTab: layoutStore.activeTabByWorkspace[workspace.id] || '',
      // Browser and note panes, for the window that takes over if this one closes.
      surfaces: getWorkspacePaneSurfaces(workspace.id),
    };
  }

  if (Object.keys(layouts).length === 0) return;
  // Only the close-time flush blocks; debounced saves must not stall the renderer.
  if (sync) {
    window.api.saveWorkspaceLayoutsSync(windowId, layouts);
  } else {
    window.api.saveWorkspaceLayouts(windowId, layouts);
  }
}

export function useWorkspaceLayoutPersistence(): void {
  useEffect(() => {
    let saveTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = (sync: boolean): void => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (useTerminalCloseStore.getState().closingTerminalIds.size > 0) return;
      saveWorkspaceLayouts(sync);
    };
    const flushOnClose = (): void => flush(true);

    const scheduleSave = (): void => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => flush(false), LAYOUT_SAVE_DEBOUNCE_MS);
    };

    const unsubscribeLayout = useLayoutStore.subscribe((state, previousState) => {
      if (
        state.tabsByWorkspace === previousState.tabsByWorkspace &&
        state.layoutsByTab === previousState.layoutsByTab &&
        state.activeTabByWorkspace === previousState.activeTabByWorkspace
      ) {
        return;
      }
      scheduleSave();
    });
    const unsubscribeTerminalClose = useTerminalCloseStore.subscribe((state, previousState) => {
      if (previousState.closingTerminalIds.size > 0 && state.closingTerminalIds.size === 0) {
        scheduleSave();
      }
    });

    window.addEventListener('beforeunload', flushOnClose);
    return () => {
      unsubscribeLayout();
      unsubscribeTerminalClose();
      if (saveTimer) clearTimeout(saveTimer);
      window.removeEventListener('beforeunload', flushOnClose);
    };
  }, []);
}
