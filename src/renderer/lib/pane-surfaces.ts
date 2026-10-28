import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useDevServerPreviewStore } from '@/stores/dev-server-preview.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useLayoutStore } from '@/stores/layout.store';
import { useNotesStore } from '@/stores/notes.store';
import { usePaneSurfacesStore, type PaneSurface } from '@/stores/pane-surfaces.store';
import { useTerminalCloseStore } from '@/stores/terminal-close.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import {
  addBrowserTab,
  closeBrowserTab,
  getActiveBrowserTab,
  getBrowserTabs,
  isBrowserUrl,
  normalizeBrowserPanes,
  openUrlInNewBrowserTab,
} from '../../shared/lib/browser-tabs';
import { getPaneSurfaceIdOfTab, isPaneSurfaceId } from '../../shared/lib/pane-surface-id';
import { describeUnsavedFiles } from '../../shared/lib/unsaved-files';
import { getWorkspaceDisplayTitle } from '../../shared/lib/workspace-title';

import { getBrowserTabLabel, updatePaneBrowserTabs } from './browser-tabs';
import { pathAfterMove, type FileTreeMove } from './file-tree-moves';
import { findPaneByTerminalId, getAllLeaves, showsPaneSurface } from './layout-utils';
import { UNTITLED_NOTE } from './notes';
import { addLocalCopyTerminal, addTerminalForSplit } from './split-terminal';
import { isWorkspaceLayoutPlaceholder } from './workspace-layout-hydration';

import type { WorkspaceBrowserPane } from '../../shared/types';
import type { NoteSummary } from '../../shared/types/notes';
import type { TerminalExecutionLocation } from '../../shared/types/terminal';
import type { ConfirmRequest } from '@/components/terminal/useConfirmDialog';
import type { PaneId, SplitDirection } from '@/types/layout';

/** Where a new surface opens: a tab of its own, or split beside a pane of the active tab. */
export type PaneSurfacePlacement =
  | { kind: 'tab' }
  | { kind: 'split'; direction: SplitDirection; paneId?: PaneId };

export function openPaneSurface(
  workspaceId: string,
  surface: PaneSurface,
  placement: PaneSurfacePlacement
): string {
  const id = usePaneSurfacesStore.getState().addSurface(surface);
  whenPanesUncovered(
    workspaceId,
    () => {
      const layout = useLayoutStore.getState();
      const activeTabId = layout.activeTabByWorkspace[workspaceId];
      if (placement.kind === 'tab' || !activeTabId) {
        layout.addTab(workspaceId, id);
        layout.showTabInFullPane(id);
        return;
      }
      const paneId = placement.paneId ?? layout.focusedPaneByTab[workspaceId]?.[activeTabId];
      layout.splitPane(
        placement.direction,
        id,
        paneId ? { workspaceId, tabId: activeTabId, paneId } : undefined
      );
    },
    () => forgetPaneSurface(id)
  );
  return id;
}

/**
 * Runs `open` once the file panel doesn't cover the panes, closing it when, in Full layout, it
 * does. Unsaved edits in it ask first: discarding them runs `open`, keeping them runs `cancel`.
 */
function whenPanesUncovered(workspaceId: string, open: () => void, cancel?: () => void): void {
  const fileViewer = useFileViewerStore.getState();
  const isCovered = () => {
    const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace[workspaceId];
    return !!preview?.open && (preview.layout ?? 'full') === 'full';
  };
  if (isCovered()) fileViewer.requestInlineFilePreviewClose(workspaceId);
  if (!isCovered()) {
    open();
    return;
  }
  const unsubscribe = useFileViewerStore.subscribe((state) => {
    if (state.inlineFilePreviewPendingCloseByWorkspace[workspaceId]) return;
    unsubscribe();
    // Discarding clears the question before it closes the panel, in the same task.
    queueMicrotask(() => (isCovered() ? cancel?.() : open()));
  });
}

/** Opens a browser with one tab, blank or at `url`, which a link printed where `urlExecutionLocation` says. */
export function openBrowserPane(
  workspaceId: string,
  placement: PaneSurfacePlacement,
  url = '',
  urlExecutionLocation?: TerminalExecutionLocation
): string {
  // As in openInBrowserPane, anything but a web page opens a blank tab.
  const page = isBrowserUrl(url.trim()) ? url.trim() : '';
  const id = openPaneSurface(
    workspaceId,
    { kind: 'browser', workspaceId, browserTabs: [], activeBrowserTabId: undefined },
    placement
  );
  updatePaneBrowserTabs(id, (tabs) => addBrowserTab(tabs, page, urlExecutionLocation));
  return id;
}

/**
 * The surface id of the workspace's first browser pane, in the tab on screen if that has one,
 * else in its other tabs.
 */
function findBrowserPane(workspaceId: string): string | null {
  const layout = useLayoutStore.getState();
  const active = layout.activeTabByWorkspace[workspaceId];
  const tabs = [...(layout.tabsByWorkspace[workspaceId] ?? [])].sort(
    (a, b) => Number(b === active) - Number(a === active)
  );
  const { surfaces } = usePaneSurfacesStore.getState();
  for (const tabId of tabs) {
    const root = layout.layoutsByTab[workspaceId]?.[tabId];
    const leaf =
      root && getAllLeaves(root).find((pane) => surfaces[pane.terminalId]?.kind === 'browser');
    if (leaf) return leaf.terminalId;
  }
  return null;
}

// Pages opened in a workspace before its terminal had a tab, which open once it has one.
const pagesAwaitingTerminal = new Map<
  string,
  { url: string; urlExecutionLocation?: TerminalExecutionLocation }[]
>();

/**
 * Whether the workspace's terminal is yet to get its tab: the workspace is still being set up, or
 * this window hasn't loaded it. Setting up its terminal's tab replaces any tab opened before then.
 */
function awaitsTerminalTab(workspaceId: string): boolean {
  const tabs = useLayoutStore.getState().tabsByWorkspace[workspaceId];
  if (isWorkspaceLayoutPlaceholder(workspaceId, tabs)) return true;
  if (tabs?.length) return false;
  const workspace = useWorkspacesStore
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId);
  return !workspace || !!workspace.provisioning;
}

/**
 * Opens a page in Komla: in a new tab of the workspace's browser, the one in the tab on screen
 * first, else in a browser in a tab of its own, never split beside other panes. Shows that browser
 * and focuses it. Without a page, it shows the browser as it is, or a new one with a blank tab that
 * looks for the workspace's server. Returns the browser's surface id, or null when the page waits
 * for the workspace's terminal to get its tab, or for unsaved edits in the file panel to go.
 */
export function openInBrowserPane(
  workspaceId: string,
  url = '',
  urlExecutionLocation?: TerminalExecutionLocation
): string | null {
  // Anything but a web page, such as a file: URL, opens a blank tab.
  const page = isBrowserUrl(url.trim()) ? url.trim() : '';
  const layout = useLayoutStore.getState();
  if (!layout.tabsByWorkspace[workspaceId]?.length) {
    // A workspace not shown yet gets its terminal's tab first, which showing it would otherwise
    // set up in place of the browser's. Its saved browsers come back with it.
    const terminal = useWorkspacesStore
      .getState()
      .workspaces.find((workspace) => workspace.id === workspaceId)?.terminals[0];
    if (terminal) layout.initializeWorkspaceLayout(workspaceId, terminal.id);
  }
  if (awaitsTerminalTab(workspaceId)) {
    const pages = pagesAwaitingTerminal.get(workspaceId) ?? [];
    pagesAwaitingTerminal.set(workspaceId, [...pages, { url, urlExecutionLocation }]);
    return null;
  }
  let shown: string | null = null;
  whenPanesUncovered(workspaceId, () => {
    // Without a terminal, its saved browsers come back before the page opens in one of them.
    if (!useLayoutStore.getState().tabsByWorkspace[workspaceId]?.length) {
      restoreBrowserPanes(workspaceId);
    }
    shown = showPageInBrowserPane(workspaceId, page, urlExecutionLocation);
  });
  return shown;
}

function showPageInBrowserPane(
  workspaceId: string,
  page: string,
  urlExecutionLocation?: TerminalExecutionLocation
): string {
  const found = findBrowserPane(workspaceId);
  if (found) {
    if (page) {
      updatePaneBrowserTabs(found, (tabs) =>
        openUrlInNewBrowserTab(tabs, page, urlExecutionLocation)
      );
    }
    useLayoutStore.getState().revealTerminal(workspaceId, found);
    return found;
  }
  const id = usePaneSurfacesStore.getState().addSurface({
    kind: 'browser',
    workspaceId,
    browserTabs: [],
    activeBrowserTabId: undefined,
  });
  updatePaneBrowserTabs(id, (tabs) => addBrowserTab(tabs, page, urlExecutionLocation));
  useLayoutStore.getState().addTab(workspaceId, id);
  useLayoutStore.getState().revealTerminal(workspaceId, id);
  return id;
}

/** Starts a note and opens it in a pane. Returns whether it opened. */
export async function openNewNotePane(
  workspaceId: string,
  placement: PaneSurfacePlacement
): Promise<boolean> {
  let note: NoteSummary;
  try {
    note = await useNotesStore.getState().create(workspaceId);
  } catch (error) {
    useToastStore
      .getState()
      .addToast(`Couldn't start a note: ${(error as Error).message}`, 'error');
    return false;
  }
  openPaneSurface(workspaceId, { kind: 'note', workspaceId, name: note.name }, placement);
  return true;
}

/** Opens a workspace file in a pane, at a line if given. */
export function openFilePane(
  workspaceId: string,
  path: string,
  placement: PaneSurfacePlacement,
  lineNumber?: number
): string {
  const id = openPaneSurface(workspaceId, { kind: 'file', workspaceId, path }, placement);
  openingFilePanes.set(id, { lineNumber });
  return id;
}

// File panes whose editor hasn't shown yet, with the line each opens at.
const openingFilePanes = new Map<string, { lineNumber?: number }>();

/**
 * How a new file pane's editor first shows: focused, at its line. Returned once,
 * so a pane that remounts stays where it was.
 */
export function takeFilePaneOpening(surfaceId: string): { lineNumber?: number } | undefined {
  const opening = openingFilePanes.get(surfaceId);
  openingFilePanes.delete(surfaceId);
  return opening;
}

// The unsaved text of each file pane. It outlives the pane's editor, which remounts
// whenever the layout around it changes.
const fileDrafts = new Map<string, string>();

export function getFilePaneDraft(surfaceId: string): string | undefined {
  return fileDrafts.get(surfaceId);
}

/** Keeps a file pane's unsaved text, or forgets it once saved or discarded (null). */
export function setFilePaneDraft(surfaceId: string, draft: string | null): void {
  if (draft === null) fileDrafts.delete(surfaceId);
  else fileDrafts.set(surfaceId, draft);
  usePaneSurfacesStore.getState().setFileDirty(surfaceId, draft !== null);
}

/** Whether a file pane other than `exceptSurfaceId` has unsaved edits to the file. */
export function hasUnsavedFilePane(
  surfaces: Record<string, PaneSurface>,
  workspaceId: string,
  path: string | null,
  exceptSurfaceId?: string
): boolean {
  return Object.entries(surfaces).some(
    ([id, surface]) =>
      id !== exceptSurfaceId &&
      surface.kind === 'file' &&
      !!surface.dirty &&
      surface.workspaceId === workspaceId &&
      surface.path === path
  );
}

/** The files that a workspace's file panes have unsaved edits to. */
export function getUnsavedFilePanePaths(workspaceId: string): string[] {
  return Object.values(usePaneSurfacesStore.getState().surfaces).flatMap((surface) =>
    surface.kind === 'file' && surface.dirty && surface.workspaceId === workspaceId
      ? [surface.path]
      : []
  );
}

/** Points a workspace's file panes at where a file tree move put their files. */
export function followMovedFilePanes(workspaceId: string, move: FileTreeMove): void {
  const { surfaces, setFilePath } = usePaneSurfacesStore.getState();
  for (const [id, surface] of Object.entries(surfaces)) {
    if (surface.kind !== 'file' || surface.workspaceId !== workspaceId) continue;
    const path = pathAfterMove(surface.path, move);
    if (path) setFilePath(id, path);
  }
}

type PaneCloseConfirm = (request: ConfirmRequest) => Promise<boolean>;
let paneCloseConfirm: PaneCloseConfirm | null = null;

/**
 * Lets the app's one dialog ask before a pane's unsaved edits are thrown away, or before closing
 * a workspace's last pane stops it. Returns the unregister function.
 */
export function registerPaneCloseConfirm(confirm: PaneCloseConfirm): () => void {
  paneCloseConfirm = confirm;
  return () => {
    if (paneCloseConfirm === confirm) paneCloseConfirm = null;
  };
}

/** Asks before panes with unsaved edits close. Resolves whether to go ahead. */
export async function confirmClosingPaneSurfaces(surfaceIds: string[]): Promise<boolean> {
  const { surfaces } = usePaneSurfacesStore.getState();
  const names = surfaceIds.flatMap((id) => {
    const surface = surfaces[id];
    return surface?.kind === 'file' && surface.dirty ? [getFileName(surface.path)] : [];
  });
  return confirmDiscardingUnsavedFiles(names);
}

/** Asks before unsaved edits to the named files are thrown away. Resolves whether to go ahead. */
export async function confirmDiscardingUnsavedFiles(names: string[]): Promise<boolean> {
  if (names.length === 0) return true;
  // Without a dialog to ask in, the edits are kept.
  if (!paneCloseConfirm) return false;
  return paneCloseConfirm({
    title: 'Unsaved Changes',
    description: describeUnsavedFiles(names),
    confirmLabel: 'Discard',
  });
}

/**
 * Whether closing these terminal, browser, note or file panes stops their workspace: no other
 * terminal is left, and no other pane, counting terminals already closing as gone.
 */
export function closingPanesStopsWorkspace(
  workspaceId: string,
  paneIds: readonly string[]
): boolean {
  const workspace = useWorkspacesStore
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return false;
  const closing = new Set([...paneIds, ...useTerminalCloseStore.getState().closingTerminalIds]);
  const layouts = useLayoutStore.getState().layoutsByTab[workspaceId] ?? {};
  return (
    workspace.terminals.every((terminal) => closing.has(terminal.id)) &&
    !Object.values(layouts).some((root) =>
      getAllLeaves(root).some(
        (leaf) => isPaneSurfaceId(leaf.terminalId) && !closing.has(leaf.terminalId)
      )
    )
  );
}

/**
 * Asks before closing a workspace's last panes stops it, naming the workspace in case the view
 * moved on while the dialog was open. Resolves whether to go ahead.
 */
export async function confirmStoppingWorkspace(workspaceId: string): Promise<boolean> {
  const workspace = useWorkspacesStore
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId);
  // Without a dialog to ask in, the panes close as they always have.
  if (!paneCloseConfirm || !workspace) return true;
  const title = shortenTitle(getWorkspaceDisplayTitle(workspace));
  return paneCloseConfirm({
    title: 'Stop Workspace?',
    description: `Nothing else is open in "${title}", so closing this stops it.`,
    confirmLabel: 'Stop Workspace',
    // A stopped workspace starts again, so Enter may confirm.
    focusConfirm: true,
  });
}

/**
 * The names of the files with unsaved edits in file panes or the file panel, of the given
 * workspaces or of all this window shows.
 */
export function getUnsavedFileNames(workspaceIds?: readonly string[]): string[] {
  const includes = (workspaceId: string) => !workspaceIds || workspaceIds.includes(workspaceId);
  const paneFiles = Object.values(usePaneSurfacesStore.getState().surfaces).flatMap((surface) =>
    surface.kind === 'file' && surface.dirty && includes(surface.workspaceId) ? [surface.path] : []
  );
  const panelFiles = Object.entries(
    useFileViewerStore.getState().inlineFilePreviewByWorkspace
  ).flatMap(([workspaceId, preview]) =>
    preview.open && preview.isDirty && preview.filePath && includes(workspaceId)
      ? [preview.filePath]
      : []
  );
  return [...paneFiles, ...panelFiles].map(getFileName);
}

/**
 * Tells main which files this window has unsaved edits to, so closing the window or quitting
 * asks first. Returns the unsubscribe function.
 */
export function reportUnsavedFiles(): () => void {
  let reported: string | null = null;
  const report = () => {
    const names = getUnsavedFileNames();
    const key = names.join('\n');
    if (key === reported) return;
    reported = key;
    window.api.setUnsavedFiles(names);
  };
  report();
  const stopWatchingPanes = usePaneSurfacesStore.subscribe((state, previous) => {
    if (state.surfaces !== previous.surfaces) report();
  });
  const stopWatchingPanel = useFileViewerStore.subscribe((state, previous) => {
    if (state.inlineFilePreviewByWorkspace !== previous.inlineFilePreviewByWorkspace) report();
  });
  return () => {
    stopWatchingPanes();
    stopWatchingPanel();
  };
}

/**
 * Closes a surface's pane once any unsaved edits in it may go, and its workspace may stop when
 * it was the last pane. Resolves whether it closed.
 */
export async function requestClosePaneSurface(
  workspaceId: string,
  surfaceId: string
): Promise<boolean> {
  if (!(await confirmClosingPaneSurfaces([surfaceId]))) return false;
  if (
    closingPanesStopsWorkspace(workspaceId, [surfaceId]) &&
    !(await confirmStoppingWorkspace(workspaceId))
  ) {
    return false;
  }
  closePaneSurface(workspaceId, surfaceId);
  return true;
}

// A shell's title is its whole `user@host: path`, which would bury the question.
function shortenTitle(title: string, maxLength = 60): string {
  return title.length > maxLength ? `${title.slice(0, maxLength - 1).trimEnd()}…` : title;
}

function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

/**
 * Opens a terminal beside a pane of the active tab, or in an SSH workspace, one on this
 * computer in its Local copy. Returns whether it opened.
 */
export async function splitTerminalBesidePane(
  workspaceId: string,
  paneId: PaneId,
  direction: SplitDirection,
  { local = false }: { local?: boolean } = {}
): Promise<boolean> {
  const tabId = useLayoutStore.getState().activeTabByWorkspace[workspaceId];
  if (!tabId) return false;
  try {
    const { addTerminal } = useWorkspacesStore.getState();
    const terminal = local
      ? await addLocalCopyTerminal(addTerminal, workspaceId)
      : await addTerminalForSplit(addTerminal, workspaceId, undefined);
    useLayoutStore.getState().splitPane(direction, terminal.id, { workspaceId, tabId, paneId });
    return true;
  } catch (error) {
    useToastStore
      .getState()
      .addToast(`Couldn't open a terminal: ${(error as Error).message}`, 'error');
    return false;
  }
}

/** Launches an agent beside a pane of the active tab. Returns whether it started. */
export async function splitAgentBesidePane(
  workspaceId: string,
  paneId: PaneId,
  direction: SplitDirection,
  presetId: string,
  launchModeId: string | null
): Promise<boolean> {
  const tabId = useLayoutStore.getState().activeTabByWorkspace[workspaceId];
  if (!tabId) return false;
  try {
    const terminal = await useWorkspacesStore
      .getState()
      .addAgentTab(workspaceId, undefined, launchModeId ?? undefined, presetId);
    useLayoutStore.getState().splitPane(direction, terminal.id, { workspaceId, tabId, paneId });
    void useAgentPresetsStore.getState().setActivePreset(presetId, launchModeId);
    return true;
  } catch (error) {
    useToastStore
      .getState()
      .addToast(`Failed to launch agent: ${(error as Error).message}`, 'error');
    return false;
  }
}

/** What can take a browser, note or file pane's place. */
export type PaneSurfaceReplacement =
  | 'terminal'
  /** A terminal on this computer, in an SSH workspace's Local copy. */
  | 'local-terminal'
  | 'browser'
  | 'note'
  | { kind: 'agent'; presetId: string; launchModeId: string | null };

/**
 * Opens a terminal, an agent, a browser or a note in a surface's pane and closes the surface,
 * asking first if it has unsaved edits: the new pane opens beside it, then takes its place.
 */
export async function replacePaneSurface(
  workspaceId: string,
  surfaceId: string,
  paneId: PaneId,
  replacement: PaneSurfaceReplacement
): Promise<void> {
  if (!(await confirmClosingPaneSurfaces([surfaceId]))) return;
  if (!(await openBesidePane(workspaceId, paneId, replacement))) return;
  closePaneSurface(workspaceId, surfaceId);
}

async function openBesidePane(
  workspaceId: string,
  paneId: PaneId,
  replacement: PaneSurfaceReplacement
): Promise<boolean> {
  const placement = { kind: 'split', direction: 'vertical', paneId } as const;
  if (typeof replacement === 'object') {
    const { presetId, launchModeId } = replacement;
    return splitAgentBesidePane(workspaceId, paneId, 'vertical', presetId, launchModeId);
  }
  switch (replacement) {
    case 'terminal':
    case 'local-terminal':
      return splitTerminalBesidePane(workspaceId, paneId, 'vertical', {
        local: replacement === 'local-terminal',
      });
    case 'browser':
      openBrowserPane(workspaceId, placement);
      return true;
    case 'note':
      return openNewNotePane(workspaceId, placement);
  }
}

/**
 * Forgets a surface whose pane is gone. A browser's pages close with it,
 * through closePagesOfRemovedPaneBrowserTabs.
 */
function forgetPaneSurface(surfaceId: string): void {
  fileDrafts.delete(surfaceId);
  openingFilePanes.delete(surfaceId);
  usePaneSurfacesStore.getState().removeSurface(surfaceId);
}

/**
 * Closes a surface's pane, and its tab when it was the tab's last pane. A workspace without
 * a terminal stops with its last browser, note or file pane, as it does with its last terminal.
 */
export function closePaneSurface(workspaceId: string, surfaceId: string): void {
  forgetPaneSurface(surfaceId);
  useLayoutStore.getState().removeTerminalPane(workspaceId, surfaceId);
  const workspace = useWorkspacesStore
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId);
  if (
    workspace &&
    !workspace.provisioning &&
    workspace.terminals.length === 0 &&
    !showsPaneSurface(useLayoutStore.getState().layoutsByTab[workspaceId])
  ) {
    void useWorkspacesStore.getState().stopWorkspace(workspaceId);
  }
}

/** Closes a browser pane's tab, and the pane with its last tab, as a browser closes its window. */
export function closePaneBrowserTab(workspaceId: string, tabId: string): void {
  closeBrowserTabOrPane(workspaceId, tabId, false);
}

function closeBrowserTabOrPane(workspaceId: string, tabId: string, stopConfirmed: boolean): void {
  const surfaceId = getPaneSurfaceIdOfTab(tabId);
  const surface = surfaceId ? usePaneSurfacesStore.getState().surfaces[surfaceId] : undefined;
  if (!surfaceId || surface?.kind !== 'browser') return;
  if (getBrowserTabs(surface).some((tab) => tab.id !== tabId)) {
    updatePaneBrowserTabs(surfaceId, (tabs) => closeBrowserTab(tabs, tabId));
  } else if (isPaneSurfaceLayoutLocked(workspaceId, surfaceId)) {
    return;
  } else if (!stopConfirmed && closingPanesStopsWorkspace(workspaceId, [surfaceId])) {
    // Looks again once answered: a tab opened while it asked keeps the pane.
    void confirmStoppingWorkspace(workspaceId).then((confirmed) => {
      if (confirmed) closeBrowserTabOrPane(workspaceId, tabId, true);
    });
  } else {
    closePaneSurface(workspaceId, surfaceId);
  }
}

// Surfaces whose workspace moved to another window, which shows them from then on.
const handedOff = new Set<string>();

/** Whether a pane of the surface's tab is closing, which holds its layout still. */
export function isPaneSurfaceLayoutLocked(workspaceId: string, surfaceId: string): boolean {
  const { closingTerminalIds } = useTerminalCloseStore.getState();
  if (closingTerminalIds.size === 0) return false;
  const tabs = Object.values(useLayoutStore.getState().layoutsByTab[workspaceId] ?? {});
  const tab = tabs.find((root) => findPaneByTerminalId(root, surfaceId));
  return !!tab && getAllLeaves(tab).some((leaf) => closingTerminalIds.has(leaf.terminalId));
}

/** Whether a surface was closed rather than moved: a closed note is deleted if blank. */
export function isPaneSurfaceClosed(surfaceId: string): boolean {
  return !usePaneSurfacesStore.getState().surfaces[surfaceId] && !handedOff.has(surfaceId);
}

/** The surfaces of a workspace, to hand to the window it moves to. */
export function getWorkspacePaneSurfaces(workspaceId: string): Record<string, PaneSurface> {
  return Object.fromEntries(
    Object.entries(usePaneSurfacesStore.getState().surfaces).filter(
      ([, surface]) => surface.workspaceId === workspaceId
    )
  );
}

export function handOffWorkspacePaneSurfaces(workspaceId: string): Record<string, PaneSurface> {
  const surfaces = getWorkspacePaneSurfaces(workspaceId);
  for (const id of Object.keys(surfaces)) handedOff.add(id);
  // A file pane's unsaved edits go along with it.
  return Object.fromEntries(
    Object.entries(surfaces).map(([id, surface]) => {
      const draft = fileDrafts.get(id);
      return [id, surface.kind === 'file' && draft !== undefined ? { ...surface, draft } : surface];
    })
  );
}

export function adoptPaneSurfaces(surfaces: unknown): void {
  if (!surfaces || typeof surfaces !== 'object') return;
  const adopted: Record<string, PaneSurface> = {};
  for (const [id, surface] of Object.entries(surfaces as Record<string, PaneSurface>)) {
    // A surface that comes back closes for real again.
    handedOff.delete(id);
    if (surface.kind === 'file' && surface.draft !== undefined) {
      const { draft, ...rest } = surface;
      fileDrafts.set(id, draft);
      adopted[id] = rest;
    } else {
      adopted[id] = surface;
    }
  }
  usePaneSurfacesStore.setState((state) => ({ surfaces: { ...state.surfaces, ...adopted } }));
}

/**
 * Tells main which workspaces this window shows a browser, note or file pane of, which keeps them
 * running without a terminal. The first report replaces whatever a reloaded window left there.
 * Returns the unsubscribe function.
 */
export function reportWorkspacesShowingPaneSurfaces(): () => void {
  let reported: string | null = null;
  const report = (layoutsByTab: ReturnType<typeof useLayoutStore.getState>['layoutsByTab']) => {
    const workspaceIds = Object.keys(layoutsByTab)
      .filter((workspaceId) => showsPaneSurface(layoutsByTab[workspaceId]))
      .sort();
    const key = workspaceIds.join('\n');
    if (key === reported) return;
    reported = key;
    window.api.setPaneSurfaceWorkspaces(workspaceIds);
  };
  report(useLayoutStore.getState().layoutsByTab);
  return useLayoutStore.subscribe((state, previous) => {
    if (state.layoutsByTab !== previous.layoutsByTab) report(state.layoutsByTab);
  });
}

// Pages change their titles and URLs often, so a workspace saves its browser panes at most this often.
const BROWSER_PANES_SAVE_INTERVAL_MS = 1000;

/** A tab's id without its pane's surface id, which a pane opened again doesn't keep. */
function savedTabId(surfaceId: string, tabId: string): string {
  return tabId.startsWith(`${surfaceId}/`) ? tabId.slice(surfaceId.length + 1) : tabId;
}

/**
 * The workspace's browser panes, in tab order, as it saves them. Tabs it can't save, such as one
 * at a URL too long to keep, are left out rather than failing the save of the others.
 */
function workspaceBrowserPanes(workspaceId: string): WorkspaceBrowserPane[] {
  const layout = useLayoutStore.getState();
  const { surfaces } = usePaneSurfacesStore.getState();
  const panes: WorkspaceBrowserPane[] = [];
  for (const tabId of layout.tabsByWorkspace[workspaceId] ?? []) {
    const root = layout.layoutsByTab[workspaceId]?.[tabId];
    for (const { terminalId: surfaceId } of root ? getAllLeaves(root) : []) {
      const surface = surfaces[surfaceId];
      if (surface?.kind !== 'browser' || surface.browserTabs.length === 0) continue;
      panes.push({
        browserTabs: surface.browserTabs.map((tab) => ({
          ...tab,
          id: savedTabId(surfaceId, tab.id),
        })),
        activeBrowserTabId:
          surface.activeBrowserTabId && savedTabId(surfaceId, surface.activeBrowserTabId),
      });
    }
  }
  return normalizeBrowserPanes(panes) ?? [];
}

/**
 * Saves the browser panes of each workspace this window shows, so they open again when the
 * workspace starts again, as after a restart. A workspace whose panes all went, as when it stops,
 * keeps what it saved, and what changed just before then. Returns the unsubscribe function.
 */
export function saveBrowserPanes(): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Each workspace's browsers as they last were while it showed its panes.
  const latest = new Map<string, WorkspaceBrowserPane[]>();
  const save = (workspaceId: string) => {
    clearTimeout(timers.get(workspaceId));
    timers.delete(workspaceId);
    const browserPanes = latest.get(workspaceId);
    latest.delete(workspaceId);
    if (!browserPanes) return;
    const workspace = useWorkspacesStore
      .getState()
      .workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    if (JSON.stringify(browserPanes) === JSON.stringify(workspace.browserPanes ?? [])) return;
    useWorkspacesStore.getState().updateWorkspace(workspaceId, { browserPanes });
    window.api.updateWorkspace(workspaceId, { browserPanes }).catch(() => {});
  };
  const saveAll = () => {
    for (const workspaceId of [...timers.keys()]) save(workspaceId);
  };
  const schedule = (workspaceId: string) => {
    if (useLayoutStore.getState().tabsByWorkspace[workspaceId]?.length) {
      latest.set(workspaceId, workspaceBrowserPanes(workspaceId));
    }
    if (timers.has(workspaceId)) return;
    timers.set(
      workspaceId,
      setTimeout(() => save(workspaceId), BROWSER_PANES_SAVE_INTERVAL_MS)
    );
  };
  const unsubscribe = usePaneSurfacesStore.subscribe((state, previous) => {
    if (state.surfaces === previous.surfaces) return;
    // Only the workspaces whose browsers opened, closed or changed.
    const workspaceIds = new Set<string>();
    for (const [surfaces, others] of [
      [state.surfaces, previous.surfaces],
      [previous.surfaces, state.surfaces],
    ]) {
      for (const [id, surface] of Object.entries(surfaces)) {
        if (surface.kind === 'browser' && others[id] !== surface) {
          workspaceIds.add(surface.workspaceId);
        }
      }
    }
    for (const workspaceId of workspaceIds) schedule(workspaceId);
  });
  // A browser moved to another place or tab changes only the layout.
  const unsubscribeLayout = useLayoutStore.subscribe((state, previous) => {
    if (
      state.tabsByWorkspace === previous.tabsByWorkspace &&
      state.layoutsByTab === previous.layoutsByTab
    ) {
      return;
    }
    const { surfaces } = usePaneSurfacesStore.getState();
    const showingBrowsers = new Set(
      Object.values(surfaces).flatMap((surface) =>
        surface.kind === 'browser' ? [surface.workspaceId] : []
      )
    );
    for (const workspaceId of showingBrowsers) {
      if (
        state.tabsByWorkspace[workspaceId] !== previous.tabsByWorkspace[workspaceId] ||
        state.layoutsByTab[workspaceId] !== previous.layoutsByTab[workspaceId]
      ) {
        schedule(workspaceId);
      }
    }
  });
  // Quitting saves what's waiting.
  window.addEventListener('beforeunload', saveAll);
  return () => {
    unsubscribe();
    unsubscribeLayout();
    window.removeEventListener('beforeunload', saveAll);
    for (const timer of timers.values()) clearTimeout(timer);
  };
}

/**
 * Opens a workspace's saved browser panes, each in a tab of its own after its others, when its
 * tabs are set up: as it starts, or after a restart. The placeholder tab of a workspace still
 * being set up doesn't count, since its terminal replaces only a placeholder on its own. A
 * workspace that shows a browser already, such as one another window handed over, keeps its own.
 * Then the pages opened while it waited open too, unless it was removed first. Loading workspaces
 * sets up their saved layouts before it lists them, so a workspace whose tabs this window set up
 * first, as an SSH workspace's after a restart, gets its browsers once it's listed. Returns the
 * unsubscribe function.
 */
export function restoreSavedBrowserPanes(): () => void {
  const isSetUp = (workspaceId: string, tabs: string[] | undefined) =>
    !!tabs?.length && !isWorkspaceLayoutPlaceholder(workspaceId, tabs);
  const isListed = (workspaceId: string) =>
    useWorkspacesStore.getState().workspaces.some((workspace) => workspace.id === workspaceId);
  const awaitingListing = new Set<string>();
  const restore = (workspaceId: string) => {
    if (!isListed(workspaceId)) {
      awaitingListing.add(workspaceId);
      return;
    }
    restoreBrowserPanes(workspaceId);
    openPagesAwaitingTerminal(workspaceId);
  };
  const unsubscribeLayout = useLayoutStore.subscribe((state, previous) => {
    if (state.tabsByWorkspace === previous.tabsByWorkspace) return;
    for (const [workspaceId, tabs] of Object.entries(state.tabsByWorkspace)) {
      if (
        isSetUp(workspaceId, tabs) &&
        !isSetUp(workspaceId, previous.tabsByWorkspace[workspaceId])
      ) {
        restore(workspaceId);
      }
    }
  });
  const unsubscribeWorkspaces = useWorkspacesStore.subscribe((state, previous) => {
    if (state.workspaces === previous.workspaces) return;
    if (pagesAwaitingTerminal.size === 0 && awaitingListing.size === 0) return;
    const ids = new Set(state.workspaces.map((workspace) => workspace.id));
    for (const workspace of previous.workspaces) {
      if (!ids.has(workspace.id)) pagesAwaitingTerminal.delete(workspace.id);
    }
    for (const workspaceId of [...awaitingListing]) {
      if (!isListed(workspaceId)) continue;
      awaitingListing.delete(workspaceId);
      if (isSetUp(workspaceId, useLayoutStore.getState().tabsByWorkspace[workspaceId])) {
        restore(workspaceId);
      }
    }
  });
  return () => {
    unsubscribeLayout();
    unsubscribeWorkspaces();
  };
}

function openPagesAwaitingTerminal(workspaceId: string): void {
  const pages = pagesAwaitingTerminal.get(workspaceId);
  pagesAwaitingTerminal.delete(workspaceId);
  for (const { url, urlExecutionLocation } of pages ?? []) {
    openInBrowserPane(workspaceId, url, urlExecutionLocation);
  }
}

function restoreBrowserPanes(workspaceId: string): void {
  const workspace = useWorkspacesStore
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return;
  const saved = workspace.browserPanes ?? [];
  const { surfaces, addSurface } = usePaneSurfacesStore.getState();
  const showsBrowser = Object.values(surfaces).some(
    (surface) => surface.kind === 'browser' && surface.workspaceId === workspaceId
  );
  if (saved.length === 0 || showsBrowser) return;
  for (const pane of saved) {
    const id = addSurface({
      kind: 'browser',
      workspaceId,
      browserTabs: [],
      activeBrowserTabId: undefined,
    });
    updatePaneBrowserTabs(id, () => ({
      browserTabs: pane.browserTabs,
      activeBrowserTabId: pane.activeBrowserTabId,
    }));
    useLayoutStore.getState().addTab(workspaceId, id);
  }
}

/**
 * Forgets each surface once no layout shows it, however its pane went: closed,
 * its workspace cleared or moved to another window. Returns the unsubscribe function.
 */
export function forgetSurfacesOfRemovedPanes(): () => void {
  return useLayoutStore.subscribe((state, previous) => {
    if (state.layoutsByTab === previous.layoutsByTab) return;
    if (Object.keys(usePaneSurfacesStore.getState().surfaces).length === 0) return;
    const shown = new Set(
      Object.values(state.layoutsByTab).flatMap((tabs) =>
        Object.values(tabs).flatMap((root) => getAllLeaves(root).map((leaf) => leaf.terminalId))
      )
    );
    for (const id of Object.keys(usePaneSurfacesStore.getState().surfaces)) {
      if (!shown.has(id)) forgetPaneSurface(id);
    }
  });
}

function browserPaneTabKeys(
  surfaces: Record<string, PaneSurface>
): Map<string, { surfaceId: string; workspaceId: string; tabId: string }> {
  const keys = new Map<string, { surfaceId: string; workspaceId: string; tabId: string }>();
  for (const [surfaceId, surface] of Object.entries(surfaces)) {
    if (surface.kind !== 'browser') continue;
    for (const tab of surface.browserTabs) {
      keys.set(tab.id, { surfaceId, workspaceId: surface.workspaceId, tabId: tab.id });
    }
  }
  return keys;
}

/**
 * Closes the page, and SSH tunnel, of every browser pane tab that is gone:
 * closed, or its pane gone. A page belongs to this window, so it closes even when
 * the workspace moved, but the tunnel then stays for the window it moved to.
 * Pages close once their pane unmounts, which would otherwise show them again.
 * Returns the unsubscribe function.
 */
export function closePagesOfRemovedPaneBrowserTabs(): () => void {
  return usePaneSurfacesStore.subscribe((state, previous) => {
    if (state.surfaces === previous.surfaces) return;
    const current = browserPaneTabKeys(state.surfaces);
    for (const [key, { surfaceId, workspaceId, tabId }] of browserPaneTabKeys(previous.surfaces)) {
      if (current.has(key)) continue;
      setTimeout(() => window.api.closeDevPreview(workspaceId, tabId), 0);
      const workspace = useWorkspacesStore
        .getState()
        .workspaces.find((candidate) => candidate.id === workspaceId);
      if (workspace?.backend?.kind === 'ssh' && !handedOff.has(surfaceId)) {
        void useDevServerPreviewStore.getState().stopSshPreviewForward(workspaceId, { tabId });
      }
    }
  });
}

/** A surface pane's name for its tab: the page title or host, the note title or the file name. */
export function getPaneSurfaceTitle(
  surface: PaneSurface | undefined,
  notes: NoteSummary[]
): string {
  if (!surface) return 'Closed';
  if (surface.kind === 'file') return getFileName(surface.path);
  if (surface.kind === 'note') {
    return notes.find((note) => note.name === surface.name)?.title || UNTITLED_NOTE;
  }
  const tab = getActiveBrowserTab(surface);
  return tab && (tab.url || tab.title) ? getBrowserTabLabel(tab) : 'Browser';
}
