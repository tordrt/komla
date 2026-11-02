import { create } from 'zustand';

import { statusCommandScope } from '../../shared/types/status-items';

import type { SidebarPanel, SidebarPanelList } from '../../shared/types/sidebar-panels';
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

interface SidebarPanelsState {
  /** Each workspace's panels, once listed. */
  lists: Record<string, SidebarPanelList>;
  /** Each panel's last page, by sidebarPanelKey. */
  pages: Record<string, SidebarPanelPage>;
}

export const useSidebarPanelsStore = create<SidebarPanelsState>(() => ({ lists: {}, pages: {} }));

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
