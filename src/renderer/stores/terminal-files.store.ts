import { create } from 'zustand';

import type {
  TerminalFileLinkContext,
  TerminalFileOpenTarget,
} from '@/components/terminal/TerminalView';

// Each workspace keeps this many files, dropping the ones printed longest ago, then the ones
// opened longest ago.
const MAX_FILES_PER_WORKSPACE = 200;

/** A file or folder a workspace's terminal printed or opened, until Komla quits. */
export interface TerminalFile {
  /** The path as the terminal printed it, a folder's ending in a separator. */
  path: string;
  lineNumber?: number;
  /** The terminal that printed or opened it, where a path outside the workspace is read. */
  terminalId: string;
  target: TerminalFileOpenTarget;
  /** The terminal's link context, which opening the file again needs. */
  context: TerminalFileLinkContext;
  /** When a terminal last printed it, when known. */
  printedAt?: number;
  /** When it was last opened from a terminal link or the files list. */
  openedAt?: number;
}

export type TerminalFilePrint = Omit<TerminalFile, 'openedAt'>;

interface TerminalFilesState {
  byWorkspace: Record<string, TerminalFile[]>;
  /**
   * Adds what terminals printed, newest first. A newer print of a known file takes its place,
   * with its line and terminal; an untimed one changes nothing.
   */
  notePrinted: (workspaceId: string, prints: TerminalFilePrint[]) => void;
  /** Marks a file as opened now, with the line it was opened at. */
  noteOpened: (workspaceId: string, file: Omit<TerminalFile, 'printedAt' | 'openedAt'>) => void;
}

/** One entry per file: a workspace file by its path, any other by its terminal and path. */
export function terminalFileKey({
  target,
  terminalId,
}: Pick<TerminalFile, 'target' | 'terminalId'>) {
  return target.type === 'workspace'
    ? `workspace:${target.filePath}`
    : `terminal:${terminalId}:${target.fullPath}`;
}

function lastSeen(file: TerminalFile): number {
  return Math.max(file.printedAt ?? 0, file.openedAt ?? 0);
}

/**
 * The newest MAX_FILES_PER_WORKSPACE files, opened ones first, so a burst of printed paths, most
 * of which the list never shows, can't push them out. Untimed ones count as the oldest.
 */
function capped(files: TerminalFile[]): TerminalFile[] {
  if (files.length <= MAX_FILES_PER_WORKSPACE) return files;
  return [...files]
    .sort(
      (a, b) =>
        Number(b.openedAt !== undefined) - Number(a.openedAt !== undefined) ||
        lastSeen(b) - lastSeen(a)
    )
    .slice(0, MAX_FILES_PER_WORKSPACE);
}

export const useTerminalFilesStore = create<TerminalFilesState>((set) => ({
  byWorkspace: {},

  notePrinted: (workspaceId, prints) => {
    if (prints.length === 0) return;
    set(({ byWorkspace }) => {
      const files = [...(byWorkspace[workspaceId] ?? [])];
      const indexes = new Map(files.map((file, index) => [terminalFileKey(file), index]));
      let changed = false;
      for (const print of prints) {
        const key = terminalFileKey(print);
        const index = indexes.get(key);
        if (index === undefined) {
          indexes.set(key, files.length);
          files.push(print);
          changed = true;
        } else if (
          print.printedAt !== undefined &&
          print.printedAt > (files[index].printedAt ?? 0)
        ) {
          files[index] = { ...print, openedAt: files[index].openedAt };
          changed = true;
        }
      }
      return changed ? { byWorkspace: { ...byWorkspace, [workspaceId]: capped(files) } } : {};
    });
  },

  noteOpened: (workspaceId, file) => {
    set(({ byWorkspace }) => {
      const key = terminalFileKey(file);
      const files = byWorkspace[workspaceId] ?? [];
      const known = files.find((candidate) => terminalFileKey(candidate) === key);
      const opened: TerminalFile = { ...file, printedAt: known?.printedAt, openedAt: Date.now() };
      return {
        byWorkspace: {
          ...byWorkspace,
          [workspaceId]: capped([
            opened,
            ...files.filter((candidate) => terminalFileKey(candidate) !== key),
          ]),
        },
      };
    });
  },
}));

// Each live terminal's link context, which reading its printed paths needs.
const linkContexts = new Map<string, TerminalFileLinkContext>();
// File hyperlinks printed since the list last read the workspace's terminals, each file once, at
// its latest print, oldest first.
const queuedHyperlinks = new Map<string, Map<string, TerminalFilePrint>>();
// Files waiting per workspace, so a busy terminal can't hold on to too many.
const MAX_QUEUED_HYPERLINKS = 500;

/** Sets the link context of a terminal on screen, or forgets it when the terminal goes. */
export function setTerminalFileLinkContext(
  terminalId: string,
  context: TerminalFileLinkContext | undefined
): void {
  if (context) linkContexts.set(terminalId, context);
  else linkContexts.delete(terminalId);
}

export function terminalFileLinkContext(terminalId: string): TerminalFileLinkContext | undefined {
  return linkContexts.get(terminalId);
}

/**
 * Holds a file hyperlink a terminal printed until the list next reads the terminals. A program
 * that redraws its screen prints the same links over and over, so each file waits once.
 */
export function queuePrintedFileHyperlink(workspaceId: string, print: TerminalFilePrint): void {
  const queued = queuedHyperlinks.get(workspaceId) ?? new Map<string, TerminalFilePrint>();
  const key = terminalFileKey(print);
  queued.delete(key);
  queued.set(key, print);
  if (queued.size > MAX_QUEUED_HYPERLINKS) queued.delete(queued.keys().next().value!);
  queuedHyperlinks.set(workspaceId, queued);
}

/** The file hyperlinks printed since the last call, newest first. */
export function takeQueuedFileHyperlinks(workspaceId: string): TerminalFilePrint[] {
  const queued = queuedHyperlinks.get(workspaceId);
  queuedHyperlinks.delete(workspaceId);
  return queued ? [...queued.values()].reverse() : [];
}
