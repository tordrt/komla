import {
  createLeaf,
  findNode,
  findPaneByTerminalId,
  getAllLeaves,
  splitLeaf,
} from './layout-utils';

import type { Workspace } from '../types';
import type { LayoutNode, PaneId, SplitDirection } from '../types/layout';

export interface WorkspaceLayoutHydration {
  tabs: string[];
  layouts: Record<string, LayoutNode>;
  focusedPanes: Record<string, PaneId>;
  activeTab: string;
}

export function isWorkspaceLayoutPlaceholder(
  workspaceId: string,
  tabs: string[] | undefined
): boolean {
  return tabs?.length === 1 && tabs[0] === workspaceId;
}

export function buildWorkspaceLayoutHydration(
  workspace: Pick<Workspace, 'terminals' | 'primaryTerminalId'>
): WorkspaceLayoutHydration | null {
  const rootTerminal = workspace.terminals[0];
  if (!rootTerminal) return null;

  const rootLeaf = createLeaf(rootTerminal.id);
  const tabs = [rootTerminal.id];
  const layouts: Record<string, LayoutNode> = { [rootTerminal.id]: rootLeaf };
  const focusedPanes: Record<string, PaneId> = { [rootTerminal.id]: rootLeaf.id };
  const primaryTerminalId = workspace.primaryTerminalId ?? rootTerminal.id;
  let activeTab = rootTerminal.id;
  let currentTabRoot = rootTerminal.id;

  for (const terminal of workspace.terminals.slice(1)) {
    if (terminal.layoutHint === 'tab') {
      const leaf = createLeaf(terminal.id);
      tabs.push(terminal.id);
      layouts[terminal.id] = leaf;
      focusedPanes[terminal.id] = leaf.id;
      currentTabRoot = terminal.id;
    } else if (terminal.layoutHint === 'split-right' || terminal.layoutHint === 'split-bottom') {
      const direction: SplitDirection =
        terminal.layoutHint === 'split-right' ? 'vertical' : 'horizontal';
      const focusedPaneId = focusedPanes[currentTabRoot];
      const layout = layouts[currentTabRoot];
      if (layout && focusedPaneId) {
        const newLayout = splitLeaf(layout, focusedPaneId, direction, terminal.id);
        const newLeaf = findPaneByTerminalId(newLayout, terminal.id);
        layouts[currentTabRoot] = newLayout;
        focusedPanes[currentTabRoot] = newLeaf?.id ?? focusedPaneId;
      }
    }

    if (terminal.id === primaryTerminalId) {
      activeTab = currentTabRoot;
    }
  }

  return { tabs, layouts, focusedPanes, activeTab };
}

export function hydratePersistedWorkspaceLayout(
  layout: NonNullable<Workspace['terminalLayout']>
): WorkspaceLayoutHydration | null {
  const layouts = layout.layouts as Record<string, LayoutNode>;
  const tabs: string[] = [];
  const focusedPanes: Record<string, PaneId> = {};

  for (const tabId of layout.tabs) {
    const tabLayout = layouts[tabId];
    const firstLeaf = tabLayout ? getAllLeaves(tabLayout)[0] : undefined;
    if (!firstLeaf) continue;
    tabs.push(tabId);
    focusedPanes[tabId] = firstLeaf.id;
  }

  if (tabs.length === 0) return null;
  const activeTab =
    layout.activeTab && tabs.includes(layout.activeTab) ? layout.activeTab : tabs[0];
  return { tabs, layouts, focusedPanes, activeTab };
}

/**
 * Takes a layout arranged elsewhere, e.g. on another device, keeping what the
 * window shows of `current`: the tab shown and each tab's focused pane where
 * they still are, and panes of `terminalIds` the layout lacks, e.g. one opened
 * here moments ago, as tabs of their own.
 */
export function keepWorkspaceLayoutView(
  arranged: WorkspaceLayoutHydration,
  current: Omit<WorkspaceLayoutHydration, 'activeTab'> & { activeTab?: string },
  terminalIds: Set<string>
): WorkspaceLayoutHydration {
  const tabs = [...arranged.tabs];
  const layouts = { ...arranged.layouts };
  const focusedPanes = { ...arranged.focusedPanes };
  const shown = new Set(
    tabs.flatMap((tabId) => getAllLeaves(layouts[tabId]).map((leaf) => leaf.terminalId))
  );
  for (const tabId of current.tabs) {
    const layout = current.layouts[tabId];
    for (const leaf of layout ? getAllLeaves(layout) : []) {
      if (shown.has(leaf.terminalId) || !terminalIds.has(leaf.terminalId)) continue;
      if (layouts[leaf.terminalId]) continue;
      shown.add(leaf.terminalId);
      tabs.push(leaf.terminalId);
      layouts[leaf.terminalId] = leaf;
      focusedPanes[leaf.terminalId] = leaf.id;
    }
  }

  const focusedTerminal = (tabId: string | undefined): string | undefined => {
    const layout = tabId ? current.layouts[tabId] : undefined;
    const paneId = tabId ? current.focusedPanes[tabId] : undefined;
    const pane = layout && paneId ? findNode(layout, paneId) : null;
    return pane?.type === 'leaf' ? pane.terminalId : undefined;
  };
  const paneShowing = (tabId: string, terminalId: string | undefined) =>
    terminalId ? findPaneByTerminalId(layouts[tabId], terminalId) : null;
  for (const tabId of tabs) {
    const pane = paneShowing(tabId, focusedTerminal(tabId));
    if (pane) focusedPanes[tabId] = pane.id;
  }

  if (current.activeTab && tabs.includes(current.activeTab)) {
    return { tabs, layouts, focusedPanes, activeTab: current.activeTab };
  }
  // The tab shown is gone: show the one its focused pane moved to.
  const terminalId = focusedTerminal(current.activeTab);
  const activeTab = tabs.find((tabId) => paneShowing(tabId, terminalId));
  if (!activeTab) return { tabs, layouts, focusedPanes, activeTab: arranged.activeTab };
  focusedPanes[activeTab] = paneShowing(activeTab, terminalId)!.id;
  return { tabs, layouts, focusedPanes, activeTab };
}
