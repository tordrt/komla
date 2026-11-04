import { create } from 'zustand';

import { statusCommandScope } from '../../shared/types/status-items';

import type {
  SidebarPanel,
  SidebarPanelList,
  SidebarPanelState,
} from '../../shared/types/sidebar-panels';
import type { StatusPopoverContent } from '../../shared/types/status-items';

/** How long a panel's last HTML page shows again on opening; Komla serves it for an hour. */
const REUSE_HTML_PAGE_MS = 30 * 60_000;

/** What a panel's page last showed, to show at once when it opens again. */
interface SidebarPanelPage {
  content: StatusPopoverContent | null;
  /** When its run started, as Komla serves an HTML page for a while only. */
  ranAt: number;
  /** The theme an HTML page was made with, as readPopoverTheme read it. */
  theme: string;
}

/** What a page panel's command printed last, for its page as it loads again. */
export interface SidebarPanelPageData {
  data?: unknown;
  error?: string;
}

interface SidebarPanelsState {
  /** Each workspace's panels, once listed. */
  lists: Record<string, SidebarPanelList>;
  /** Each panel's last page, by sidebarPanelKey. */
  pages: Record<string, SidebarPanelPage>;
  /** Each page panel's last data, by sidebarPanelKey. */
  data: Record<string, SidebarPanelPageData>;
  /**
   * The data plugin code posted for panels, by sidebarPanelStateKey. An empty workspace id stands
   * for every workspace.
   */
  states: Record<string, SidebarPanelState>;
}

export const useSidebarPanelsStore = create<SidebarPanelsState>(() => ({
  lists: {},
  pages: {},
  data: {},
  states: {},
}));

const sidebarPanelStateKey = (workspaceId: string, id: string) => `${workspaceId}\0${id}`;

function keepSidebarPanelState(state: SidebarPanelState): void {
  useSidebarPanelsStore.setState((current) => {
    const states = { ...current.states };
    const key = sidebarPanelStateKey(state.workspaceId, state.id);
    const before = states[key];
    if (state.data === undefined) delete states[key];
    // The same data as before stays the same object, so the page isn't sent it again.
    else if (before?.data && before.revision === state.revision) {
      states[key] = { ...state, data: before.data };
    } else states[key] = state;
    return { states };
  });
}

let followingStates = false;

/** Follows the data plugin code posts for panels, from the first window that asks. */
export function followSidebarPanelStates(): void {
  if (followingStates) return;
  followingStates = true;
  window.api.onSidebarPanelStateChange(keepSidebarPanelState);
  void window.api
    .listSidebarPanelStates()
    .then((states) => {
      for (const state of states) keepSidebarPanelState(state);
    })
    .catch(() => {});
}

/** A panel's state in a workspace: its own, or else the one for every workspace. */
export function useSidebarPanelState(
  workspaceId: string,
  id: string | undefined
): SidebarPanelState | undefined {
  return useSidebarPanelsStore((s) =>
    id === undefined
      ? undefined
      : (s.states[sidebarPanelStateKey(workspaceId, id)] ?? s.states[sidebarPanelStateKey('', id)])
  );
}

export function keepSidebarPanelData(key: string, data: SidebarPanelPageData): void {
  useSidebarPanelsStore.setState((state) => ({ data: { ...state.data, [key]: data } }));
}

/** A panel's key in a workspace; one that runs on this computer shows the same in every one. */
export const sidebarPanelKey = (workspaceId: string, panel: Pick<SidebarPanel, 'id' | 'runOn'>) =>
  `${statusCommandScope(workspaceId, panel)}\0${panel.id}`;

// A listing that resolves after a newer one started is stale.
const listGeneration = new Map<string, number>();

/** Lists a workspace's panels again, keeping the list it had while they stay the same. */
export async function loadSidebarPanels(workspaceId: string): Promise<void> {
  const generation = (listGeneration.get(workspaceId) ?? 0) + 1;
  listGeneration.set(workspaceId, generation);
  const list = await window.api.listSidebarPanels(workspaceId);
  if (listGeneration.get(workspaceId) !== generation) return;
  const previous = useSidebarPanelsStore.getState().lists[workspaceId];
  if (previous && JSON.stringify(previous) === JSON.stringify(list)) return;
  useSidebarPanelsStore.setState((state) => ({ lists: { ...state.lists, [workspaceId]: list } }));
}

/** What a panel's page showed last time, if it can show again in this theme. */
export function cachedSidebarPanelPage(key: string, theme: string): StatusPopoverContent | null {
  const page = useSidebarPanelsStore.getState().pages[key];
  if (!page?.content) return null;
  if (
    page.content.htmlUrl &&
    (Date.now() - page.ranAt > REUSE_HTML_PAGE_MS || page.theme !== theme)
  ) {
    return null;
  }
  return page.content;
}

export function keepSidebarPanelPage(
  key: string,
  content: StatusPopoverContent | null,
  ranAt: number,
  theme: string
): void {
  useSidebarPanelsStore.setState((state) => ({
    pages: { ...state.pages, [key]: { content, ranAt, theme } },
  }));
}
