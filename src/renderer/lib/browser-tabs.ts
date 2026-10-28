import { usePaneSurfacesStore } from '@/stores/pane-surfaces.store';
import { isLocalTerminalExecutionLocation } from '@/types';

import { parseBrowserUrl } from '../../shared/lib/browser-tabs';
import { isLoopbackUrl } from '../../shared/lib/loopback-url';
import { createPaneBrowserTabId } from '../../shared/lib/pane-surface-id';

import type { BrowserTabsSource, BrowserTabsState } from '../../shared/lib/browser-tabs';
import type { Workspace, WorkspaceBrowserTab } from '../../shared/types';

/**
 * Applies a change to a browser pane's tabs. A tab the change adds gets an id
 * that starts with the pane's surface id.
 */
export function updatePaneBrowserTabs(
  surfaceId: string,
  change: (tabs: BrowserTabsSource) => BrowserTabsState | null
): BrowserTabsState | null {
  const surface = usePaneSurfacesStore.getState().surfaces[surfaceId];
  if (surface?.kind !== 'browser') return null;
  const next = change(surface);
  if (
    !next ||
    (next.browserTabs === surface.browserTabs &&
      next.activeBrowserTabId === surface.activeBrowserTabId)
  ) {
    return null;
  }
  const paneTabId = (id: string) =>
    id.startsWith(`${surfaceId}/`) ? id : createPaneBrowserTabId(surfaceId, id);
  const tabs: BrowserTabsState = {
    browserTabs: next.browserTabs.map((tab) => ({ ...tab, id: paneTabId(tab.id) })),
    activeBrowserTabId: next.activeBrowserTabId && paneTabId(next.activeBrowserTabId),
  };
  usePaneSurfacesStore.getState().setBrowserTabs(surfaceId, tabs);
  return tabs;
}

/** What a tab shows as its name: the page title, else its host, else "New tab". */
export function getBrowserTabLabel(tab: WorkspaceBrowserTab): string {
  return tab.title || parseBrowserUrl(tab.url)?.host || 'New tab';
}

/**
 * Whether the tab shows a server on the SSH host, which loads through an SSH
 * tunnel, so the page's own URL is a port on this computer.
 */
export function isSshForwardedBrowserTab(
  workspace: Pick<Workspace, 'backend'> | undefined,
  tab: Pick<WorkspaceBrowserTab, 'url' | 'urlExecutionLocation'> | undefined
): boolean {
  return (
    workspace?.backend?.kind === 'ssh' &&
    !!tab &&
    !isLocalTerminalExecutionLocation(tab.urlExecutionLocation ?? 'workspace') &&
    isLoopbackUrl(tab.url)
  );
}
