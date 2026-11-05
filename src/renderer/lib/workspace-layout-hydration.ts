import {
  createLeaf,
  findNode,
  findPaneByTerminalId,
  getAllLeaves,
  splitLeaf,
} from './layout-utils';

import type { Terminal, Workspace } from '../types';
import type { LayoutNode, PaneId, SplitDirection } from '../types/layout';

export interface WorkspaceLayoutHydration {
  tabs: string[];
  layouts: Record<string, LayoutNode>;
  focusedPanes: Record<string, PaneId>;
  activeTab: string;
}

/**
 * Whether a pane's terminal is a new workspace's placeholder: until its first terminal arrives, a
 * workspace's one pane is keyed by the workspace's own ID, with no PTY behind it.
 */
export function isWorkspacePlaceholderTerminal(
  workspaceId: string | null | undefined,
  terminalId: string
): boolean {
  return !!workspaceId && terminalId === workspaceId;
}

export function isWorkspaceLayoutPlaceholder(
  workspaceId: string,
  tabs: string[] | undefined
): boolean {
  return tabs?.length === 1 && isWorkspacePlaceholderTerminal(workspaceId, tabs[0]);
}

/**
 * The workspace's terminals and the panes its Setup run opened besides them, in launch order:
 * each pane goes after the terminals that launched before it.
 */
function setupLayoutItems(
  workspace: Pick<Workspace, 'terminals' | 'setupPanes'>
): { id: string; layoutHint?: Terminal['layoutHint'] }[] {
  const panes = workspace.setupPanes ?? [];
  const items: { id: string; layoutHint?: Terminal['layoutHint'] }[] = [];
  workspace.terminals.forEach((terminal, index) => {
    items.push(...panes.filter((pane) => pane.afterTerminals === index));
    items.push(terminal);
  });
  // A pane after terminals that haven't started yet, as an SSH workspace's, goes last.
  items.push(...panes.filter((pane) => pane.afterTerminals >= workspace.terminals.length));
  return items;
}

export function buildWorkspaceLayoutHydration(
  workspace: Pick<Workspace, 'terminals' | 'primaryTerminalId' | 'setupPanes'>
): WorkspaceLayoutHydration | null {
  // Setup's panes wait for a terminal: one that starts later finds no place in a layout without.
  if (workspace.terminals.length === 0) return null;
  const [root, ...rest] = setupLayoutItems(workspace);
  if (!root) return null;

  const rootLeaf = createLeaf(root.id);
  const tabs = [root.id];
  const layouts: Record<string, LayoutNode> = { [root.id]: rootLeaf };
  const focusedPanes: Record<string, PaneId> = { [root.id]: rootLeaf.id };
  const primaryTerminalId = workspace.primaryTerminalId ?? workspace.terminals[0]?.id;
  let activeTab = root.id;
  let currentTabRoot = root.id;

  for (const item of rest) {
    if (item.layoutHint === 'tab') {
      const leaf = createLeaf(item.id);
      tabs.push(item.id);
      layouts[item.id] = leaf;
      focusedPanes[item.id] = leaf.id;
      currentTabRoot = item.id;
    } else if (item.layoutHint === 'split-right' || item.layoutHint === 'split-bottom') {
      const direction: SplitDirection =
        item.layoutHint === 'split-right' ? 'vertical' : 'horizontal';
      const focusedPaneId = focusedPanes[currentTabRoot];
      const layout = layouts[currentTabRoot];
      if (layout && focusedPaneId) {
        const newLayout = splitLeaf(layout, focusedPaneId, direction, item.id);
        const newLeaf = findPaneByTerminalId(newLayout, item.id);
        layouts[currentTabRoot] = newLayout;
        focusedPanes[currentTabRoot] = newLeaf?.id ?? focusedPaneId;
      }
    }

    if (item.id === primaryTerminalId) {
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
