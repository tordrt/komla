import { isSavedPane, savedLayoutPanes } from '../../shared/lib/saved-layout';

import { createLeaf, generatePaneId, getAllLeaves, removePane } from './layout-utils';

import type { WorkspaceLayoutHydration } from './workspace-layout-hydration';
import type {
  Workspace,
  WorkspaceLayoutNode,
  WorkspaceLayoutPane,
  WorkspaceSavedLayout,
} from '../../shared/types';
import type { PaneSurface } from '@/stores/pane-surfaces.store';
import type { LayoutNode, PaneId } from '@/types/layout';

/** A tab's id without its pane's surface id, which a pane opened again doesn't keep. */
function savedTabId(surfaceId: string, tabId: string): string {
  return tabId.startsWith(`${surfaceId}/`) ? tabId.slice(surfaceId.length + 1) : tabId;
}

/**
 * The workspace's tabs as it saves them: its browsers and notes as they are, and the agent's and
 * Setup steps' terminals as the places the next start's terminals take. Other panes, such as a
 * file or a terminal opened by hand, don't open again, so they go. Nothing, without a browser or
 * a note to open again.
 */
export function toSavedLayout(
  workspace: Pick<Workspace, 'terminals' | 'primaryTerminalId'>,
  layout: { tabs: string[]; layouts: Record<string, LayoutNode>; activeTab?: string },
  surfaces: Record<string, PaneSurface>
): WorkspaceSavedLayout | undefined {
  const paneOf = (id: string): WorkspaceLayoutPane | undefined => {
    const surface = surfaces[id];
    if (surface?.kind === 'browser') {
      const { browserTabs } = surface;
      if (browserTabs.length === 0) return undefined;
      const active = browserTabs.some((tab) => tab.id === surface.activeBrowserTabId)
        ? surface.activeBrowserTabId
        : browserTabs[0].id;
      return {
        kind: 'browser',
        browserTabs: browserTabs.map((tab) => ({ ...tab, id: savedTabId(id, tab.id) })),
        activeBrowserTabId: active && savedTabId(id, active),
      };
    }
    if (surface?.kind === 'note') return { kind: 'note', name: surface.name };
    if (surface) return undefined;
    if (id === workspace.primaryTerminalId) return { kind: 'agent' };
    const stepId = workspace.terminals.find((terminal) => terminal.id === id)?.setupStepId;
    return stepId ? { kind: 'setup-step', stepId } : undefined;
  };
  const toNode = (node: LayoutNode): WorkspaceLayoutNode | null => {
    if (node.type === 'leaf') {
      const pane = paneOf(node.terminalId);
      return pane ? { type: 'leaf', pane } : null;
    }
    const [first, second] = node.children.map(toNode);
    if (!first || !second) return first ?? second;
    return {
      type: 'split',
      direction: node.direction,
      sizes: [...node.sizes],
      children: [first, second],
    };
  };
  const tabs: WorkspaceLayoutNode[] = [];
  let activeTab: number | undefined;
  for (const tabId of layout.tabs) {
    const root = layout.layouts[tabId];
    const node = root && toNode(root);
    if (!node) continue;
    if (tabId === layout.activeTab) activeTab = tabs.length;
    tabs.push(node);
  }
  if (!tabs.some((tab) => savedLayoutPanes(tab).some(isSavedPane))) return undefined;
  return { tabs, ...(activeTab === undefined ? {} : { activeTab }) };
}

/**
 * The layout `current` becomes with the workspace's saved one: each saved tab as it was, each pane
 * showing what `place` puts in its place (one of the terminals `current` shows, or a browser or
 * note opened again), and a place nothing takes gone. The terminals `current` shows that no saved
 * pane places, such as a Setup step added since, stay in its tabs, after the saved ones; the
 * agent's tab, if the saved layout had no place for it, comes first.
 */
export function restoreSavedLayout(
  saved: WorkspaceSavedLayout,
  current: WorkspaceLayoutHydration | null,
  place: (pane: WorkspaceLayoutPane) => string | undefined,
  agentId?: string
): WorkspaceLayoutHydration | null {
  const tabs: string[] = [];
  const layouts: Record<string, LayoutNode> = {};
  let activeTab: string | undefined;
  saved.tabs.forEach((tab, index) => {
    const root = restoreNode(tab, place);
    if (!root) return;
    // A tab is named after the pane it started with.
    const tabId = getAllLeaves(root)[0].terminalId;
    tabs.push(tabId);
    layouts[tabId] = root;
    if (index === saved.activeTab) activeTab = tabId;
  });
  if (tabs.length === 0) return current;

  const currentActive = addUnplacedTabs(current, tabs, layouts, agentId);
  return {
    tabs,
    layouts,
    focusedPanes: focusedPanesOf(tabs, layouts, current, agentId),
    activeTab: activeTab ?? currentActive ?? tabs[0],
  };
}

function restoreNode(
  node: WorkspaceLayoutNode,
  place: (pane: WorkspaceLayoutPane) => string | undefined
): LayoutNode | null {
  if (node.type === 'leaf') {
    const id = place(node.pane);
    return id ? createLeaf(id) : null;
  }
  const [first, second] = node.children.map((child) => restoreNode(child, place));
  if (!first || !second) return first ?? second;
  return {
    type: 'split',
    id: generatePaneId(),
    direction: node.direction,
    sizes: [...node.sizes],
    children: [first, second],
  };
}

/**
 * Adds the panes `current` shows that no saved pane placed, in its tabs after the saved ones, the
 * agent's first. Returns the tab that takes the place of `current`'s active one, if any.
 */
function addUnplacedTabs(
  current: WorkspaceLayoutHydration | null,
  tabs: string[],
  layouts: Record<string, LayoutNode>,
  agentId: string | undefined
): string | undefined {
  const shown = new Set(Object.values(layouts).flatMap((root) => leafIds(root)));
  let activeTab: string | undefined;
  for (const tabId of current?.tabs ?? []) {
    const root = withoutPanes(current?.layouts[tabId], shown);
    if (!root) continue;
    const id = layouts[tabId] ? getAllLeaves(root)[0].terminalId : tabId;
    if (layouts[id]) continue;
    if (agentId && leafIds(root).includes(agentId)) tabs.unshift(id);
    else tabs.push(id);
    layouts[id] = root;
    if (tabId === current?.activeTab) activeTab = id;
  }
  return activeTab;
}

/** The tab without the panes showing `ids`, or nothing once none is left. */
function withoutPanes(root: LayoutNode | undefined, ids: Set<string>): LayoutNode | null {
  let rest: LayoutNode | null = root ?? null;
  for (const leaf of root ? getAllLeaves(root) : []) {
    if (rest && ids.has(leaf.terminalId)) rest = removePane(rest, leaf.id);
  }
  return rest;
}

function focusedPanesOf(
  tabs: string[],
  layouts: Record<string, LayoutNode>,
  current: WorkspaceLayoutHydration | null,
  agentId: string | undefined
): Record<string, PaneId> {
  const focusedPanes: Record<string, PaneId> = {};
  for (const tabId of tabs) {
    const leaves = getAllLeaves(layouts[tabId]);
    const focused = current?.focusedPanes[tabId];
    focusedPanes[tabId] =
      leaves.find((leaf) => leaf.id === focused)?.id ??
      leaves.find((leaf) => leaf.terminalId === agentId)?.id ??
      leaves[0].id;
  }
  return focusedPanes;
}

function leafIds(root: LayoutNode): string[] {
  return getAllLeaves(root).map((leaf) => leaf.terminalId);
}
