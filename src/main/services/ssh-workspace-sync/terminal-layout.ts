import type { WorkspaceTerminalLayout } from '../../../shared/types/workspace';

/**
 * Keeps the tabs and panes of a saved or received layout that show `terminalIds`,
 * dropping anything malformed. A tab named after a terminal not among them takes
 * the name of its first pane's.
 */
export function normalizePersistedTerminalLayout(
  value: WorkspaceTerminalLayout | undefined,
  terminalIds: Set<string>
): WorkspaceTerminalLayout | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (!Array.isArray(value.tabs) || !value.layouts || typeof value.layouts !== 'object') {
    return undefined;
  }

  let activeTab: string | undefined;
  const tabs: string[] = [];
  const layouts: Record<string, unknown> = {};

  for (const originalTabId of value.tabs) {
    if (typeof originalTabId !== 'string') continue;
    const layout = prunePersistedLayoutNode(value.layouts[originalTabId], terminalIds);
    if (!layout) continue;
    const tabId = terminalIds.has(originalTabId)
      ? originalTabId
      : findFirstPersistedLeaf(layout)?.terminalId;
    if (!tabId || layouts[tabId]) continue;

    if (originalTabId === value.activeTab) activeTab = tabId;
    tabs.push(tabId);
    layouts[tabId] = layout;
  }

  if (tabs.length === 0) return undefined;
  return { tabs, layouts, ...(activeTab ? { activeTab } : {}) };
}

export interface PersistedLayoutLeaf {
  type: 'leaf';
  id: string;
  terminalId: string;
}

type PersistedLayoutNode =
  | PersistedLayoutLeaf
  | {
      type: 'split';
      id: string;
      direction: 'horizontal' | 'vertical';
      children: [PersistedLayoutNode, PersistedLayoutNode];
      sizes: [number, number];
    };

function prunePersistedLayoutNode(
  value: unknown,
  terminalIds: Set<string>
): PersistedLayoutNode | null {
  if (!value || typeof value !== 'object') return null;
  const node = value as Record<string, unknown>;
  if (typeof node['id'] !== 'string') return null;
  if (node['type'] === 'leaf') {
    return typeof node['terminalId'] === 'string' && terminalIds.has(node['terminalId'])
      ? { type: 'leaf', id: node['id'], terminalId: node['terminalId'] }
      : null;
  }
  if (node['type'] !== 'split') return null;
  if (node['direction'] !== 'horizontal' && node['direction'] !== 'vertical') return null;
  if (!Array.isArray(node['children']) || node['children'].length !== 2) return null;
  if (
    !Array.isArray(node['sizes']) ||
    node['sizes'].length !== 2 ||
    node['sizes'].some((size) => typeof size !== 'number' || !Number.isFinite(size))
  ) {
    return null;
  }
  const children = node['children']
    .map((child) => prunePersistedLayoutNode(child, terminalIds))
    .filter((child): child is PersistedLayoutNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return {
    type: 'split',
    id: node['id'],
    direction: node['direction'],
    children: [children[0], children[1]],
    sizes: [node['sizes'][0], node['sizes'][1]],
  };
}

function findFirstPersistedLeaf(node: PersistedLayoutNode): PersistedLayoutLeaf | undefined {
  return node.type === 'leaf' ? node : findFirstPersistedLeaf(node.children[0]);
}

/** The panes of a layout, tab by tab, skipping malformed ones. */
export function terminalLayoutLeaves(layout: WorkspaceTerminalLayout): PersistedLayoutLeaf[] {
  return layout.tabs.flatMap((tabId) => leavesOf(layout.layouts[tabId]));
}

function leavesOf(value: unknown): PersistedLayoutLeaf[] {
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  if (node['type'] === 'leaf') {
    return typeof node['id'] === 'string' && typeof node['terminalId'] === 'string'
      ? [{ type: 'leaf', id: node['id'], terminalId: node['terminalId'] }]
      : [];
  }
  return Array.isArray(node['children']) ? node['children'].flatMap(leavesOf) : [];
}

/** Adds each pane whose terminal the layout doesn't show as a tab of its own, named after it. */
export function withTerminalTabs(
  layout: WorkspaceTerminalLayout,
  leaves: PersistedLayoutLeaf[]
): WorkspaceTerminalLayout {
  const shown = new Set(terminalLayoutLeaves(layout).map((leaf) => leaf.terminalId));
  const tabs = [...layout.tabs];
  const layouts = { ...layout.layouts };
  for (const leaf of leaves) {
    if (shown.has(leaf.terminalId) || layouts[leaf.terminalId]) continue;
    shown.add(leaf.terminalId);
    tabs.push(leaf.terminalId);
    layouts[leaf.terminalId] = leaf;
  }
  return tabs.length === layout.tabs.length ? layout : { ...layout, tabs, layouts };
}

/**
 * How a layout arranges `terminalIds`: its tabs in order, each a tree of
 * terminals and splits. Pane and tab ids differ between installations, so
 * it leaves them out; the tab shown too.
 */
export function terminalArrangement(
  layout: WorkspaceTerminalLayout | undefined,
  terminalIds: Set<string>
): unknown[] | undefined {
  const kept = normalizePersistedTerminalLayout(layout, terminalIds);
  return kept?.tabs.map((tabId) => arrangementOf(kept.layouts[tabId] as PersistedLayoutNode));
}

function arrangementOf(node: PersistedLayoutNode): unknown {
  return node.type === 'leaf'
    ? node.terminalId
    : {
        direction: node.direction,
        sizes: node.sizes,
        children: node.children.map(arrangementOf),
      };
}
