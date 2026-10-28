import { findNode } from '@/lib/layout-utils';
import { useLayoutStore } from '@/stores/layout.store';

/** The terminal in the focused pane of a workspace's active tab. */
export function getFocusedTerminalId(workspaceId: string): string | null {
  const { activeTabByWorkspace, focusedPaneByTab, layoutsByTab } = useLayoutStore.getState();
  const activeTabId = activeTabByWorkspace[workspaceId];
  if (!activeTabId) return null;
  const focusedPaneId = focusedPaneByTab[workspaceId]?.[activeTabId];
  const layout = layoutsByTab[workspaceId]?.[activeTabId];
  if (!focusedPaneId || !layout) return null;
  const focusedPane = findNode(layout, focusedPaneId);
  return focusedPane?.type === 'leaf' ? focusedPane.terminalId : null;
}
