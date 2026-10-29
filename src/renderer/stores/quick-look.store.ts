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

export interface QuickLookSession {
  workspaceId: string;
  item: QuickLookItem;
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
  /** Shows a file from the sidebar. */
  show: (item: QuickLookItem) => void;
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
   * The files the viewer can show in it, newest first, but those listed above. The file on screen
   * comes first when the listing leaves it out, such as a type it skips.
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
}

function withoutRepeats(items: QuickLookItem[], seen: Set<string>): QuickLookItem[] {
  return items.filter((item) => {
    const key = quickLookItemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The sidebar, with each file once: in the first section that lists it. */
export function quickLookSidebar(
  { session, folder }: Pick<QuickLookState, 'session' | 'folder'>,
  listed: QuickLookListed = NOTHING_LISTED
): QuickLookSidebarSections | null {
  if (!session) return null;
  const { workspaceId, item: onScreen } = session;
  const seen = new Set<string>();
  const recent = withoutRepeats(listed, seen);

  const key = folderKey(workspaceId, onScreen);
  const loaded = folder?.key === key && folder.status === 'loaded' ? folder.items : [];
  const files = withoutRepeats(
    loaded.filter((item) => !isQuickLookFolder(item)),
    seen
  );
  if (!isQuickLookFolder(onScreen) && !seen.has(quickLookItemKey(onScreen))) {
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
      status: folder?.key === key ? folder.status : undefined,
    },
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

/**
 * The file `delta` places from the one on screen, down the sidebar, skipping folders. A folder on
 * screen that no section above lists counts as just above its files.
 */
function stepTarget(
  state: QuickLookState,
  delta: number,
  listed: QuickLookListed = NOTHING_LISTED
): QuickLookItem | undefined {
  const sections = quickLookSidebar(state, listed);
  if (!state.session || !sections) return undefined;
  const onScreen = quickLookItemKey(state.session.item);
  const above = sections.recent;
  const folderOnScreen =
    isQuickLookFolder(state.session.item) &&
    !above.some((item) => quickLookItemKey(item) === onScreen)
      ? [state.session.item]
      : [];
  const items = [...above, ...folderOnScreen, ...sections.folder.files].filter(
    (item) => quickLookItemKey(item) === onScreen || !isQuickLookFolder(item)
  );
  const index = items.findIndex((item) => quickLookItemKey(item) === onScreen);
  return index < 0 ? undefined : items[index + delta];
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

    show: (item) => {
      const { session } = get();
      if (!session) return;
      set({ session: { ...session, item } });
      syncFolder();
    },

    step: (delta, listed) => {
      const state = get();
      const next = stepTarget(state, delta, listed);
      if (!state.session || !next) return;
      set({ session: { ...state.session, item: next } });
      syncFolder();
    },

    close: () => {
      set({ session: null, folder: null });
    },
  };
});
