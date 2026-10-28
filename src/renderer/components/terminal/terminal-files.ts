import { useMemo } from 'react';

import { scanWorkspaceTerminalsForFiles } from '@/lib/scan-terminal-files';
import { useFileListStore } from '@/stores/file-list.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import {
  takeQueuedFileHyperlinks,
  terminalFileLinkContext,
  useTerminalFilesStore,
  type TerminalFile,
  type TerminalFilePrint,
} from '@/stores/terminal-files.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import {
  openTerminalFileLink,
  resolveTerminalFileLink,
  terminalLinkViewerItem,
} from './TerminalView';

import type { QuickLookItem, QuickLookListed } from '@/stores/quick-look.store';

const NO_FILES: TerminalFile[] = [];
const NO_PATHS: string[] = [];

type FileList = {
  files: string[];
  gitIgnoredFiles: string[];
  emptyDirs: string[];
  isLoading: boolean;
};

// Each file list's paths, built the first time each is needed. Keyed by its arrays, which a list
// marked stale or fetched again with the same paths keeps, unlike the list itself.
const listedPathSets = new WeakMap<
  string[],
  { gitIgnoredFiles: string[]; emptyDirs: string[]; paths: Set<string> }
>();

/**
 * Reads the file hyperlinks and the paths the workspace's terminals printed since the last time,
 * resolved as clicking them would: a path in the workspace, or a full path where its terminal runs.
 */
export function rememberTerminalFiles(workspaceId: string): void {
  const prints: TerminalFilePrint[] = takeQueuedFileHyperlinks(workspaceId);
  // A terminal between panes has no context to resolve its paths with, so its output waits for
  // a scan once it has one again.
  const hasContext = (terminalId: string) => terminalFileLinkContext(terminalId) !== undefined;
  for (const { terminalId, path, lineNumber, printedAt } of scanWorkspaceTerminalsForFiles(
    workspaceId,
    hasContext
  )) {
    const context = terminalFileLinkContext(terminalId);
    const target = context && resolveTerminalFileLink(path, context, window.api?.platform);
    if (target) prints.push({ path, lineNumber, terminalId, target, context, printedAt });
  }
  useTerminalFilesStore.getState().notePrinted(workspaceId, prints);
}

/**
 * The paths the file tree lists: its files, their folders, its empty folders and, while it shows
 * them, its ignored files, each folder ending in a slash. Null before the list loads, when any
 * path may be in it.
 */
function listedPaths(list: FileList | undefined, showsIgnored: boolean): Set<string> | null {
  if (!list || (list.isLoading && list.files.length === 0)) return null;
  // The list can hold ignored files the tree hides: an SSH workspace's always has them.
  const gitIgnoredFiles = showsIgnored ? list.gitIgnoredFiles : NO_PATHS;
  const built = listedPathSets.get(list.files);
  if (built?.gitIgnoredFiles === gitIgnoredFiles && built.emptyDirs === list.emptyDirs) {
    return built.paths;
  }
  const paths = new Set<string>();
  for (const files of [list.files, gitIgnoredFiles]) {
    for (const file of files) {
      paths.add(file);
      for (let slash = file.indexOf('/'); slash !== -1; slash = file.indexOf('/', slash + 1)) {
        paths.add(file.slice(0, slash + 1));
      }
    }
  }
  for (const dir of list.emptyDirs) paths.add(dir.endsWith('/') ? dir : `${dir}/`);
  listedPathSets.set(list.files, {
    gitIgnoredFiles,
    emptyDirs: list.emptyDirs,
    paths,
  });
  return paths;
}

type Order = (a: TerminalFile, b: TerminalFile) => number;

/**
 * Files outside the workspace before the workspace's own: an agent points outside it for
 * something to look at, such as a mock-up or a page it made, and inside it while working on files.
 */
const outsideFirst =
  (order: Order): Order =>
  (a, b) =>
    Number(a.target.type === 'workspace') - Number(b.target.type === 'workspace') || order(a, b);
const byOpened = outsideFirst((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
// Untimed prints stay after timed ones, in the order they were read, newest line first.
const byPrinted = outsideFirst(
  (a, b) => (b.printedAt ?? -Infinity) - (a.printedAt ?? -Infinity) || 0
);

export interface TerminalFileGroups {
  /** Files opened from a terminal link or the list, outside the workspace first, the latest first. */
  opened: TerminalFile[];
  /** Files printed but not opened, outside the workspace first, the latest printed first. */
  mentioned: TerminalFile[];
}

/**
 * The workspace's files from terminals. A path outside the workspace shows while its terminal is
 * open, since it's read there. A printed workspace path shows while the file tree lists it, so
 * made-up paths, deleted files and stack traces' paths stay out.
 */
export function useTerminalFiles(workspaceId: string): TerminalFileGroups {
  const files = useTerminalFilesStore((s) => s.byWorkspace[workspaceId] ?? NO_FILES);
  const workingDirectory = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.workingDirectory
  );
  // Their ids joined, so a status update, which replaces the terminals, doesn't sort again.
  const terminalIds = useWorkspacesStore(
    (s) =>
      s.workspaces
        .find((w) => w.id === workspaceId)
        ?.terminals.map((terminal) => terminal.id)
        .join('\n') ?? ''
  );
  const showsIgnored = useFileViewerStore((s) => !!s.showGitIgnoredByWorkspace[workspaceId]);
  const list = useFileListStore((s) =>
    workingDirectory ? s.cache.get(workingDirectory) : undefined
  );

  return useMemo(() => {
    const listed = listedPaths(list, showsIgnored);
    const liveTerminals = new Set(terminalIds.split('\n'));
    const shown = files.filter(({ target, terminalId }) =>
      target.type === 'workspace' ? true : liveTerminals.has(terminalId)
    );
    return {
      opened: shown.filter((file) => file.openedAt !== undefined).sort(byOpened),
      mentioned: shown
        .filter(
          (file) =>
            file.openedAt === undefined &&
            (file.target.type !== 'workspace' || !listed || listed.has(file.target.filePath))
        )
        .sort(byPrinted),
    };
  }, [files, terminalIds, list, showsIgnored]);
}

/** Opens a listed file as clicking its link in the terminal would. */
export function openTerminalFile(file: TerminalFile): void {
  openTerminalFileLink(file.path, file.lineNumber, file.target, file.terminalId, file.context);
}

export function terminalFileViewerItem(file: TerminalFile): QuickLookItem {
  return terminalLinkViewerItem(
    file.path,
    file.lineNumber,
    file.target,
    file.terminalId,
    file.context
  );
}

/** The workspace's files from terminals as the file viewer's sidebar lists them. */
export function useTerminalFileViewerItems(workspaceId: string): QuickLookListed {
  const { opened, mentioned } = useTerminalFiles(workspaceId);
  return useMemo(
    () => ({
      opened: opened.map(terminalFileViewerItem),
      mentioned: mentioned.map(terminalFileViewerItem),
    }),
    [opened, mentioned]
  );
}
