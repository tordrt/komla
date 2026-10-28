import { useLayoutStore } from '@/stores/layout.store';
import { flashPanes } from '@/stores/pane-flash.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import type { Workspace } from '@/types';

/**
 * Opens a workspace from any window or state: restores one in the Trash
 * into this window, and brings forward the window that already shows an active one.
 * With a terminal, shows the tab with its pane there, focused and flashed.
 */
export async function openWorkspace(
  workspace: Workspace,
  currentWindowId: string,
  terminalId?: string
): Promise<void> {
  const store = useWorkspacesStore.getState();
  if (workspace.status !== 'active') {
    await store.setWorkspaceTrashed(workspace.id, false);
    // A failed restore already showed its error.
    const restored = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspace.id);
    if (restored?.status !== 'active') return;
  } else if (workspace.windowId !== currentWindowId) {
    const focusedElsewhere =
      workspace.windowId !== null &&
      (await window.api.focusWorkspaceWindow(workspace.id, terminalId).catch(() => false));
    if (focusedElsewhere) return;
    void store.moveWorkspaceToWindow(workspace.id, currentWindowId);
  }
  if (terminalId) revealTerminal(workspace.id, terminalId);
  await store.selectWorkspace(workspace.id);
}

/**
 * Shows the terminal's pane in its workspace's layout, focused and flashed. A workspace that just
 * moved to this window gets its tabs a moment later, maybe more than once, so until then, and each
 * time they come in for a while, the pane is shown again.
 */
export function revealTerminal(workspaceId: string, terminalId: string): void {
  let flashed = false;
  const reveal = () => {
    if (!useLayoutStore.getState().revealTerminal(workspaceId, terminalId) || flashed) return;
    flashed = true;
    flashPanes([terminalId]);
  };
  reveal();
  if (flashed) return;
  let tabs = useLayoutStore.getState().tabsByWorkspace[workspaceId];
  const unsubscribe = useLayoutStore.subscribe((state) => {
    if (state.tabsByWorkspace[workspaceId] === tabs) return;
    tabs = state.tabsByWorkspace[workspaceId];
    reveal();
  });
  setTimeout(unsubscribe, 2_000);
}
