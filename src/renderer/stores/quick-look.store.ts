import { create } from 'zustand';

import type { ViewerFileSource, ViewerFolderFile } from '../../shared/types/viewer-file';

const SIDEBAR_HIDDEN_STORAGE_KEY = 'komla.quickLookSidebarHidden';

function readStoredSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_HIDDEN_STORAGE_KEY) !== 'true';
  } catch {
    return true;
  }
}

function storeSidebarOpen(open: boolean): void {
  try {
    if (open) window.localStorage.removeItem(SIDEBAR_HIDDEN_STORAGE_KEY);
    else window.localStorage.setItem(SIDEBAR_HIDDEN_STORAGE_KEY, 'true');
  } catch {
    // Storage can be unavailable; the choice still applies for this session.
  }
}

export interface QuickLookItem {
  /** The path as the terminal printed it, ending in a separator for a folder. */
  path: string;
  /** The terminal that printed it, whose environment the file is read in. */
  terminalId: string;
  source: ViewerFileSource;
  /** The file's path on this computer, when it is on this computer. */
  hostPath?: string;
  /** When the file was last modified, for a file from a folder listing. */
  modifiedMs?: number;
  /** The line the link pointed to, which the viewer shows. */
  lineNumber?: number;
}

/** Where in the sidebar a file is: in Recent, or in the folder's section. */
export type QuickLookSection = 'recent' | 'folder';

export interface QuickLookSession {
  workspaceId: string;
  item: QuickLookItem;
  /**
   * The section it was chosen in, for a file both list: Recent, unless shown from the folder.
   * The arrows step on from there.
   */
  from?: QuickLookSection;
}

/** The subfolders and viewable files of the folder on screen, or of the file's folder. */
export interface QuickLookFolder {
  key: string;
  status: 'loading' | 'loaded' | 'error';
  items: QuickLookItem[];
}

interface QuickLookState {
  /** The file or folder on screen, or null while the viewer is closed. */
  session: QuickLookSession | null;
  folder: QuickLookFolder | null;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  /** Shows a workspace's file from terminals, as a link or the files list opens it. */
  open: (workspaceId: string, item: QuickLookItem) => void;
  /** Shows a file from the sidebar, chosen in `from`: Recent, or the folder's section. */
  show: (item: QuickLookItem, from: QuickLookSection) => void;
  /** Moves through the sidebar's files, with `listed` the terminal files it lists. */
  step: (delta: number, listed?: QuickLookListed) => void;
  close: () => void;
}

export function quickLookItemKey({ terminalId, source }: QuickLookItem): string {
  return source.kind === 'workspace'
    ? `workspace:${source.filePath}`
    : `terminal:${terminalId}:${source.fullPath}`;
}

/** The folder an item lists: itself for a folder, else the file's folder. */
function folderKey(workspaceId: string, item: QuickLookItem): string {
  return `${workspaceId}:${quickLookItemKey(item).replace(/[^/]*$/, '')}`;
}

/**
 * The path an agent prompt's `@path` names an item by: from the workspace root for a workspace
 * file, as the file tree's Copy @path does, else in full, where its terminal runs.
 */
export function quickLookReferencePath({ source }: QuickLookItem): string {
  return source.kind === 'workspace' ? source.filePath : source.fullPath;
}

/**
 * The item's full path, to copy, unless it is the path as printed: on this computer, or where its
 * terminal runs. Unknown for a workspace file on an SSH host.
 */
export function quickLookFullPath(item: QuickLookItem): string | undefined {
  const full =
    item.hostPath ?? (item.source.kind === 'terminal' ? item.source.fullPath : undefined);
  return full === item.path ? undefined : full;
}

/** Whether an item is a folder, which a terminal printed with a trailing separator. */
export function isQuickLookFolder({ source }: QuickLookItem): boolean {
  return (source.kind === 'workspace' ? source.filePath : source.fullPath).endsWith('/');
}

/** The workspace's files from terminals, the latest opened or printed first. */
export type QuickLookListed = QuickLookItem[];

const NOTHING_LISTED: QuickLookListed = [];

/** The folder on screen, or of the file on screen, in the viewer's sidebar. */
export interface QuickLookFolderSection {
  key: string;
  /** The folder itself, to show it. */
  folder: QuickLookItem;
  /** The folder it is in, to go up to, unless it is the top: the workspace, root or ~/. */
  parent: QuickLookItem | null;
  /**
   * The files the viewer can show in it, newest first, Recent's too. The file on screen comes
   * first when the listing leaves it out, such as a type it skips.
   */
  files: QuickLookItem[];
  folders: QuickLookItem[];
  status: QuickLookFolder['status'] | undefined;
}

/**
 * The viewer's sidebar: the files from terminals, the latest opened or printed first, then the
 * rest of the folder on screen, or of the file on screen.
 */
export interface QuickLookSidebarSections {
  recent: QuickLookItem[];
  folder: QuickLookFolderSection;
  /** The section whose row is the one on screen, for a file or folder both list. */
  current: QuickLookSection;
}

/** The files from terminals, each once, where it was opened or printed last. */
function withoutRepeats(items: QuickLookItem[]): QuickLookItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = quickLookItemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Where the row on screen is, for a file or folder both sections list: a file where it was chosen,
 * and a folder at its own section while it has files to step into.
 */
function sectionInBoth(
  onScreen: QuickLookItem,
  from: QuickLookSection | undefined,
  intoFiles: boolean
): QuickLookSection {
  if (isQuickLookFolder(onScreen)) return intoFiles ? 'folder' : 'recent';
  return from ?? 'recent';
}

/**
 * The sidebar. The folder's section lists all its files, as a file tree does, so a file can be in
 * Recent too: the one on screen is in the section it was chosen in. A folder on screen is at its
 * section, just above its files, even when Recent lists it too, so the arrows go into a folder
 * opened from a link; one with no files to go into stays in Recent.
 */
export function quickLookSidebar(
  { session, folder }: Pick<QuickLookState, 'session' | 'folder'>,
  listed: QuickLookListed = NOTHING_LISTED
): QuickLookSidebarSections | null {
  if (!session) return null;
  const { workspaceId, item: onScreen, from } = session;
  const onScreenKey = quickLookItemKey(onScreen);
  const recent = withoutRepeats(listed);
  const inRecent = recent.some((item) => quickLookItemKey(item) === onScreenKey);

  const key = folderKey(workspaceId, onScreen);
  const status = folder?.key === key ? folder.status : undefined;
  const loaded = status === 'loaded' ? folder!.items : [];
  const files = loaded.filter((item) => !isQuickLookFolder(item));
  const intoFiles = files.length > 0 || status === 'loading';
  const current = inRecent ? sectionInBoth(onScreen, from, intoFiles) : 'folder';
  // Not while the folder loads, for a file on screen in Recent, as it would move once listed.
  const listsOnScreen = files.some((item) => quickLookItemKey(item) === onScreenKey);
  if (
    !isQuickLookFolder(onScreen) &&
    !listsOnScreen &&
    (current === 'folder' || status === 'loaded')
  ) {
    files.unshift(onScreen);
  }
  const folderOnScreen = containingFolder(onScreen);
  return {
    recent,
    folder: {
      key,
      folder: folderOnScreen,
      parent: parentFolder(folderOnScreen),
      files,
      folders: loaded.filter(isQuickLookFolder),
      status,
    },
    current,
  };
}

const POSIX_NAME = /[^/]*$/;
// A printed workspace path can use Windows separators.
const ANY_NAME = /[^/\\]*$/;

/** Replaces the file name at the end of a path. */
function withFileName(path: string, name: string, lastSegment: RegExp): string {
  return path.replace(lastSegment, () => name);
}

/** Another file or a subfolder in the folder `item` lists. */
function folderItem(item: QuickLookItem, { name, modifiedMs }: ViewerFolderFile): QuickLookItem {
  const { source } = item;
  return {
    path: withFileName(item.path, name, source.kind === 'workspace' ? ANY_NAME : POSIX_NAME),
    terminalId: item.terminalId,
    source:
      source.kind === 'workspace'
        ? { kind: 'workspace', filePath: withFileName(source.filePath, name, POSIX_NAME) }
        : { kind: 'terminal', fullPath: withFileName(source.fullPath, name, POSIX_NAME) },
    hostPath: item.hostPath && withFileName(item.hostPath, name, POSIX_NAME),
    modifiedMs,
  };
}

/**
 * The folder a folder is in, as an item, or null at the top: the workspace, which is no folder
 * path, the root, or the home folder a terminal printed as ~/.
 */
function parentFolder(folder: QuickLookItem): QuickLookItem | null {
  const { source } = folder;
  const sourcePath = source.kind === 'workspace' ? source.filePath : source.fullPath;
  const parentPath = sourcePath.replace(/[^/]+\/$/, '');
  if (parentPath === sourcePath || parentPath === '') return null;
  // The printed path loses its folders too, until it has none left to lose.
  const printed = folder.path.replace(/[^/\\]+[/\\]$/, '');
  return {
    path: printed && printed !== folder.path && printed !== './' ? printed : parentPath,
    terminalId: folder.terminalId,
    source:
      source.kind === 'workspace'
        ? { kind: 'workspace', filePath: parentPath }
        : { kind: 'terminal', fullPath: parentPath },
    hostPath: folder.hostPath && folder.hostPath.replace(/[^/\\]+[/\\]?$/, ''),
  };
}

/** The folder an item lists, as an item: itself for a folder. */
function containingFolder(item: QuickLookItem): QuickLookItem {
  return isQuickLookFolder(item) ? item : folderItem(item, { name: '' });
}

interface SidebarRow {
  item: QuickLookItem;
  section: QuickLookSection;
}

/**
 * The file `delta` places from the row on screen, down the sidebar, skipping folders and the other
 * row of the file on screen: Recent's, then the folder's, with a folder on screen at its section
 * just above its files.
 */
function stepTarget(
  state: QuickLookState,
  delta: number,
  listed: QuickLookListed = NOTHING_LISTED
): SidebarRow | undefined {
  const sections = quickLookSidebar(state, listed);
  if (!state.session || !sections) return undefined;
  const { item } = state.session;
  const onScreen = quickLookItemKey(item);
  const { current } = sections;
  const rows: SidebarRow[] = [
    ...sections.recent.map((recent) => ({ item: recent, section: 'recent' as const })),
    ...(isQuickLookFolder(item) && current === 'folder'
      ? [{ item, section: 'folder' as const }]
      : []),
    ...sections.folder.files.map((file) => ({ item: file, section: 'folder' as const })),
  ];
  const isOnScreen = (row: SidebarRow) =>
    row.section === current && quickLookItemKey(row.item) === onScreen;
  // A step to the file's other row would show the same file again.
  const steps = rows.filter(
    (row) =>
      isOnScreen(row) || (!isQuickLookFolder(row.item) && quickLookItemKey(row.item) !== onScreen)
  );
  const index = steps.findIndex(isOnScreen);
  return index < 0 ? undefined : steps[index + delta];
}

export function canStepQuickLook(
  state: QuickLookState,
  delta: number,
  listed: QuickLookListed = NOTHING_LISTED
): boolean {
  return stepTarget(state, delta, listed) !== undefined;
}

export const useQuickLookStore = create<QuickLookState>((set, get) => {
  /** Lists the folder of the file on screen, unless it is already listed. */
  const syncFolder = () => {
    const { session, folder } = get();
    if (!session) return;
    const { workspaceId, item } = session;
    const key = folderKey(workspaceId, item);
    if (folder?.key === key) return;
    set({ folder: { key, status: 'loading', items: [] } });
    window.api.listViewerFolder(workspaceId, item.terminalId, item.source).then(
      (files) => {
        if (get().folder?.key !== key) return;
        set({
          folder: { key, status: 'loaded', items: files.map((file) => folderItem(item, file)) },
        });
      },
      () => {
        if (get().folder?.key === key) set({ folder: { key, status: 'error', items: [] } });
      }
    );
  };

  return {
    session: null,
    folder: null,
    sidebarOpen: readStoredSidebarOpen(),

    toggleSidebar: () => {
      const sidebarOpen = !get().sidebarOpen;
      storeSidebarOpen(sidebarOpen);
      set({ sidebarOpen });
    },

    open: (workspaceId, item) => {
      set({ session: { workspaceId, item } });
      syncFolder();
    },

    show: (item, from) => {
      const { session } = get();
      if (!session) return;
      set({ session: { workspaceId: session.workspaceId, item, from } });
      syncFolder();
    },

    step: (delta, listed) => {
      const state = get();
      const next = stepTarget(state, delta, listed);
      if (!state.session || !next) return;
      const { workspaceId } = state.session;
      set({ session: { workspaceId, item: next.item, from: next.section } });
      syncFolder();
    },

    close: () => {
      set({ session: null, folder: null });
    },
  };
});
