import { MAX_BROWSER_PANES, normalizeBrowserPane } from './browser-tabs';
import { NOTE_NAME_PATTERN } from './notes';

import type {
  WorkspaceLayoutNode,
  WorkspaceLayoutPane,
  WorkspaceSavedLayout,
} from '../types/workspace';

/** The most panes a saved layout keeps, across all its tabs. */
export const MAX_SAVED_LAYOUT_PANES = 64;
const MAX_SETUP_STEP_ID_LENGTH = 256;

/** The panes of a saved layout's tab, left to right and top to bottom. */
export function savedLayoutPanes(node: WorkspaceLayoutNode): WorkspaceLayoutPane[] {
  return node.type === 'leaf'
    ? [node.pane]
    : [...savedLayoutPanes(node.children[0]), ...savedLayoutPanes(node.children[1])];
}

/** Whether a pane opens again as it was, rather than giving its place to a terminal. */
export function isSavedPane(pane: WorkspaceLayoutPane): boolean {
  return pane.kind === 'browser' || pane.kind === 'note';
}

/**
 * The saved layout worth keeping from a saved or sent one: malformed panes go, and a split left
 * with one side becomes that side. Nothing is kept without a browser or a note, which is all a
 * saved layout opens again.
 */
export function normalizeSavedLayout(value: unknown): WorkspaceSavedLayout | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { tabs: rawTabs, activeTab } = value as Record<string, unknown>;
  if (!Array.isArray(rawTabs)) return undefined;
  const budget = { panes: MAX_SAVED_LAYOUT_PANES, browsers: MAX_BROWSER_PANES };
  const tabs: WorkspaceLayoutNode[] = [];
  let active: number | undefined;
  rawTabs.forEach((rawTab, index) => {
    const tab = normalizeNode(rawTab, budget, MAX_SAVED_LAYOUT_PANES);
    if (!tab) return;
    if (index === activeTab) active = tabs.length;
    tabs.push(tab);
  });
  if (!tabs.some((tab) => savedLayoutPanes(tab).some(isSavedPane))) return undefined;
  return { tabs, ...(active === undefined ? {} : { activeTab: active }) };
}

function normalizeNode(
  value: unknown,
  budget: { panes: number; browsers: number },
  depth: number
): WorkspaceLayoutNode | null {
  if (!value || typeof value !== 'object' || depth <= 0) return null;
  const node = value as Record<string, unknown>;
  if (node['type'] === 'leaf') {
    if (budget.panes <= 0) return null;
    const pane = normalizePane(node['pane'], budget);
    if (!pane) return null;
    budget.panes -= 1;
    return { type: 'leaf', pane };
  }
  if (node['type'] !== 'split') return null;
  const { direction, sizes, children } = node;
  if (direction !== 'horizontal' && direction !== 'vertical') return null;
  if (!Array.isArray(children) || children.length !== 2) return null;
  const kept = children
    .map((child) => normalizeNode(child, budget, depth - 1))
    .filter((child): child is WorkspaceLayoutNode => child !== null);
  if (kept.length < 2) return kept[0] ?? null;
  return {
    type: 'split',
    direction,
    sizes:
      Array.isArray(sizes) &&
      sizes.length === 2 &&
      sizes.every((size) => typeof size === 'number' && Number.isFinite(size) && size > 0)
        ? [sizes[0], sizes[1]]
        : [50, 50],
    children: [kept[0], kept[1]],
  };
}

function normalizePane(
  value: unknown,
  budget: { browsers: number }
): WorkspaceLayoutPane | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const pane = value as Record<string, unknown>;
  switch (pane['kind']) {
    case 'browser': {
      if (budget.browsers <= 0) return undefined;
      const browser = normalizeBrowserPane(pane);
      if (!browser) return undefined;
      budget.browsers -= 1;
      return { kind: 'browser', ...browser };
    }
    case 'note':
      return typeof pane['name'] === 'string' && NOTE_NAME_PATTERN.test(pane['name'])
        ? { kind: 'note', name: pane['name'] }
        : undefined;
    case 'agent':
      return { kind: 'agent' };
    case 'setup-step': {
      const { stepId } = pane;
      return typeof stepId === 'string' && stepId && stepId.length <= MAX_SETUP_STEP_ID_LENGTH
        ? { kind: 'setup-step', stepId }
        : undefined;
    }
    default:
      return undefined;
  }
}
