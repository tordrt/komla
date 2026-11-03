import { findNode } from '@/lib/layout-utils';
import { useLayoutStore } from '@/stores/layout.store';

import { isPaneSurfaceId } from '../../shared/lib/pane-surface-id';

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

/**
 * The terminal in the focused pane of a workspace's active tab, to type into: none when the pane
 * shows a browser page, a note or a file instead.
 */
export function getFocusedPromptTerminalId(workspaceId: string): string | null {
  const id = getFocusedTerminalId(workspaceId);
  return id && !isPaneSurfaceId(id) ? id : null;
}
