/**
 * A pane can show a browser page, a note or a file instead of a terminal. Its
 * layout leaf then holds a surface id where a terminal id would go, so the
 * pane tree, tabs and drag-and-drop work for both without change.
 */
export const PANE_SURFACE_ID_PREFIX = 'surface:';

export type PaneSurfaceKind = 'browser' | 'note' | 'file';

export function isPaneSurfaceId(id: string): boolean {
  return id.startsWith(PANE_SURFACE_ID_PREFIX);
}

export function createPaneSurfaceId(kind: PaneSurfaceKind): string {
  return `${PANE_SURFACE_ID_PREFIX}${kind}:${crypto.randomUUID()}`;
}

/** What a surface id's pane shows, read from the id itself. */
export function getPaneSurfaceKind(id: string): PaneSurfaceKind | null {
  if (!isPaneSurfaceId(id)) return null;
  const kind = id.slice(PANE_SURFACE_ID_PREFIX.length).split(':')[0];
  return kind === 'browser' || kind === 'note' || kind === 'file' ? kind : null;
}

/**
 * A browser pane's tab id starts with its pane's surface id, so whatever hears
 * of a page by its tab, such as its SSH tunnel or a shortcut pressed in it,
 * knows which pane it belongs to.
 */
export function createPaneBrowserTabId(surfaceId: string, tabId: string): string {
  return `${surfaceId}/${tabId}`;
}

/** The surface id of the browser pane a tab belongs to, or null for a tab id of no pane. */
export function getPaneSurfaceIdOfTab(tabId: string): string | null {
  return isPaneSurfaceId(tabId) ? tabId.split('/')[0] : null;
}

/**
 * The browser a tab belongs to, which keys its reload, probe and SSH tunnel
 * state: its browser pane's surface id, else the workspace's id for a tab of no pane.
 */
export function getBrowserIdOfTab(workspaceId: string, tabId: string | undefined): string {
  return (tabId && getPaneSurfaceIdOfTab(tabId)) || workspaceId;
}
