import { useMemo } from 'react';

import { scanWorkspaceTerminalsForFiles } from '@/lib/scan-terminal-files';
import { useFileListStore } from '@/stores/file-list.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import {
  takeQueuedFileHyperlinks,
  terminalFileKey,
  terminalFileLinkContext,
  useTerminalFilesStore,
  type TerminalFile,
  type TerminalFilePrint,
} from '@/stores/terminal-files.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { isInLinkedWorkspaces } from '../../../shared/lib/linked-workspaces';

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
  void checkOutsideFiles(workspaceId);
}

// The workspaces whose files outside them are being checked, true when asked again meanwhile.
const checking = new Map<string, boolean>();
// How long a check holds, failed or not, so hovering the list again and again doesn't run one over
// SSH each time.
const RECHECK_AFTER_MS = 10_000;
// When each entry was last checked; a print or open makes a new one.
const checkedAt = new WeakMap<TerminalFile, number>();
// The longest path the check takes, as the IPC does; a longer one stays as it is.
const MAX_CHECKED_PATH_LENGTH = 4096;

/**
 * Checks that the workspace's files outside it, in its open terminals, are still there where
 * those terminals run, so the list leaves out deleted files and paths a terminal wrapped across
 * lines and only part of was read. A file not checked yet, or whose check failed, stays as it
 * was: listed, unless an earlier check didn't find it.
 */
async function checkOutsideFiles(workspaceId: string): Promise<void> {
  const check = window.api?.terminalFilesExist;
  if (!check) return;
  if (checking.has(workspaceId)) {
    checking.set(workspaceId, true);
    return;
  }
  checking.set(workspaceId, false);
  try {
    const liveTerminals = new Set(
      useWorkspacesStore
        .getState()
        .workspaces.find((w) => w.id === workspaceId)
        ?.terminals.map((terminal) => terminal.id)
    );
    const byTerminal = new Map<string, { files: TerminalFile[]; paths: string[] }>();
    const startedAt = Date.now();
    for (const file of useTerminalFilesStore.getState().byWorkspace[workspaceId] ?? NO_FILES) {
      if (file.target.type !== 'external' || !liveTerminals.has(file.terminalId)) continue;
      if (file.target.fullPath.length > MAX_CHECKED_PATH_LENGTH) continue;
      if (startedAt - (checkedAt.get(file) ?? -Infinity) < RECHECK_AFTER_MS) continue;
      checkedAt.set(file, startedAt);
      const batch = byTerminal.get(file.terminalId) ?? { files: [], paths: [] };
      batch.files.push(file);
      batch.paths.push(file.target.fullPath);
      byTerminal.set(file.terminalId, batch);
    }
    if (byTerminal.size === 0) return;
    const found = new Map<TerminalFile, boolean>();
    await Promise.all(
      [...byTerminal].map(async ([terminalId, { files, paths }]) => {
        const there = await check(workspaceId, terminalId, paths).catch(() => null);
        files.forEach((file, index) => {
          const answer = there?.[index];
          if (typeof answer === 'boolean') found.set(file, answer);
        });
      })
    );
    // From when the check ended, so a slow host isn't asked again as soon as it answers.
    const endedAt = Date.now();
    const checked = new Map<string, TerminalFile>();
    for (const files of byTerminal.values()) {
      for (const file of files.files) {
        checkedAt.set(file, endedAt);
        checked.set(terminalFileKey(file), file);
      }
    }
    useTerminalFilesStore.getState().noteChecked(workspaceId, found);
    // An entry the check marked or cleared is a new one, as checked as the one it replaced.
    for (const file of useTerminalFilesStore.getState().byWorkspace[workspaceId] ?? NO_FILES) {
      const before = checked.get(terminalFileKey(file));
      if (
        before &&
        before !== file &&
        before.printedAt === file.printedAt &&
        before.openedAt === file.openedAt
      ) {
        checkedAt.set(file, endedAt);
      }
    }
  } finally {
    const again = checking.get(workspaceId);
    checking.delete(workspaceId);
    if (again) void checkOutsideFiles(workspaceId);
  }
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

/**
 * Files outside the workspace before the workspace's own: an agent points outside it for
 * something to look at, such as a mock-up or a page it made, and inside it while working on files.
 */
const outsideFirst = (a: TerminalFile, b: TerminalFile): number =>
  Number(a.target.type === 'workspace') - Number(b.target.type === 'workspace');
const byOpened = (a: TerminalFile, b: TerminalFile): number =>
  outsideFirst(a, b) || (b.openedAt ?? 0) - (a.openedAt ?? 0);

export interface TerminalFileGroups {
  /** All of them, the latest printed first, as the terminals show them. */
  all: TerminalFile[];
  /** Files opened from a terminal link or the list, outside the workspace first, the latest first. */
  opened: TerminalFile[];
  /** Files printed but not opened, outside the workspace first, the latest printed first. */
  mentioned: TerminalFile[];
}

/**
 * The workspace's files from terminals. A path outside the workspace shows while its terminal is
 * open, since it's read there, unless a check found it isn't there. A printed workspace path
 * shows while the file tree lists it, so made-up paths, deleted files and stack traces' paths
 * stay out.
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
    const all = files.filter(
      (file) =>
        (file.target.type !== 'workspace' && liveTerminals.has(file.terminalId) && !file.missing) ||
        (file.target.type === 'workspace' &&
          (file.openedAt !== undefined ||
            !listed ||
            listed.has(file.target.filePath) ||
            // The list leaves out linked workspaces' files, which agents name through here.
            isInLinkedWorkspaces(file.target.filePath)))
    );
    return {
      all,
      opened: all.filter((file) => file.openedAt !== undefined).sort(byOpened),
      // In the order printed already, as the store keeps them.
      mentioned: all.filter((file) => file.openedAt === undefined).sort(outsideFirst),
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

/**
 * The workspace's files from terminals as the file viewer's sidebar lists them: the files the
 * files dropdown lists, but in the order printed alone, as the terminals show them, so the file
 * after the one on screen is the one printed before it. Opening a file leaves it in its place.
 */
export function useTerminalFileViewerItems(workspaceId: string): QuickLookListed {
  const { all } = useTerminalFiles(workspaceId);
  return useMemo(() => all.map(terminalFileViewerItem), [all]);
}
