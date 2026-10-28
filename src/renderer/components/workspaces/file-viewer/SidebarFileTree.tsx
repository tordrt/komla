import {
  AppWindow,
  ArrowCounterClockwise,
  ArrowsInSimple,
  ArrowsOutSimple,
  ArrowSquareOut,
  Broadcast,
  Clipboard,
  ClockCounterClockwise,
  Copy,
  Eye,
  EyeSlash,
  FilePlus,
  FileText,
  FolderPlus,
  GitBranch,
  GitDiff,
  Globe,
  MagnifyingGlass,
  NotePencil,
  PencilSimple,
  ProhibitInset,
  Scissors,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Trash,
} from '@phosphor-icons/react';
import { themeToTreeStyles } from '@pierre/trees';
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from '@pierre/trees/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem as RadixContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { menuItemClass, menuSeparatorClass } from '@/components/ui/menu-styles';
import { Spinner } from '@/components/ui/spinner';
import { useKomlaEditorTheme } from '@/hooks/useKomlaEditorTheme';
import { createNote } from '@/lib/notes';
import { getRevealInFileManagerLabel } from '@/lib/platform-labels';
import { claimShortcutEvent } from '@/lib/shortcut-claims';
import { AT_PATH_MIME, setTreeDragActive } from '@/lib/tree-drag-token';
import { cn } from '@/lib/utils';
import { MANAGED_FILE_ROOTS } from '@/lib/workspace-file-paths';
import { useFileListStore } from '@/stores/file-list.store';
import { useFileViewerStore, type FileTreeReveal } from '@/stores/file-viewer.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspaceObservationStore } from '@/stores/workspace-observation.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isMonitored } from '@/types';

import { isBrowserPreviewableFile } from '../../../../shared/image-utils';

import { getAncestorPaths } from './file-viewer-utils';
import { NotesSection } from './notes/NotesSection';
import { useFileTreeFocusGuard } from './useFileTreeFocusGuard';

import type { FileTreeItem } from './types';
import type { PaneSurfacePlacement } from '@/lib/pane-surfaces';
import type { FileChange } from '@/types';
import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
  FileTreeDirectoryHandle,
  FileTreeItemHandle,
  FileTreeRenamingConfig,
  FileTreeSortComparator,
  GitStatusEntry,
  FileTreeIconConfig,
} from '@pierre/trees';

interface SidebarFileTreeProps {
  workspaceId: string;
  workingDirectory: string;
  isRemoteWorkspace?: boolean;
  isVisible?: boolean;
  currentFile: string | null;
  onFileSelect: (path: string) => void;
  onFileDoubleClick?: (path: string) => void;
  onDeleteFile?: (path: string, isDirectory?: boolean) => void;
  onRestoreFile?: (path: string, status: FileChange['status']) => void;
  /** Resolves true once the disk has the rename; false puts the tree back. */
  onRenameComplete?: (
    sourcePath: string,
    destinationPath: string,
    isFolder: boolean
  ) => Promise<boolean>;
  onCreateFile?: (parentDir: string) => void;
  onCreateDirectory?: (parentDir: string) => void;
  /** Resolves true once the disk has every move; false puts the tree back. */
  onMoveNodes?: (sourcePaths: string[], targetDir: string) => Promise<boolean>;
  onAddToGitignore?: (path: string, isDirectory: boolean) => void;
  onCopyNode?: (path: string, isDirectory: boolean) => void;
  onCutNode?: (path: string, isDirectory: boolean) => void;
  onPasteInto?: (targetDir: string) => void;
  hasCopiedFile?: boolean;
  changedFilesOnly?: boolean;
  changedFiles?: FileTreeItem[];
  diffFileStatuses?: Map<string, FileChange['status']>;
  diffSummary?: { additions: number; deletions: number; filesChanged: number };
  onRollbackAll?: () => void;
  side?: 'left' | 'right';
  embedded?: boolean;
  liveFollow?: boolean;
  onToggleLiveFollow?: () => void;
  comparisonBranch?: string | null;
  useMergeBase?: boolean;
  targetBranchName?: string;
  onToggleBranchComparison?: () => void;
  diffLoading?: boolean;
  onShowFileHistory?: (path: string) => void;
  onOpenHtmlInBrowser?: (path: string) => void;
  /** Opens a file in a pane among the workspace's terminals. */
  onOpenInPane?: (path: string, placement: PaneSurfacePlacement) => void;
  autoFocus?: boolean;
  // Bumped by the parent to ask the tree to realign pierre's focus with
  // currentFile, even when currentFile itself didn't change. Used to
  // recover from clicks that move pierre's focus but get rejected by the
  // parent (e.g. unsaved-changes dialog cancelled).
  focusAlignmentSignal?: number;
  // A folder to expand, select, focus and scroll to once its row is in the
  // tree, such as one a terminal link named, unless the request expired first.
  // The tree then clears the request.
  reveal?: FileTreeReveal | null;
}

function toLibStatus(status: FileChange['status'] | undefined): GitStatusEntry['status'] | null {
  switch (status) {
    case 'added':
      return 'added';
    case 'deleted':
      return 'deleted';
    case 'modified':
      return 'modified';
    case 'renamed':
      return 'renamed';
    case 'untracked':
      return 'untracked';
    default:
      return null;
  }
}

function asDirectory(item: FileTreeItemHandle | null): FileTreeDirectoryHandle | null {
  return item && item.isDirectory() ? (item as FileTreeDirectoryHandle) : null;
}

// These are imperative @pierre/trees model operations, not React state
// setters. Keep that third-party boundary explicit where effects synchronize
// an externally selected file into the tree model.
function selectTreeItem(item: FileTreeItemHandle): void {
  if (!item.isSelected()) item.select();
}

/**
 * Focuses a row, by default pierre's focused one (the one tabbable row), so
 * arrow keys and the row shortcuts work without a click first, and then calls
 * `then`. Rows render a moment after the model changes, so this retries for up
 * to half a second before falling back to the tree's container. Returns a
 * cleanup that stops waiting.
 */
function focusTreeRowSoon(
  treeHostRef: React.RefObject<HTMLElement | null>,
  containerRef: React.RefObject<HTMLElement | null>,
  path?: string,
  then?: () => void
): () => void {
  // Folder rows carry their path with a trailing slash. The sticky folder band
  // repeats rows without the treeitem role.
  const selector = path
    ? `[role="treeitem"][data-item-path="${CSS.escape(`${path}/`)}"], [role="treeitem"][data-item-path="${CSS.escape(path)}"]`
    : '[data-type="item"][tabindex="0"]';
  let attempts = 0;
  const interval = setInterval(() => {
    const row = treeHostRef.current
      ?.querySelector('file-tree-container')
      ?.shadowRoot?.querySelector<HTMLElement>(selector);
    if (!row && ++attempts < 10) return;
    clearInterval(interval);
    (row ?? containerRef.current)?.focus();
    then?.();
  }, 50);
  return () => clearInterval(interval);
}

function expandTreeItem(item: FileTreeItemHandle | null): void {
  const dir = asDirectory(item);
  if (dir && !dir.isExpanded()) dir.expand();
}

function isTreeItemFocused(item: FileTreeItemHandle): boolean {
  return item.isFocused();
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

// @pierre/trees names folders canonically with a trailing slash ("src/foo/"),
// in drop events, row menus, focus and row attributes. Everything outside the
// tree takes the plain path, so strip it wherever a path leaves the library.
function normalizeDirectoryRoot(path: string): string {
  return path.replace(/\/+$/, '');
}

/** A key pierre's tree opens its search with, when typed on a row. */
function isTreeSearchSeedKey(e: KeyboardEvent): boolean {
  return (
    e.key.length === 1 && /^[\p{L}\p{N}]$/u.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey
  );
}

// Events that bubble out of the library's shadow DOM (e.g. typing in the
// tree's rename input) are retargeted to the shadow host, so e.target reads
// as the host element. Walk composedPath() to find the real innermost target.
function isInInputContext(e: KeyboardEvent): boolean {
  const realTarget = e.composedPath()[0] as HTMLElement | undefined;
  const tag = realTarget?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || !!realTarget?.isContentEditable;
}

const REMOTE_FILE_LIST_REFRESH_INTERVAL_MS = 5_000;
// The Remote Companion's reports re-list a tree it watches, but a confirmed status doesn't prove
// it is watching: a desktop refresh confirms it too, and its watcher can fail. Check now and then.
const WATCHED_REMOTE_FILE_LIST_REFRESH_INTERVAL_MS = 60_000;

/**
 * Re-lists a remote browse tree when it comes on screen and whenever its list goes stale while
 * shown. A change in a hidden SSH workspace only marks its list stale, and a companion that
 * stopped reporting marks nothing. The first load belongs to fetchFileListIfNeeded.
 */
function useRelistShownRemoteTree({
  workspaceId,
  workingDirectory,
  isRemoteWorkspace,
  changedFilesOnly,
  isVisible,
  includeGitIgnored,
}: {
  workspaceId: string;
  workingDirectory: string;
  isRemoteWorkspace?: boolean;
  changedFilesOnly?: boolean;
  isVisible: boolean;
  includeGitIgnored: boolean;
}): void {
  const fetchFileList = useFileListStore((s) => s.fetchFileList);
  const hasList = useFileListStore((s) => !!s.getFileList(workingDirectory));
  const listIsLoading = useFileListStore((s) => !!s.getFileList(workingDirectory)?.isLoading);
  const listIsStale = useFileListStore((s) => !!s.getFileList(workingDirectory)?.isStale);
  const shownTree =
    isRemoteWorkspace && !changedFilesOnly && isVisible
      ? `${workspaceId}\0${workingDirectory}`
      : null;
  const lastShownTreeRef = useRef<string | null>(null);
  useEffect(() => {
    const justShown = shownTree !== lastShownTreeRef.current;
    lastShownTreeRef.current = shownTree;
    if (!shownTree || !hasList || listIsLoading || !(justShown || listIsStale)) return;
    void fetchFileList(workingDirectory, includeGitIgnored, workspaceId).catch(() => {});
  }, [
    fetchFileList,
    hasList,
    includeGitIgnored,
    listIsLoading,
    listIsStale,
    shownTree,
    workingDirectory,
    workspaceId,
  ]);
}

function isManagedFilePath(path: string): boolean {
  const normalized = normalizeDirectoryRoot(path);
  return MANAGED_FILE_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`)
  );
}

function isManagedWorkspaceLinkEntry(path: string, managedLinkPaths: ReadonlySet<string>): boolean {
  const normalized = normalizeDirectoryRoot(path);
  return normalized === 'linked-workspaces' || managedLinkPaths.has(normalized);
}

function isManagedFileRoot(segment: string): boolean {
  return MANAGED_FILE_ROOTS.some((root) => root === segment);
}

// localeCompare with options builds a collator on every call, which made the
// sort dominate every tree rebuild (~1.2 s for 50k paths vs ~0.12 s cached).
const naturalSegmentCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const sortManagedFoldersFirst: FileTreeSortComparator = (left, right) => {
  const sharedDepth = Math.min(left.segments.length, right.segments.length);
  for (let depth = 0; depth < sharedDepth; depth += 1) {
    const leftSegment = left.segments[depth];
    const rightSegment = right.segments[depth];
    if (leftSegment === rightSegment) continue;
    if (depth === 0) {
      const leftIsManaged = isManagedFileRoot(leftSegment);
      const rightIsManaged = isManagedFileRoot(rightSegment);
      if (leftIsManaged !== rightIsManaged) return leftIsManaged ? -1 : 1;
    }
    const leftIsDirectory = depth < left.segments.length - 1 || left.isDirectory;
    const rightIsDirectory = depth < right.segments.length - 1 || right.isDirectory;
    if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1;
    const naturalOrder = naturalSegmentCollator.compare(leftSegment, rightSegment);
    if (naturalOrder !== 0) return naturalOrder;
    return leftSegment < rightSegment ? -1 : 1;
  }
  if (left.segments.length !== right.segments.length) {
    return left.segments.length < right.segments.length ? -1 : 1;
  }
  if (left.isDirectory === right.isDirectory) return 0;
  return left.isDirectory ? -1 : 1;
};

/**
 * The deleted paths among the statuses. Every watcher event pushes a new
 * statuses Map, but the tree's paths only depend on which files are deleted,
 * so the set stays the same object while they don't change and a status push
 * doesn't hand the tree new paths.
 */
function useDeletedPaths(
  fileStatuses: ReadonlyMap<string, FileChange['status']> | undefined
): ReadonlySet<string> {
  const deletedPathsKey = useMemo(() => {
    const deleted: string[] = [];
    fileStatuses?.forEach((status, path) => {
      if (status === 'deleted') deleted.push(path);
    });
    return deleted.join('\0');
  }, [fileStatuses]);
  return useMemo(
    () => new Set(deletedPathsKey ? deletedPathsKey.split('\0') : []),
    [deletedPathsKey]
  );
}

interface DirectoryExpansionStore {
  expand: (path: string) => void;
  collapse: (path: string) => void;
}

interface DirectoryExpansionBatchModel {
  batch: (operation: (store: DirectoryExpansionStore) => void) => void;
}

// Phosphor's regular Paperclip, Link and GitBranch, painted as CSS masks
// because folder rows have no icon slot of their own (it holds the chevron).
const PAPERCLIP_ICON_PATH =
  'M209.66,122.34a8,8,0,0,1,0,11.32l-82.05,82a56,56,0,0,1-79.2-79.21L147.67,35.73a40,40,0,1,1,56.61,56.55L105,193A24,24,0,1,1,71,159L154.3,74.38A8,8,0,1,1,165.7,85.6L82.39,170.31a8,8,0,1,0,11.27,11.36L192.93,81A24,24,0,1,0,159,47L59.76,147.68a40,40,0,1,0,56.53,56.62l82.06-82A8,8,0,0,1,209.66,122.34Z';
const LINK_ICON_PATH =
  'M240,88.23a54.43,54.43,0,0,1-16,37L189.25,160a54.27,54.27,0,0,1-38.63,16h-.05A54.63,54.63,0,0,1,96,119.84a8,8,0,0,1,16,.45A38.62,38.62,0,0,0,150.58,160h0a38.39,38.39,0,0,0,27.31-11.31l34.75-34.75a38.63,38.63,0,0,0-54.63-54.63l-11,11A8,8,0,0,1,135.7,59l11-11A54.65,54.65,0,0,1,224,48,54.86,54.86,0,0,1,240,88.23ZM109,185.66l-11,11A38.41,38.41,0,0,1,70.6,208h0a38.63,38.63,0,0,1-27.29-65.94L78,107.31A38.63,38.63,0,0,1,144,135.71a8,8,0,0,0,16,.45A54.86,54.86,0,0,0,144,96a54.65,54.65,0,0,0-77.27,0L32,130.75A54.62,54.62,0,0,0,70.56,224h0a54.28,54.28,0,0,0,38.64-16l11-11A8,8,0,0,0,109,185.66Z';
const GIT_BRANCH_ICON_PATH =
  'M232,64a32,32,0,1,0-40,31v17a8,8,0,0,1-8,8H96a23.84,23.84,0,0,0-8,1.38V95a32,32,0,1,0-16,0v66a32,32,0,1,0,16,0V144a8,8,0,0,1,8-8h88a24,24,0,0,0,24-24V95A32.06,32.06,0,0,0,232,64ZM64,64A16,16,0,1,1,80,80,16,16,0,0,1,64,64ZM96,192a16,16,0,1,1-16-16A16,16,0,0,1,96,192ZM200,80a16,16,0,1,1,16-16A16,16,0,0,1,200,80Z';

function iconMask(path: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'><path d='${path}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") center / contain no-repeat`;
}

// Hide the git lane (M/U/A/D/R letters on files, rollup dot on folders).
// Filename color already conveys file status, and the folder dot was eating
// ~12px of trailing space on every row without paying for itself once the
// letters went away — filenames now get the full row width. Deleted files
// are struck through.
//
// Also keep the indent guides faintly visible rather than only on hover, and
// set the per-level indent. The library's level indent is dominated by the
// margin-left rule on adjacent spacing-items, not --trees-level-gap. Override
// those rules directly so we don't disturb the icon/text gap that
// --trees-item-row-gap also controls.
const TREE_UNSAFE_CSS = `
  [data-item-git-status='deleted'] > [data-item-section='content'] {
    text-decoration: line-through;
  }
  [data-item-section='git'],
  [data-item-section='action'] {
    display: none;
  }
  /* Pinned folders paint the tree background, which is transparent here
     (the sidebar's bg-card shows through), so give them the card color or
     the rows scrolled under them show through. */
  [data-file-tree-sticky-overlay-content='true'] {
    background-color: oklch(var(--card));
    box-shadow: 0 1px 0 oklch(var(--border));
  }
  [data-item-section='spacing-item'] {
    margin-right: 0;
    opacity: 0.6;
  }
  [data-item-section='spacing-item'] + [data-item-section='spacing-item'] {
    margin-left: 12px;
  }
  /* Hide the library's built-in search bar entirely — we render a compact
     input in the tree's top bar instead (browse mode only). The model still
     has search capability; we drive it via model.setSearch(). */
  [data-file-tree-search-container] {
    display: none;
  }
  /* Kill the residual gutter on each row's right edge. The container-level
     --trees-padding-inline-override zeros the tree's own inset, but rows
     still carry their own padding-inline that the search-box row doesn't,
     which is why filenames stopped short while the search input ran flush.
     The right inset is half the left one, so names keep that room too. */
  [data-type='item'] {
    padding-inline-end: 0;
    padding-right: 0;
    margin-inline-end: 2px;
  }
  /* Komla-owned paths remain real tree entries. Their root folders get an
     accent icon (a paperclip for attachments, a link for linked workspaces),
     each linked workspace a branch icon, and a hairline separates them from
     the project files. A root folder holding a single folder is flattened
     into one row, hence the parentless prefix match. A row opts in through
     these variables; rows without --komla-icon-content get no ::before. */
  [data-type='item']:not([data-item-parent-path])[data-item-path^='.komla-files/'] {
    --komla-icon-content: '';
    --komla-icon: ${iconMask(PAPERCLIP_ICON_PATH)};
  }
  [data-type='item']:not([data-item-parent-path])[data-item-path^='linked-workspaces/'] {
    --komla-icon-content: '';
    --komla-icon: ${iconMask(LINK_ICON_PATH)};
  }
  [data-type='item'][data-item-type='folder'][data-item-parent-path='linked-workspaces/'] {
    --komla-icon-content: '';
    --komla-icon: ${iconMask(GIT_BRANCH_ICON_PATH)};
    --komla-icon-color: oklch(var(--muted-foreground));
  }
  [data-item-section='content']::before {
    content: var(--komla-icon-content, none);
    display: inline-block;
    width: 14px;
    height: 14px;
    margin-right: 5px;
    vertical-align: -2.5px;
    background-color: var(--komla-icon-color, oklch(var(--primary)));
    -webkit-mask: var(--komla-icon);
  }
  /* The rename input fills the content box, so the icon would push it out. */
  [data-item-section='content']:has([data-item-rename-input])::before {
    display: none;
  }
  /* Inset past the rounded corners so the line stays straight. A selected
     file's card drops it. */
  :is([data-item-path^='.komla-files/'], [data-item-path^='linked-workspaces/'])
    + [data-type='item']:not(
      [data-item-path^='.komla-files/'],
      [data-item-path^='linked-workspaces/'],
      [data-item-type='file'][data-item-focused='true'],
      [data-item-type='file'][data-item-selected='true']
    ) {
    background-image: linear-gradient(oklch(var(--border)), oklch(var(--border)));
    background-size: calc(100% - 16px) 1px;
    background-position: center top;
    background-repeat: no-repeat;
  }
  /* Flatten the library's MiddleTruncate into a single nowrap line and run
     our own truncation: no forced extension, no per-segment markers, a
     single ".." cue painted at the right edge only when the name actually
     overflows. We can't use text-overflow: "..": Chromium doesn't support
     string values (still Firefox-only as of Chrome 138), so the browser
     falls back to text-overflow: ellipsis and renders "…" — which looks
     like three dots. Instead we clip natively and draw the dots ourselves
     with a ::after, toggled by a scroll-state container query.

     Making the content cell a scroll container (overflow-x: auto) gives
     Chrome 135+'s @container scroll-state(scrollable: right) something to
     match when the filename overflows. The scrollbar is hidden; no real
     user scroll happens on a tree row.

     The library renders a flex group with per-segment Truncate/Fruncate
     grids. OverflowContent wraps its two inner spans in an unlabeled <div>
     that's block by default; that <div> is what caused line wrap in the
     previous attempt. [data-truncate-grid] > * hits every direct grid
     child (including the unlabeled OverflowContent wrapper) and forces
     the whole thing inline. We hide the library's marker cell and the
     overflow measurement div so they don't intrude. */
  [data-item-section='content'] {
    position: relative;
    white-space: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    text-overflow: clip;
    container-type: scroll-state;
  }
  [data-item-section='content']::-webkit-scrollbar {
    display: none;
  }
  [data-item-section='content'] [data-truncate-group-container='middle'],
  [data-item-section='content'] [data-truncate-group-container='middle'] > *,
  [data-item-section='content'] [data-truncate-container],
  [data-item-section='content'] [data-truncate-grid],
  [data-item-section='content'] [data-truncate-grid] > *,
  [data-item-section='content'] [data-truncate-content='visible'] {
    display: inline;
  }
  [data-item-section='content'] [data-truncate-content='overflow'],
  [data-item-section='content'] [data-truncate-marker-cell] {
    display: none;
  }
  /* Custom ".." marker. Hidden by default; shown when the scroll container
     has room to scroll right (i.e. filename is cropped). Painted with the
     row bg so it masks the tail of the clipped filename underneath. */
  [data-item-section='content']::after {
    content: '..';
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    padding: 0 2px;
    background-color: oklch(var(--card));
    opacity: 0;
    pointer-events: none;
  }
  @container scroll-state(scrollable: right) {
    [data-item-section='content']::after {
      opacity: 1;
    }
  }
  /* Active file styled like a selected workspace card: no outline ring, a
     faint edge, and a brightened neutral bg. Applies to both
     focused (keyboard nav drives auto-preview) and selected (mouse click)
     — but only to files, so arrow-keying over directories doesn't light up.
     The library draws its outline via ::before on focus; neutralise it too. */
  [data-type='item'][data-item-type='file'][data-item-focused='true']::before,
  [data-type='item'][data-item-type='file'][data-item-selected='true']::before {
    outline: none;
  }
  [data-type='item'][data-item-type='file'][data-item-focused='true'],
  [data-type='item'][data-item-type='file'][data-item-selected='true'] {
    background-color: oklch(var(--accent));
    color: oklch(var(--accent-foreground));
    box-shadow: inset 0 0 0 1px oklch(var(--foreground) / 0.08);
  }
  /* Folders (and anything non-file) keep the library's default focus
     outline but drop the blue selection fill — clicking a folder should
     just move focus / toggle expansion, not light up the row. */
  [data-type='item']:not([data-item-type='file'])[data-item-focused='true'],
  [data-type='item']:not([data-item-type='file'])[data-item-selected='true'] {
    background-color: transparent;
    color: inherit;
  }
  /* Active-row ".." needs to mask against the accent bg, not the card bg. */
  [data-type='item'][data-item-type='file'][data-item-focused='true'] [data-item-section='content']::after,
  [data-type='item'][data-item-type='file'][data-item-selected='true'] [data-item-section='content']::after {
    background-color: oklch(var(--accent));
  }
`;

const MEDIA_FILE_TREE_ICONS: FileTreeIconConfig = {
  set: 'complete',
  colored: true,
  spriteSheet: `<svg data-icon-sprite aria-hidden="true" width="0" height="0">
  <symbol id="komla-file-tree-video" viewBox="0 0 16 16">
    <path fill="currentColor" d="M2.5 3h7A2.5 2.5 0 0 1 12 5.5v5A2.5 2.5 0 0 1 9.5 13h-7A2.5 2.5 0 0 1 0 10.5v-5A2.5 2.5 0 0 1 2.5 3" opacity=".35"/>
    <path fill="currentColor" d="M13.32 5.28 16 4v8l-2.68-1.28A1.5 1.5 0 0 1 12.5 9.4V6.6a1.5 1.5 0 0 1 .82-1.32M4.5 5.5v5l4-2.5z"/>
  </symbol>
  <symbol id="komla-file-tree-audio" viewBox="0 0 16 16">
    <path fill="currentColor" d="M7 3.5v6.75A2.75 2.75 0 1 1 5.5 7.8V2.5a.5.5 0 0 1 .42-.5l6-1A.5.5 0 0 1 12.5 1.5v6.75A2.75 2.75 0 1 1 11 5.8V3z" opacity=".35"/>
    <path fill="currentColor" d="M7 3.5 11 3v2.8A2.75 2.75 0 1 0 12.5 8.25V1.5a.5.5 0 0 0-.58-.5l-6 1a.5.5 0 0 0-.42.5v5.3A2.75 2.75 0 1 0 7 10.25z"/>
  </symbol>
</svg>`,
  byFileExtension: {
    mp4: 'komla-file-tree-video',
    mov: 'komla-file-tree-video',
    m4v: 'komla-file-tree-video',
    avi: 'komla-file-tree-video',
    mkv: 'komla-file-tree-video',
    webm: 'komla-file-tree-video',
    ogv: 'komla-file-tree-video',
    mp3: 'komla-file-tree-audio',
    wav: 'komla-file-tree-audio',
    m4a: 'komla-file-tree-audio',
    aac: 'komla-file-tree-audio',
    ogg: 'komla-file-tree-audio',
    flac: 'komla-file-tree-audio',
  },
};

export function SidebarFileTree({
  workspaceId,
  workingDirectory,
  isRemoteWorkspace = false,
  isVisible = true,
  currentFile,
  onFileSelect,
  onFileDoubleClick,
  onDeleteFile,
  onRestoreFile,
  onRenameComplete,
  onCreateFile,
  onCreateDirectory,
  onMoveNodes,
  onAddToGitignore,
  onCopyNode,
  onCutNode,
  onPasteInto,
  hasCopiedFile,
  changedFilesOnly,
  changedFiles,
  diffFileStatuses,
  diffSummary,
  onRollbackAll,
  side = 'left',
  embedded,
  liveFollow,
  onToggleLiveFollow,
  comparisonBranch,
  useMergeBase,
  targetBranchName,
  onToggleBranchComparison,
  diffLoading,
  onShowFileHistory,
  onOpenHtmlInBrowser,
  onOpenInPane,
  autoFocus,
  focusAlignmentSignal,
  reveal,
}: SidebarFileTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const treeHostRef = useRef<HTMLDivElement>(null);
  const emptyArray = useMemo(() => [] as string[], []);

  const fetchFileListIfNeeded = useFileListStore((s) => s.fetchFileListIfNeeded);
  const fetchFileStatusesIfNeeded = useFileListStore((s) => s.fetchFileStatusesIfNeeded);
  const fetchFileList = useFileListStore((s) => s.fetchFileList);
  const cached = useFileListStore((s) => s.getFileList(workingDirectory));
  const cachedStatuses = useFileListStore((s) => s.getFileStatuses(workingDirectory));

  const includeGitIgnored = useFileViewerStore((s) => !!s.showGitIgnoredByWorkspace[workspaceId]);
  // The Remote Companion watches an SSH workspace while one of its terminals runs.
  const monitoredByCompanion = useWorkspacesStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId);
    return !!workspace && isMonitored(workspace);
  });
  const companionConfirmed = useWorkspaceObservationStore(
    (s) => s.projections.get(workspaceId)?.confirmation.kind === 'current'
  );
  const toggleShowGitIgnored = useFileViewerStore((s) => s.toggleShowGitIgnored);

  const files = cached?.files ?? emptyArray;
  const gitIgnoredFiles = cached?.gitIgnoredFiles ?? emptyArray;
  const emptyDirs = cached?.emptyDirs ?? emptyArray;
  const managedLinkPaths = useMemo(
    () => new Set(cached?.managedLinkPaths ?? emptyArray),
    [cached?.managedLinkPaths, emptyArray]
  );
  const fileStatuses = cachedStatuses?.statuses;
  const deletedPaths = useDeletedPaths(fileStatuses);

  const loading = changedFilesOnly
    ? false
    : !cached ||
      (cached.isLoading && cached.files.length === 0 && cached.gitIgnoredFiles.length === 0);
  const showDiffSummary = changedFilesOnly && !!diffSummary;

  // Hide the file count badge when the diff summary would otherwise clip
  // behind the trailing icon buttons. ResizeObserver handles width changes;
  // a separate effect re-measures when the rendered content itself changes
  // (mode toggle or diff numbers growing), since those don't resize the
  // container. Once hidden, we only restore when enough slack returns to fit
  // the remembered badge width — avoids flicker.
  const statsRef = useRef<HTMLSpanElement>(null);
  const [hideFileCount, setHideFileCount] = useState(false);
  const hideFileCountRef = useRef(false);
  const fileCountWidthRef = useRef(0);
  const measureOverflow = useCallback(() => {
    const el = statsRef.current;
    if (!el) return;
    const isClipped = el.scrollWidth > el.clientWidth + 1;
    if (!hideFileCountRef.current) {
      if (isClipped) {
        const fcEl = el.querySelector<HTMLElement>('[data-file-count]');
        if (fcEl) fileCountWidthRef.current = fcEl.offsetWidth + 6;
        hideFileCountRef.current = true;
        setHideFileCount(true);
      }
    } else if (!isClipped) {
      const inner = el.firstElementChild as HTMLElement | null;
      const contentWidth = inner ? inner.offsetWidth : el.scrollWidth;
      const slack = el.clientWidth - contentWidth;
      if (slack >= fileCountWidthRef.current) {
        hideFileCountRef.current = false;
        setHideFileCount(false);
      }
    }
  }, []);
  useEffect(() => {
    const el = statsRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => measureOverflow());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measureOverflow]);
  useEffect(() => {
    measureOverflow();
  }, [
    measureOverflow,
    showDiffSummary,
    diffSummary?.filesChanged,
    diffSummary?.additions,
    diffSummary?.deletions,
  ]);

  useEffect(() => {
    if (changedFilesOnly) return;
    fetchFileListIfNeeded(workingDirectory, workspaceId).catch(() => {});
    if (!isRemoteWorkspace) {
      fetchFileStatusesIfNeeded(workingDirectory).catch(() => {});
    }
  }, [
    changedFilesOnly,
    isRemoteWorkspace,
    workingDirectory,
    workspaceId,
    fetchFileListIfNeeded,
    fetchFileStatusesIfNeeded,
  ]);

  const prevIncludeGitIgnoredRef = useRef(includeGitIgnored);
  useEffect(() => {
    if (includeGitIgnored && !prevIncludeGitIgnoredRef.current) {
      void fetchFileList(workingDirectory, true, workspaceId);
    }
    prevIncludeGitIgnoredRef.current = includeGitIgnored;
  }, [includeGitIgnored, workingDirectory, workspaceId, fetchFileList]);

  useRelistShownRemoteTree({
    workspaceId,
    workingDirectory,
    isRemoteWorkspace,
    changedFilesOnly,
    isVisible,
    includeGitIgnored,
  });

  // Local workspaces push filesystem watcher events, and so does the Remote
  // Companion for an SSH workspace it watches: useWorktreeWatcher marks the list
  // stale on a report whose file-list fingerprint differs from the list's. The
  // companion skips ignored files and linked workspaces, so poll often for those,
  // and when it isn't watching. It skips .komla-files too: imports re-list the tree
  // themselves, and only the slow poll sees other files land there.
  // Refresh only while a remote browse tree is mounted and visible, and never
  // overlap SSH calls.
  const companionWatchesTree =
    monitoredByCompanion &&
    companionConfirmed &&
    !includeGitIgnored &&
    !cached?.managedLinkPaths?.length;
  useEffect(() => {
    if (!isRemoteWorkspace || changedFilesOnly || !isVisible) return;
    let refreshInFlight = false;

    const refresh = () => {
      if (refreshInFlight || document.visibilityState === 'hidden') return;
      refreshInFlight = true;
      void fetchFileList(workingDirectory, includeGitIgnored, workspaceId)
        .catch(() => {})
        .finally(() => {
          refreshInFlight = false;
        });
    };
    const interval = window.setInterval(
      refresh,
      companionWatchesTree
        ? WATCHED_REMOTE_FILE_LIST_REFRESH_INTERVAL_MS
        : REMOTE_FILE_LIST_REFRESH_INTERVAL_MS
    );
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [
    changedFilesOnly,
    companionWatchesTree,
    fetchFileList,
    includeGitIgnored,
    isRemoteWorkspace,
    isVisible,
    workingDirectory,
    workspaceId,
  ]);

  // Paths to feed the tree. In diff mode, only file entries (directories in
  // the diff are rolled up through ancestor inference). In browse mode, show
  // what's on disk plus optionally .gitignored files — filter out tombstones
  // (git ls-files --cached includes tracked-but-deleted files) so clicking a
  // missing row doesn't error against the filesystem. Empty directories are
  // fed with a trailing slash so @pierre/trees marks them as directory rows
  // (normalizeInputPath keys on the trailing "/"); otherwise user-created
  // folders wouldn't appear until a file was added to them.
  // Browse mode doesn't read the changed files, so their refreshes skip it.
  const changedFilesInView = changedFilesOnly ? changedFiles : undefined;
  const paths = useMemo(() => {
    if (changedFilesOnly) {
      const uniquePaths = new Set<string>();
      for (const file of changedFilesInView ?? []) {
        if (!file.isDirectory) uniquePaths.add(file.path);
      }
      return [...uniquePaths];
    }
    // Komla-owned folders are pinned above the project files. Ignored content
    // inside a linked repository follows the ignored-files toggle like normal files.
    const managedFiles = [
      ...files.filter(isManagedFilePath),
      ...(includeGitIgnored ? gitIgnoredFiles.filter(isManagedFilePath) : []),
    ];
    const projectFiles = (includeGitIgnored ? [...files, ...gitIgnoredFiles] : files).filter(
      (path) => !isManagedFilePath(path)
    );
    const managedEmptyDirectories = [...managedLinkPaths].filter(
      (linkPath) => !managedFiles.some((path) => path.startsWith(`${linkPath}/`))
    );
    const base = [...managedFiles, ...projectFiles];
    const filtered = deletedPaths.size > 0 ? base.filter((p) => !deletedPaths.has(p)) : base;
    const visiblePaths =
      emptyDirs.length > 0 || managedEmptyDirectories.length > 0
        ? [
            ...filtered,
            ...emptyDirs.map((p) => `${p}/`),
            ...managedEmptyDirectories.map((p) => `${p}/`),
          ]
        : filtered;
    const uniquePaths = [
      ...new Set([
        ...visiblePaths.filter(isManagedFilePath),
        ...visiblePaths.filter((path) => !isManagedFilePath(path)),
      ]),
    ];
    return uniquePaths;
  }, [
    changedFilesOnly,
    changedFilesInView,
    files,
    gitIgnoredFiles,
    emptyDirs,
    includeGitIgnored,
    deletedPaths,
    managedLinkPaths,
  ]);

  const ignoredPathSet = useMemo(
    () =>
      changedFilesOnly ? null : new Set(gitIgnoredFiles.filter((path) => !isManagedFilePath(path))),
    [changedFilesOnly, gitIgnoredFiles]
  );

  const gitStatus = useMemo<GitStatusEntry[]>(() => {
    const out: GitStatusEntry[] = [];
    const source = changedFilesOnly && diffFileStatuses ? diffFileStatuses : (fileStatuses ?? null);
    if (source) {
      source.forEach((status, path) => {
        const mapped = toLibStatus(status);
        if (mapped) out.push({ path, status: mapped });
      });
    }
    // Ignored files are only in the tree while they're shown; skip tens of
    // thousands of entries the tree would otherwise re-index on every push.
    if (!changedFilesOnly && includeGitIgnored && ignoredPathSet) {
      ignoredPathSet.forEach((path) => {
        if (!source?.has(path)) {
          out.push({ path, status: 'ignored' });
        }
      });
    }
    return out;
  }, [changedFilesOnly, diffFileStatuses, fileStatuses, includeGitIgnored, ignoredPathSet]);

  // In browse mode deleted files aren't in the tree, so this is only
  // non-trivial in diff mode where a row may represent a git-deleted file.
  const isPathDeleted = useCallback(
    (path: string) => {
      const source = changedFilesOnly ? diffFileStatuses : fileStatuses;
      return source?.get(path) === 'deleted';
    },
    [changedFilesOnly, diffFileStatuses, fileStatuses]
  );

  const onMoveNodesRef = useRef(onMoveNodes);
  const onRenameCompleteRef = useRef(onRenameComplete);
  const isPathDeletedRef = useRef(isPathDeleted);
  // Assigned once useFileTreeFocusGuard runs; the tree's drop and rename
  // callbacks are created before it.
  const resyncPathsRef = useRef<() => void>(() => {});
  useEffect(() => {
    onMoveNodesRef.current = onMoveNodes;
    onRenameCompleteRef.current = onRenameComplete;
    isPathDeletedRef.current = isPathDeleted;
  }, [onMoveNodes, onRenameComplete, isPathDeleted]);

  // useFileTree reads options once on mount, so the rename config's callbacks
  // must stay live through refs — otherwise canRename would freeze the
  // isPathDeleted closure that was in scope on mount.
  const renamingConfig = useMemo<FileTreeRenamingConfig>(
    () => ({
      canRename: (item) =>
        !isRemoteWorkspace &&
        onRenameCompleteRef.current !== undefined &&
        !isPathDeletedRef.current(item.path),
      onRename: (event) => {
        const rename = onRenameCompleteRef.current;
        if (!rename) return;
        void rename(event.sourcePath, event.destinationPath, event.isFolder).then((renamed) => {
          if (!renamed) resyncPathsRef.current();
        });
      },
      onError: (message) => {
        useToastStore.getState().addToast(message, 'error');
      },
    }),
    [isRemoteWorkspace]
  );

  const { model } = useFileTree({
    paths,
    gitStatus,
    sort: sortManagedFoldersFirst,
    flattenEmptyDirectories: true,
    // Always mount closed — diff mode's "expand everything" is applied via
    // effect below. useFileTree reads options once at mount, so baking
    // initialExpansion: 'open' here would leak into normal mode after a
    // diff→normal mode switch (any directory added to the tree afterward
    // would come up expanded).
    initialExpansion: 'closed',
    dragAndDrop: isRemoteWorkspace
      ? {
          canDrag: (paths) => !paths.some((path) => isPathDeletedRef.current(path)),
          canDrop: () => false,
        }
      : onMoveNodes
        ? {
            // Diff mode shows git-deleted files as rows — they don't exist on
            // disk, so dragging them anywhere would just fail the move. In
            // browse mode deleted files aren't in the tree at all, so this
            // predicate is a no-op there.
            canDrag: (paths) => !paths.some((path) => isPathDeletedRef.current(path)),
            onDropComplete: (event) => {
              const move = onMoveNodesRef.current;
              if (!move) return;
              const targetDir = normalizeDirectoryRoot(event.target.directoryPath ?? '');
              void move(event.draggedPaths.map(normalizeDirectoryRoot), targetDir).then((moved) => {
                if (!moved) resyncPathsRef.current();
              });
            },
          }
        : false,
    renaming: renamingConfig,
    search: true,
    // Pin the folders of the rows scrolled past, like VS Code's sticky scroll.
    stickyFolders: true,
    density: 'compact',
    icons: MEDIA_FILE_TREE_ICONS,
    unsafeCSS: TREE_UNSAFE_CSS,
  });

  // Top-bar search (browse mode only — diff mode's changed-file lists are
  // short enough that search isn't worth the chrome). We hide the library's
  // built-in search bar via unsafeCSS and drive the model directly from our
  // own input. useFileTreeSearch keeps the snapshot (value + open state) in
  // sync without us holding a parallel copy.
  const search = useFileTreeSearch(model);
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  }, [search]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Clear any active search when flipping into diff mode so the diff list
  // isn't silently filtered by a stale query from browse mode.
  useEffect(() => {
    if (changedFilesOnly) model.setSearch(null);
  }, [changedFilesOnly, model]);

  // Owns model.resetPaths(paths) and the focus-watching effect that
  // routes focused-path changes to onFileSelect. The returned refs are
  // written to by the realignment effect (lastOpenedRef), the mouse/
  // drag/click handlers (focusOriginRef, justDraggedRef), the search
  // input focus handler (searchInputFocusedRef), and the search Enter
  // commit handler (lastOpenedRef). See the hook for details on the
  // pierre auto-focus suppression.
  const { searchInputFocusedRef, focusOriginRef, justDraggedRef, lastOpenedRef, resyncPaths } =
    useFileTreeFocusGuard({
      model,
      currentFile,
      paths,
      onFileSelect,
    });
  useEffect(() => {
    resyncPathsRef.current = resyncPaths;
  }, [resyncPaths]);
  const pendingSearchClickPathRef = useRef<string | null>(null);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);

  // Highlight currentFile, expand its ancestors, and scroll it into view when
  // an external mount site changes it (e.g. a tab click). The library only
  // exposes per-item select()/deselect() (no selectOnly), so we enforce
  // single-select by deselecting everything else first — otherwise each
  // arrow-key-driven preview piles the new file onto the selection set.
  // When currentFile flips to null (e.g. preview closed) we clear selection
  // so the row no longer looks active; pierre has no public unfocus API, but
  // activeItemPath clears on focusout so data-item-focused is already gone.
  //
  // `currentFileInTree` is a dep so that a search → open against a tree whose
  // file list hasn't loaded yet (e.g. the inline right-pane tree being
  // switched out of diff mode for the first time) re-applies focus once the
  // row actually shows up — without it currentFile stays unchanged through the
  // load and pierre never lands on the row. It isn't `paths`, which changes
  // whenever an agent adds or removes a file: re-running then re-expanded
  // folders the user had collapsed around the open file.
  const currentFileInTree = useFileTreeSelector(
    model,
    (m) => currentFile != null && m.getItem(currentFile) != null
  );
  useEffect(() => {
    if (!currentFile) {
      for (const selected of model.getSelectedPaths()) {
        model.getItem(selected)?.deselect();
      }
      return;
    }
    for (const ancestor of getAncestorPaths(currentFile)) {
      const dir = asDirectory(model.getItem(ancestor));
      if (dir && !dir.isExpanded()) dir.expand();
    }
    for (const selected of model.getSelectedPaths()) {
      if (selected !== currentFile) model.getItem(selected)?.deselect();
    }
    const item = model.getItem(currentFile);
    if (item) {
      selectTreeItem(item);
      if (!isTreeItemFocused(item)) {
        // Sync lastOpenedRef before moving focus. After a rejected nav
        // (unsaved-changes dialog cancelled), focusedPath still points at
        // the rejected target and lastOpenedRef was set to it just before
        // onFileSelect fired. focusPath(currentFile) updates focusedPath,
        // and the focus effect would otherwise see focusedPath !==
        // lastOpenedRef and re-fire onFileSelect(currentFile) — which
        // re-opens the file and, if the tree's mode differs from the
        // preview's, switches mode and reloads from disk, dropping the
        // user's dirty edits.
        lastOpenedRef.current = currentFile;
        // External navs (search → open, viewer tab click) happen while DOM
        // focus is elsewhere, and pierre only scrolls a focused row into
        // view while the tree owns DOM focus. scrollToPath focuses the row
        // in the model and scrolls to it, leaving DOM focus where it is.
        model.scrollToPath(currentFile);
      }
    }
  }, [currentFile, model, focusAlignmentSignal, lastOpenedRef, currentFileInTree]);

  // Show a folder asked for from outside, once its row exists: the file list
  // can still be loading, as when the tree just switched to its files. The row
  // takes focus, so it shows the focus ring. Selecting or focusing a folder
  // opens nothing, since the focus guard skips folders.
  const revealPath = reveal?.path ?? null;
  const revealExpiresAt = reveal?.expiresAt ?? 0;
  const revealPathInTree = useFileTreeSelector(
    model,
    (m) => revealPath != null && m.getItem(revealPath) != null
  );
  useEffect(() => {
    if (!revealPath || !revealPathInTree) return;
    if (Date.now() > revealExpiresAt) {
      useFileViewerStore.getState().clearFileTreeReveal(workspaceId, revealPath);
      return;
    }
    for (const path of [...getAncestorPaths(revealPath), revealPath]) {
      expandTreeItem(model.getItem(path));
    }
    for (const selected of model.getSelectedPaths()) {
      model.getItem(selected)?.deselect();
    }
    const item = model.getItem(revealPath);
    if (item) selectTreeItem(item);
    model.scrollToPath(revealPath);
    // The request clears once focused: clearing it re-runs this effect, whose
    // cleanup would cancel the focus.
    return focusTreeRowSoon(treeHostRef, containerRef, revealPath, () =>
      useFileViewerStore.getState().clearFileTreeReveal(workspaceId, revealPath)
    );
  }, [revealPath, revealExpiresAt, revealPathInTree, model, workspaceId]);

  // Primary path for mouse-driven preview. Using `click` instead of firing on
  // mousedown-driven focus changes means a gesture that turns into a drag
  // (e.g. moving a file to another folder) never opens the preview — the
  // browser suppresses click when a drag intervenes. Tradeoff: preview opens
  // on mouseup rather than mousedown, imperceptible in practice.
  //
  // Capture-phase mousedown sets focusOriginRef = 'mouse' so the focus effect
  // above stands down for this gesture and leaves preview to this handler.
  // Re-clicking the already-focused row (toggle-closed / reopen-after-close)
  // doesn't move focus and so doesn't fire the focus effect at all; this
  // listener is the only path that covers it. The tree renders inside a
  // shadow DOM, so events bubble out with the target retargeted to the host
  // — walk composedPath() for the real innermost target.
  useEffect(() => {
    const host = treeHostRef.current;
    if (!host) return;
    const getFileRowPath = (e: Event) => {
      const realTarget = e.composedPath()[0];
      if (!(realTarget instanceof Element)) return null;
      const row = realTarget.closest('[data-type="item"]');
      if (!row) return null;
      if (row.getAttribute('data-item-type') !== 'file') return null;
      return row.getAttribute('data-item-path');
    };
    const onMouseDown = (e: MouseEvent) => {
      focusOriginRef.current = 'mouse';
      justDraggedRef.current = false;
      if (e.button !== 0) return;
      if (!searchInputFocusedRef.current) return;
      const path = getFileRowPath(e);
      if (!path) return;
      // Pierre may clear/reproject search results before click delivery.
      // Capture the pressed result, but still wait for click so a drag can
      // suppress navigation.
      pendingSearchClickPathRef.current = path;
    };
    const onDragStart = (e: DragEvent) => {
      // Augment pierre's dragstart payload with the komla @-path form so
      // drop targets inside the app (currently: terminals) can paste a
      // reference to the dragged file. Pierre sets text/plain to the raw
      // workspace-relative path for its own bookkeeping; we don't touch
      // that, we just add our own MIME. Keep this string in sync with the
      // matching constant in TerminalView.tsx.
      if (!e.dataTransfer) return;
      const realTarget = e.composedPath()[0];
      if (!(realTarget instanceof Element)) return;
      const row = realTarget.closest('[data-type="item"]');
      if (!row) return;
      const rowPath = row.getAttribute('data-item-path');
      if (!rowPath) return;
      const path = normalizeDirectoryRoot(rowPath);
      pendingSearchClickPathRef.current = null;
      const isDir = row.getAttribute('data-item-type') === 'folder';
      // Trailing space so the user can immediately type after the paste
      // without having to reach for space. Same convention as the copy-@path
      // actions in FileViewerDialog / the command center and the row context menu.
      e.dataTransfer.setData(AT_PATH_MIME, `@${path}${isDir ? '/' : ''} `);
      // Flag the drag as originating from our tree so terminal drop targets
      // can tell our own drags from externally-spoofed MIME payloads.
      setTreeDragActive(true);
    };
    const onDragEnd = () => {
      justDraggedRef.current = true;
      setTreeDragActive(false);
    };
    const onClick = (e: MouseEvent) => {
      // Drop the mouse-origin flag now that the click has landed. If
      // mousedown moved focus to a new row, the focus effect already saw
      // 'mouse' and consumed the flag. If it didn't (re-click on the
      // already-focused row), the flag would otherwise stay set and gate
      // the next arrow-driven focus change as if it were mouse-driven —
      // silently swallowing the user's first arrow press.
      focusOriginRef.current = null;
      if (justDraggedRef.current) {
        justDraggedRef.current = false;
        return;
      }
      const path = pendingSearchClickPathRef.current ?? getFileRowPath(e);
      pendingSearchClickPathRef.current = null;
      if (!path) return;
      lastOpenedRef.current = path;
      onFileSelect(path);
    };
    host.addEventListener('mousedown', onMouseDown, true);
    host.addEventListener('dragstart', onDragStart, true);
    host.addEventListener('dragend', onDragEnd, true);
    host.addEventListener('click', onClick);
    return () => {
      host.removeEventListener('mousedown', onMouseDown, true);
      host.removeEventListener('dragstart', onDragStart, true);
      host.removeEventListener('dragend', onDragEnd, true);
      host.removeEventListener('click', onClick);
    };
  }, [onFileSelect, focusOriginRef, justDraggedRef, searchInputFocusedRef, lastOpenedRef]);

  // Double-click to promote preview → real tab. The library doesn't expose a
  // dblclick callback, so we listen on the tree host and read data attributes
  // the library already stamps on each row (data-item-path / data-item-type).
  // The tree renders inside a shadow DOM, so dblclick bubbles out with its
  // target retargeted to the host — walk composedPath() for the real target.
  useEffect(() => {
    if (!onFileDoubleClick) return;
    const host = treeHostRef.current;
    if (!host) return;
    const handler = (e: MouseEvent) => {
      const realTarget = e.composedPath()[0];
      if (!(realTarget instanceof Element)) return;
      const row = realTarget.closest('[data-type="item"]');
      if (!row) return;
      if (row.getAttribute('data-item-type') !== 'file') return;
      const path = row.getAttribute('data-item-path');
      if (!path) return;
      e.preventDefault();
      onFileDoubleClick(path);
    };
    host.addEventListener('dblclick', handler);
    return () => host.removeEventListener('dblclick', handler);
  }, [onFileDoubleClick]);

  // All directory paths in the current tree — computed from `paths` by taking
  // every prefix. Used for expand-all / collapse-all.
  const allDirectoryPaths = useMemo(() => {
    const dirs = new Set<string>();
    for (const p of paths) {
      let parent = parentOf(p);
      while (parent) {
        dirs.add(parent);
        parent = parentOf(parent);
      }
    }
    return Array.from(dirs);
  }, [paths]);

  // Pass a root path to scope the action to that folder's subtree (used by
  // the row context menu). Called with no arg from the root context menu,
  // which expands/collapses the whole tree. The root itself is included in
  // the subtree so expand-all on a collapsed folder opens it plus descendants.
  const expandAll = useCallback(
    (root?: string) => {
      const normalizedRoot = root == null ? undefined : normalizeDirectoryRoot(root);
      (model as unknown as DirectoryExpansionBatchModel).batch((store) => {
        for (const path of allDirectoryPaths) {
          if (
            normalizedRoot != null &&
            path !== normalizedRoot &&
            !path.startsWith(`${normalizedRoot}/`)
          ) {
            continue;
          }
          const dir = asDirectory(model.getItem(path));
          if (dir && !dir.isExpanded()) store.expand(path);
        }
      });
    },
    [allDirectoryPaths, model]
  );

  const collapseAll = useCallback(
    (root?: string) => {
      const normalizedRoot = root == null ? undefined : normalizeDirectoryRoot(root);
      (model as unknown as DirectoryExpansionBatchModel).batch((store) => {
        for (const path of allDirectoryPaths) {
          if (
            normalizedRoot != null &&
            path !== normalizedRoot &&
            !path.startsWith(`${normalizedRoot}/`)
          ) {
            continue;
          }
          const dir = asDirectory(model.getItem(path));
          if (dir && dir.isExpanded()) store.collapse(path);
        }
      });
    },
    [allDirectoryPaths, model]
  );

  // Drive mode-based expansion imperatively.
  //
  // On entering diff mode, expand every directory once so the (usually small)
  // changed-file set is fully visible. While in diff mode, only auto-expand
  // *newly-appearing* directories — never re-expand a directory the user has
  // explicitly collapsed. On switching out of diff mode, collapse all to drop
  // stale open state, then re-open the chain to currentFile so it stays
  // visible (the currentFile-sync effect only fires on currentFile changes,
  // not on a mode flip).
  //
  // currentFile is read through a ref so the effect doesn't re-run — and
  // re-touch expansion state — every time the user just navigates between
  // files. lastExpandedMode starts null so an initial mount in diff mode is
  // treated as a transition into diff and gets the one-time expand-all.
  // Late-arriving paths (empty at transition time, populated later) are
  // handled by the steady-state branch below, which treats them as newly
  // appearing and expands them — so we always claim the transition here,
  // even if allDirectoryPaths is currently empty.
  const lastExpandedModeRef = useRef<'diff' | 'normal' | null>(null);
  const prevDiffDirsRef = useRef<Set<string>>(new Set());
  const currentFileRef = useRef(currentFile);
  useEffect(() => {
    currentFileRef.current = currentFile;
  }, [currentFile]);
  useEffect(() => {
    const current: 'diff' | 'normal' = changedFilesOnly ? 'diff' : 'normal';
    const prev = lastExpandedModeRef.current;

    if (current === 'diff' && prev !== 'diff') {
      for (const path of allDirectoryPaths) {
        const dir = asDirectory(model.getItem(path));
        if (dir && !dir.isExpanded()) dir.expand();
      }
      prevDiffDirsRef.current = new Set(allDirectoryPaths);
      lastExpandedModeRef.current = 'diff';
      return;
    }

    if (current !== 'diff' && prev === 'diff') {
      for (const path of allDirectoryPaths) {
        const dir = asDirectory(model.getItem(path));
        if (dir && dir.isExpanded()) dir.collapse();
      }
      const focused = currentFileRef.current;
      if (focused) {
        for (const ancestor of getAncestorPaths(focused)) {
          const dir = asDirectory(model.getItem(ancestor));
          if (dir && !dir.isExpanded()) dir.expand();
        }
      }
      prevDiffDirsRef.current = new Set();
      lastExpandedModeRef.current = 'normal';
      return;
    }

    // Steady state inside diff mode: reveal newly-appearing directories so
    // new diff content surfaces, but leave previously-seen directories alone
    // — that's where the user's collapse decisions live.
    if (current === 'diff') {
      const prevDirs = prevDiffDirsRef.current;
      for (const path of allDirectoryPaths) {
        if (prevDirs.has(path)) continue;
        const dir = asDirectory(model.getItem(path));
        if (dir && !dir.isExpanded()) dir.expand();
      }
      prevDiffDirsRef.current = new Set(allDirectoryPaths);
    }
  }, [changedFilesOnly, allDirectoryPaths, model]);

  // Tracks open row context menus so tree-level keyboard shortcuts don't
  // silently act on the row underneath. Right-click leaves focus on the row,
  // and our custom menu doesn't intercept keys — without this guard, Delete
  // on a file row while the menu is open would destructively fire onDeleteFile.
  // Ref-counted because React StrictMode double-invokes effects; a plain
  // boolean could get stuck on.
  const menuOpenCountRef = useRef(0);

  // Enter / Delete / Cmd+C / Cmd+X / Cmd+V on the focused row. Only keys
  // pressed on the tree, or on the panel itself (focused before the rows
  // load), count: not ones pressed on the header, Notes or another mounted
  // tree. Listening here runs before the file viewer's window listener, which
  // skips claimed keys.
  useEffect(() => {
    const container = containerRef.current;
    const host = treeHostRef.current;
    if (!container || !host) return;

    const handleEnter = (focusedPath: string | null) => {
      if (!focusedPath || !onFileDoubleClick) return false;
      const item = model.getItem(focusedPath);
      if (!item || item.isDirectory()) return false;
      onFileDoubleClick(focusedPath);
      return true;
    };

    const handleDelete = (focusedPath: string | null) => {
      if (!focusedPath || !onDeleteFile) return false;
      if (
        isPathDeleted(focusedPath) ||
        isManagedWorkspaceLinkEntry(focusedPath, managedLinkPaths)
      ) {
        return false;
      }
      const item = model.getItem(focusedPath);
      if (!item) return false;
      if (item.isDirectory()) onDeleteFile(focusedPath, true);
      else onDeleteFile(focusedPath);
      return true;
    };

    const handleCopy = (focusedPath: string | null) => {
      if (isRemoteWorkspace || !focusedPath || !onCopyNode) return false;
      const item = model.getItem(focusedPath);
      if (!item) return false;
      onCopyNode(focusedPath, item.isDirectory());
      return true;
    };

    const handleCut = (focusedPath: string | null) => {
      if (isRemoteWorkspace || !focusedPath || !onCutNode) return false;
      const item = model.getItem(focusedPath);
      if (!item) return false;
      onCutNode(focusedPath, item.isDirectory());
      return true;
    };

    const handlePaste = (focusedPath: string | null) => {
      if (isRemoteWorkspace || !hasCopiedFile || !onPasteInto) return false;
      if (!focusedPath) {
        onPasteInto('');
        return true;
      }
      const item = model.getItem(focusedPath);
      if (item?.isDirectory()) {
        onPasteInto(focusedPath);
      } else {
        onPasteInto(parentOf(focusedPath));
      }
      return true;
    };

    const handler = (e: KeyboardEvent) => {
      if (e.target !== container && !host.contains(e.target as Node)) return;
      if (menuOpenCountRef.current > 0) return;
      if (isInInputContext(e)) return;

      // Pierre drops letters typed on a row while its search is open, so add
      // them to the query, where the user meant them to go.
      const openSearch = searchRef.current;
      if (openSearch.isOpen && isTreeSearchSeedKey(e)) {
        openSearch.setValue(openSearch.value + e.key);
        searchInputRef.current?.focus();
        e.preventDefault();
        return;
      }

      const treeFocusedPath = model.getFocusedPath();
      const focusedPath = treeFocusedPath && normalizeDirectoryRoot(treeFocusedPath);
      const noMods = !e.metaKey && !e.ctrlKey && !e.altKey;
      const cmd = e.metaKey || e.ctrlKey;

      let handled = false;
      if (e.key === 'Enter' && noMods && !e.shiftKey) {
        handled = handleEnter(focusedPath);
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        (noMods || (e.key === 'Backspace' && e.metaKey && !e.ctrlKey && !e.altKey))
      ) {
        handled = handleDelete(focusedPath);
      } else if (cmd && e.key === 'c') {
        handled = handleCopy(focusedPath);
      } else if (cmd && e.key === 'x') {
        handled = handleCut(focusedPath);
      } else if (cmd && e.key === 'v') {
        handled = handlePaste(focusedPath);
      }
      if (!handled) return;
      e.preventDefault();
      claimShortcutEvent(e);
    };
    container.addEventListener('keydown', handler);
    return () => container.removeEventListener('keydown', handler);
  }, [
    model,
    onDeleteFile,
    onCopyNode,
    onCutNode,
    onPasteInto,
    onFileDoubleClick,
    hasCopiedFile,
    isPathDeleted,
    isRemoteWorkspace,
    managedLinkPaths,
  ]);

  // Pierre opens its search on any letter or digit typed on a row. The changes
  // view has no search, so keep those keys from pierre and pass them on, out
  // of the tree, to the file viewer's shortcuts (j/k, n/p, 1/2).
  useEffect(() => {
    const host = treeHostRef.current;
    if (!host || !changedFilesOnly) return;
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.target === host || !isTreeSearchSeedKey(e) || isInInputContext(e)) return;
      e.stopPropagation();
      const forwarded = new KeyboardEvent('keydown', e);
      host.parentElement?.dispatchEvent(forwarded);
      if (forwarded.defaultPrevented) e.preventDefault();
    };
    host.addEventListener('keydown', onKeyDownCapture, true);
    return () => host.removeEventListener('keydown', onKeyDownCapture, true);
  }, [changedFilesOnly]);

  useEffect(() => {
    if (!autoFocus) return;
    return focusTreeRowSoon(treeHostRef, containerRef);
  }, [autoFocus]);

  const startRenaming = useCallback((path: string) => model.startRenaming(path), [model]);

  const renderRowContextMenu = useCallback(
    (treeItem: TreeContextMenuItem, ctx: TreeContextMenuOpenContext) => {
      const item = { ...treeItem, path: normalizeDirectoryRoot(treeItem.path) };
      const fileStatus =
        (changedFilesOnly ? diffFileStatuses : fileStatuses)?.get(item.path) ?? undefined;
      const isDeleted = item.kind === 'file' && fileStatus === 'deleted';
      // Suppress empty menus. Directories always have at least Expand/Collapse
      // and Copy @path; file rows can hit zero items in branch-comparison mode
      // for deleted files (no rollback, no @path, no reveal). We can't just
      // return null — @pierre/trees still mounts a click-capturing wash
      // overlay while contextMenuState is non-null, so the right-click would
      // appear to do nothing but consume the next click. Render a tiny
      // closer that calls ctx.close() in a layout effect instead.
      if (item.kind === 'file') {
        const hasAnyItem =
          !isDeleted ||
          (!isRemoteWorkspace && !!hasCopiedFile && !!onPasteInto) ||
          (!!onRestoreFile && !!fileStatus) ||
          !!onShowFileHistory;
        if (!hasAnyItem) return <EmptyMenuCloser ctx={ctx} />;
      }
      return (
        <RowContextMenu
          item={item}
          ctx={ctx}
          isDeleted={isDeleted}
          workingDirectory={workingDirectory}
          isRemoteWorkspace={isRemoteWorkspace}
          fileStatus={fileStatus}
          isGitIgnored={!changedFilesOnly && !!ignoredPathSet?.has(item.path)}
          hasCopiedFile={!!hasCopiedFile}
          canRename={!!onRenameComplete}
          onCreateFile={onCreateFile}
          onCreateDirectory={onCreateDirectory}
          onStartRename={startRenaming}
          onDeleteFile={
            isManagedWorkspaceLinkEntry(item.path, managedLinkPaths) ? undefined : onDeleteFile
          }
          onRestoreFile={onRestoreFile}
          onCopyNode={onCopyNode}
          onCutNode={onCutNode}
          onPasteInto={onPasteInto}
          onAddToGitignore={onAddToGitignore}
          onShowFileHistory={onShowFileHistory}
          onOpenHtmlInBrowser={onOpenHtmlInBrowser}
          onOpenInPane={onOpenInPane}
          onNewNote={() => void createNote(workspaceId)}
          onExpandAll={() => expandAll(item.kind === 'directory' ? item.path : undefined)}
          onCollapseAll={() => collapseAll(item.kind === 'directory' ? item.path : undefined)}
          openCountRef={menuOpenCountRef}
        />
      );
    },
    [
      workspaceId,
      workingDirectory,
      isRemoteWorkspace,
      changedFilesOnly,
      diffFileStatuses,
      fileStatuses,
      ignoredPathSet,
      hasCopiedFile,
      onCreateFile,
      onCreateDirectory,
      onRenameComplete,
      startRenaming,
      onDeleteFile,
      onRestoreFile,
      onCopyNode,
      onCutNode,
      onPasteInto,
      onAddToGitignore,
      onShowFileHistory,
      onOpenHtmlInBrowser,
      onOpenInPane,
      expandAll,
      collapseAll,
      managedLinkPaths,
    ]
  );

  const handleSearchFocusChange = useCallback(
    (focused: boolean) => {
      searchInputFocusedRef.current = focused;
    },
    [searchInputFocusedRef]
  );

  const handleSearchEnter = useCallback(() => {
    // With no match the focused row is hidden behind NoSearchMatches.
    if (search.value && search.matchingPaths.length === 0) return false;
    const path = model.getFocusedPath();
    if (!path) return false;
    const item = model.getItem(path);
    if (!item || item.isDirectory()) return false;
    lastOpenedRef.current = path;
    onFileSelect(path);
    return true;
  }, [model, onFileSelect, lastOpenedRef, search.value, search.matchingPaths]);

  const editorTheme = useKomlaEditorTheme();
  const treeStyle = useMemo(
    () =>
      ({
        ...(themeToTreeStyles(editorTheme) as React.CSSProperties),
        // Library default is 16px — leaves a wide gutter on each side of the
        // tree. Zero it so filenames can run edge-to-edge.
        '--trees-padding-inline-override': '0px',
        // Collapse the git lane; we `display: none` its contents in unsafeCSS
        // but the lane itself still reserves 12px per row by default.
        '--trees-git-lane-width-override': '0px',
        // Same story for the action lane (hover menu trigger affordance) —
        // ~18px reserved on every row's right edge that we don't use.
        '--trees-action-lane-width-override': '0px',
        // Inset rows a little from the container edges, so a row's hover and
        // selection read as rounded shapes at the app's corner radius.
        '--trees-item-margin-x-override': '4px',
        '--trees-border-radius-override': 'var(--radius)',
        // Poppier git-status filename colors. Shiki's gitDecoration tokens
        // render a bit muted against our editor bg; the --git-* vars provide
        // mode-aware values (lighter on dark, darker on light) for AA contrast.
        '--trees-git-added-color-override': 'var(--git-added)',
        '--trees-git-untracked-color-override': 'var(--git-untracked)',
        '--trees-git-modified-color-override': 'var(--git-modified)',
        '--trees-git-deleted-color-override': 'var(--git-deleted)',
        '--trees-git-renamed-color-override': 'var(--git-renamed)',
        // Make the tree fully transparent and let the surrounding chrome
        // (bg-card on the sidebar wrapper in both embedded and dialog cases)
        // show through. themeToTreeStyles writes a raw backgroundColor of the
        // Shiki sideBar.background onto the host as an inline style — which
        // beats :host { background-color: var(--trees-bg) } on specificity.
        // Clear it explicitly so the --trees-bg-override actually takes
        // effect, and belt-and-suspenders the override to transparent too.
        backgroundColor: 'transparent',
        '--trees-bg-override': 'transparent',
        // Search input and border align with the now-transparent tree so the
        // whole thing reads as one panel painted by the container.
        '--trees-search-bg-override': 'transparent',
        '--trees-border-color-override': 'oklch(var(--border))',
      }) as React.CSSProperties,
    [editorTheme]
  );

  // A fresh workspace has nothing to list; say so instead of a blank panel.
  // Wait for the diff summary so this doesn't flash while the diff loads.
  const showNoChanges = !!changedFilesOnly && paths.length === 0 && diffSummary?.filesChanged === 0;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={cn(
        'thin-scrollbar flex min-h-0 flex-col outline-hidden',
        embedded ? 'flex-1' : cn('w-64 shrink-0', side === 'right' ? 'border-l' : 'border-r')
      )}
    >
      <SidebarFileTreeHeader
        statsRef={statsRef}
        changedFilesOnly={changedFilesOnly}
        hideFileCount={hideFileCount}
        diffSummary={diffSummary}
        search={search}
        onSearchFocusChange={handleSearchFocusChange}
        onSearchEnter={handleSearchEnter}
        searchInputRef={searchInputRef}
        workspaceId={workspaceId}
        includeGitIgnored={includeGitIgnored}
        toggleShowGitIgnored={toggleShowGitIgnored}
        onToggleBranchComparison={onToggleBranchComparison}
        comparisonBranch={comparisonBranch}
        useMergeBase={useMergeBase}
        targetBranchName={targetBranchName}
        diffLoading={diffLoading}
        onToggleLiveFollow={onToggleLiveFollow}
        liveFollow={liveFollow}
        isRemoteWorkspace={isRemoteWorkspace}
        onCreateFile={onCreateFile}
      />
      <NotesSection workspaceId={workspaceId} currentFile={currentFile} />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={treeHostRef}
            className={cn('relative min-h-0 flex-1', embedded && 'bg-transparent')}
          >
            {loading ? (
              <div className="p-3 text-sm text-muted-foreground">Loading...</div>
            ) : !changedFilesOnly && paths.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">No files</div>
            ) : showNoChanges ? (
              <NoChangesState comparisonBranch={comparisonBranch} useMergeBase={useMergeBase} />
            ) : (
              <FileTree
                className="h-full"
                model={model}
                style={treeStyle}
                renderContextMenu={renderRowContextMenu}
              />
            )}
            <NoSearchMatches search={search} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {!isRemoteWorkspace && onCreateFile && (
            <RadixContextMenuItem onSelect={() => onCreateFile('')}>
              <FilePlus />
              New File
            </RadixContextMenuItem>
          )}
          {!isRemoteWorkspace && onCreateDirectory && (
            <RadixContextMenuItem onSelect={() => onCreateDirectory('')}>
              <FolderPlus />
              New Folder
            </RadixContextMenuItem>
          )}
          <RadixContextMenuItem onSelect={() => void createNote(workspaceId)}>
            <NotePencil />
            New Note
          </RadixContextMenuItem>
          <ContextMenuSeparator />
          <RadixContextMenuItem onSelect={() => expandAll()}>
            <ArrowsOutSimple />
            Expand All
          </RadixContextMenuItem>
          <RadixContextMenuItem onSelect={() => collapseAll()}>
            <ArrowsInSimple />
            Collapse All
          </RadixContextMenuItem>
          {!isRemoteWorkspace && hasCopiedFile && onPasteInto && (
            <>
              <ContextMenuSeparator />
              <RadixContextMenuItem onSelect={() => onPasteInto('')}>
                <Clipboard />
                Paste
              </RadixContextMenuItem>
            </>
          )}
          {!isRemoteWorkspace && (
            <>
              <ContextMenuSeparator />
              <RadixContextMenuItem onSelect={() => window.api.showItemInFolder(workingDirectory)}>
                <MagnifyingGlass />
                {getRevealInFileManagerLabel()}
              </RadixContextMenuItem>
            </>
          )}
          {onRollbackAll && (
            <>
              <ContextMenuSeparator />
              <RadixContextMenuItem onSelect={onRollbackAll} variant="destructive">
                <ArrowCounterClockwise />
                Rollback All Changes
              </RadixContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

/** With no match, pierre falls back to showing the whole tree; cover it. */
function NoSearchMatches({ search }: { search: ReturnType<typeof useFileTreeSearch> }) {
  if (!search.value || search.matchingPaths.length > 0) return null;
  return (
    <div className="absolute inset-0 bg-card p-3 text-sm text-muted-foreground">
      No files match “{search.value}”
    </div>
  );
}

function NoChangesState({
  comparisonBranch,
  useMergeBase,
}: {
  comparisonBranch?: string | null;
  useMergeBase?: boolean;
}) {
  if (comparisonBranch) {
    return (
      <EmptyState
        size="sm"
        icon={<GitDiff weight="duotone" />}
        title={
          useMergeBase
            ? `No changes since ${comparisonBranch}`
            : `No differences from ${comparisonBranch}`
        }
        description={
          useMergeBase
            ? 'Nothing has been committed or edited on this branch yet.'
            : 'The working tree matches this branch.'
        }
      />
    );
  }
  return (
    <EmptyState
      size="sm"
      icon={<GitDiff weight="duotone" />}
      title="No changes yet"
      description="Files you or your agent edit show up here."
    />
  );
}

// ---------------------------------------------------------------------------
// Top-bar header (stats / search input + action buttons)
// ---------------------------------------------------------------------------

interface SidebarFileTreeHeaderProps {
  statsRef: React.RefObject<HTMLSpanElement | null>;
  changedFilesOnly: boolean | undefined;
  hideFileCount: boolean;
  diffSummary?: { additions: number; deletions: number; filesChanged: number };
  search: ReturnType<typeof useFileTreeSearch>;
  onSearchFocusChange: (focused: boolean) => void;
  onSearchEnter: () => boolean;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  workspaceId: string;
  includeGitIgnored: boolean;
  toggleShowGitIgnored: (workspaceId: string) => void;
  onToggleBranchComparison?: () => void;
  comparisonBranch?: string | null;
  useMergeBase?: boolean;
  targetBranchName?: string;
  diffLoading?: boolean;
  onToggleLiveFollow?: () => void;
  liveFollow?: boolean;
  isRemoteWorkspace: boolean;
  onCreateFile?: (parentDir: string) => void;
}

function SidebarFileTreeHeader({
  statsRef,
  changedFilesOnly,
  hideFileCount,
  diffSummary,
  search,
  onSearchFocusChange,
  onSearchEnter,
  searchInputRef,
  workspaceId,
  includeGitIgnored,
  toggleShowGitIgnored,
  onToggleBranchComparison,
  comparisonBranch,
  useMergeBase,
  targetBranchName,
  diffLoading,
  onToggleLiveFollow,
  liveFollow,
  isRemoteWorkspace,
  onCreateFile,
}: SidebarFileTreeHeaderProps) {
  const showDiffSummary = !!changedFilesOnly && !!diffSummary && diffSummary.filesChanged > 0;
  const branchComparisonLabel =
    comparisonBranch && useMergeBase
      ? 'Show uncommitted changes'
      : `Show all changes since ${targetBranchName || 'target branch'}`;
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-0 border-b bg-card pr-1 pl-2.5 text-sm font-medium">
      <span ref={statsRef} className="flex min-w-0 flex-1 items-center overflow-hidden">
        {showDiffSummary && diffSummary ? (
          <span
            className="flex w-max items-center gap-0.5 font-mono text-xs"
            aria-label={`${diffSummary.filesChanged} files changed, ${diffSummary.additions} additions, ${diffSummary.deletions} deletions`}
          >
            {!hideFileCount && (
              <span
                data-file-count
                aria-hidden="true"
                className="inline-flex items-center gap-0.5 px-0.5 text-ui text-muted-foreground"
              >
                <FileText className="size-3" weight="bold" />
                {diffSummary.filesChanged}
              </span>
            )}
            {diffSummary.additions > 0 && (
              <span aria-hidden="true" className="px-0.5 text-ui text-success">
                +{diffSummary.additions}
              </span>
            )}
            {diffSummary.deletions > 0 && (
              <span aria-hidden="true" className="px-0.5 text-ui text-error">
                -{diffSummary.deletions}
              </span>
            )}
          </span>
        ) : changedFilesOnly ? (
          <span className="text-xs font-medium text-muted-foreground">Files</span>
        ) : (
          <SidebarFileTreeSearchInput
            search={search}
            inputRef={searchInputRef}
            onFocusChange={onSearchFocusChange}
            onEnter={onSearchEnter}
          />
        )}
      </span>
      <div className="flex shrink-0 items-center gap-0">
        {/* The empty-area menu has this too, but a long tree leaves no empty
            area to right-click. */}
        {!changedFilesOnly && !isRemoteWorkspace && onCreateFile && (
          <IconButton
            label="New file"
            size="xs"
            tooltipSide="bottom"
            onClick={() => onCreateFile('')}
            className="text-muted-foreground/60 hover:text-muted-foreground"
          >
            <FilePlus className="size-3.5" />
          </IconButton>
        )}
        {!changedFilesOnly && (
          <IconButton
            label={includeGitIgnored ? 'Hide ignored files' : 'Show ignored files'}
            size="xs"
            tooltipSide="bottom"
            onClick={() => toggleShowGitIgnored(workspaceId)}
            className={cn(
              !includeGitIgnored && 'text-muted-foreground/60 hover:text-muted-foreground'
            )}
          >
            {includeGitIgnored ? <Eye className="size-3.5" /> : <EyeSlash className="size-3.5" />}
          </IconButton>
        )}
        {onToggleBranchComparison && changedFilesOnly && (
          <IconButton
            label={diffLoading ? 'Loading changes' : branchComparisonLabel}
            size="xs"
            tooltipSide="bottom"
            onClick={onToggleBranchComparison}
            disabled={diffLoading}
            className={cn(
              comparisonBranch && useMergeBase
                ? 'text-primary hover:text-primary/80'
                : 'text-muted-foreground/60 hover:text-muted-foreground'
            )}
          >
            {diffLoading ? (
              <Spinner size="sm" />
            ) : (
              <GitBranch aria-hidden="true" className="size-3.5" />
            )}
          </IconButton>
        )}
        {onToggleLiveFollow && (
          <IconButton
            label={liveFollow ? 'Stop following changes' : 'Follow latest changes'}
            size="xs"
            tooltipSide="bottom"
            onClick={onToggleLiveFollow}
            className={cn(
              liveFollow
                ? 'text-primary hover:text-primary/80'
                : 'text-muted-foreground/60 hover:text-muted-foreground'
            )}
          >
            <Broadcast className="size-3.5" />
          </IconButton>
        )}
      </div>
    </div>
  );
}

interface SidebarFileTreeSearchInputProps {
  search: ReturnType<typeof useFileTreeSearch>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFocusChange: (focused: boolean) => void;
  onEnter: () => boolean;
}

function SidebarFileTreeSearchInput({
  search,
  inputRef,
  onFocusChange,
  onEnter,
}: SidebarFileTreeSearchInputProps) {
  // Typing on a focused row opens pierre's own search, whose input we hide,
  // so move focus here for the rest of the query to land in a visible box.
  useEffect(() => {
    const input = inputRef.current;
    if (!search.isOpen || !input || document.activeElement === input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [search.isOpen, inputRef]);
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Escape always leaves search, and never also closes the file preview beside the tree.
    if (e.key === 'Escape') {
      e.preventDefault();
      search.setValue(null);
      (e.target as HTMLInputElement).blur();
      return;
    }
    if (e.key === 'ArrowDown' && search.value) {
      e.preventDefault();
      search.focusNextMatch();
      return;
    }
    if (e.key === 'ArrowUp' && search.value) {
      e.preventDefault();
      search.focusPreviousMatch();
      return;
    }
    if (e.key === 'Enter' && onEnter()) {
      e.preventDefault();
    }
  };
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <MagnifyingGlass className="size-3 shrink-0 text-muted-foreground/60" weight="bold" />
      <input
        ref={inputRef}
        type="text"
        value={search.value}
        onChange={(e) => search.setValue(e.target.value || null)}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        onKeyDown={handleKeyDown}
        placeholder="Search"
        className="min-w-0 flex-1 bg-transparent text-xs font-normal text-foreground outline-hidden placeholder:text-muted-foreground/60"
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Row context menu
// ---------------------------------------------------------------------------

function EmptyMenuCloser({ ctx }: { ctx: TreeContextMenuOpenContext }) {
  useLayoutEffect(() => {
    ctx.close();
  }, [ctx]);
  return null;
}

interface RowContextMenuProps {
  item: TreeContextMenuItem;
  ctx: TreeContextMenuOpenContext;
  isDeleted: boolean;
  workingDirectory: string;
  isRemoteWorkspace: boolean;
  fileStatus: FileChange['status'] | undefined;
  isGitIgnored: boolean;
  hasCopiedFile: boolean;
  canRename: boolean;
  onCreateFile?: (parentDir: string) => void;
  onCreateDirectory?: (parentDir: string) => void;
  onStartRename: (path: string) => void;
  onDeleteFile?: (path: string, isDirectory?: boolean) => void;
  onRestoreFile?: (path: string, status: FileChange['status']) => void;
  onCopyNode?: (path: string, isDirectory: boolean) => void;
  onCutNode?: (path: string, isDirectory: boolean) => void;
  onPasteInto?: (targetDir: string) => void;
  onAddToGitignore?: (path: string, isDirectory: boolean) => void;
  onShowFileHistory?: (path: string) => void;
  onOpenHtmlInBrowser?: (path: string) => void;
  onOpenInPane?: (path: string, placement: PaneSurfacePlacement) => void;
  onNewNote: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  openCountRef: React.MutableRefObject<number>;
}

function RowContextMenu({
  item,
  ctx,
  isDeleted,
  workingDirectory,
  isRemoteWorkspace,
  fileStatus,
  isGitIgnored,
  hasCopiedFile,
  canRename,
  onCreateFile,
  onCreateDirectory,
  onStartRename,
  onDeleteFile,
  onRestoreFile,
  onCopyNode,
  onCutNode,
  onPasteInto,
  onAddToGitignore,
  onShowFileHistory,
  onOpenHtmlInBrowser,
  onOpenInPane,
  onNewNote,
  onExpandAll,
  onCollapseAll,
  openCountRef,
}: RowContextMenuProps) {
  // Signal to the parent tree that a row menu is mounted, so its window-level
  // Delete/Enter/Cmd+C/V/X shortcuts stop firing against the row underneath.
  useEffect(() => {
    openCountRef.current += 1;
    return () => {
      openCountRef.current = Math.max(0, openCountRef.current - 1);
    };
  }, [openCountRef]);

  const isDir = item.kind === 'directory';
  const isBrowserPreviewable = !isDir && isBrowserPreviewableFile(item.path);
  const run = (fn?: () => void) => {
    fn?.();
    ctx.close();
  };
  const startRename = () => {
    // Hand focus to the inline rename input without bouncing through the row
    // first, per the library's restoreFocus contract.
    ctx.close({ restoreFocus: false });
    onStartRename(item.path);
  };
  const copyAtPath = () => {
    // navigator.clipboard.writeText throws NotAllowedError in Electron when
    // the window lacks focus/user-activation — the project banned it in
    // commit 46430927. Directories get a trailing slash so the @path looks
    // like a directory reference ("@src/components/") rather than a file.
    // Trailing space so the pasted reference is ready to be followed by
    // more text; toast shows the trimmed label because trailing whitespace
    // in a toast reads as a layout bug.
    const display = `@${item.path}${isDir ? '/' : ''}`;
    window.api.copyToClipboard(`${display} `);
    useToastStore.getState().addToast(`Copied ${display}`, 'success');
  };
  const fullPath = workingDirectory + (workingDirectory.endsWith('/') ? '' : '/') + item.path;
  const reveal = () => {
    window.api.showItemInFolder(fullPath);
  };
  const openDefault = () => {
    void window.api.openPath(fullPath).catch((error: unknown) => {
      useToastStore
        .getState()
        .addToast(`Couldn't open ${item.name}: ${(error as Error).message}`, 'error');
    });
  };

  // Measure the rendered menu and clamp it inside the viewport. Pierre gives
  // us the anchor rect but no flipping — a raw `top/left` at the anchor
  // overflows when the row is near the right edge of the window or a small
  // sidebar runs down to the bottom. We render at the anchor first with
  // visibility hidden, measure synchronously in useLayoutEffect (which runs
  // before paint), then commit the clamped position in the same frame so
  // there's no visible flash at the original position. A resize listener
  // re-runs the clamp while the menu is open in case the window shrinks
  // underneath an already-positioned menu.
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const compute = () => {
      const el = menuRef.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 8;
      let top = ctx.anchorRect.bottom;
      if (top + height + margin > vh) {
        // Not enough space below — flip above the anchor; if there's also no
        // room above (tiny viewport), clamp into the top margin.
        top = Math.max(margin, ctx.anchorRect.top - height);
      }
      let left = ctx.anchorRect.left;
      if (left + width + margin > vw) {
        // Menu would run past the right edge. Shift it left so it stays in
        // view; clamp so we don't go off-screen on the other side either.
        left = Math.max(margin, vw - width - margin);
      }
      setPos({ top, left });
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [ctx.anchorRect]);

  // Take focus once the menu is placed (it can't take focus while hidden), so
  // the keyboard can reach it; closing hands focus back to the row.
  const isPlaced = pos !== null;
  useEffect(() => {
    if (isPlaced) menuRef.current?.focus({ preventScroll: true });
  }, [isPlaced]);
  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // The menu owns plain keys while open; without the claim the file
    // viewer's window listener would also move through the diff on arrows.
    if (!e.metaKey && !e.ctrlKey) claimShortcutEvent(e.nativeEvent);
    if (e.key === 'Tab') {
      e.preventDefault();
      ctx.close();
      return;
    }
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length;
    else if (e.key === 'ArrowUp') next = index <= 0 ? items.length - 1 : index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else return;
    e.preventDefault();
    items[next].focus();
  };

  const positionStyle = pos
    ? { top: pos.top, left: pos.left }
    : {
        top: ctx.anchorRect.bottom,
        left: ctx.anchorRect.left,
        visibility: 'hidden' as const,
      };

  // Portal to <body> so the menu escapes Pierre's tree subtree. Pierre wraps
  // the rendered context menu in a virtualization container that establishes
  // a containing block (transform/contain), which would otherwise turn our
  // `position: fixed` into a positioned-relative-to-ancestor element and let
  // the tree panel's `overflow: hidden` clip the menu when it extends left
  // over the file preview / terminal pane.
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      data-native-overlay="menu"
      data-file-tree-context-menu-root="true"
      className="floating-surface fixed z-50 min-w-44 rounded-[calc(var(--radius)+2px)] border p-1 text-popover-foreground shadow-xl outline-hidden"
      style={positionStyle}
      onKeyDown={handleMenuKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        ctx.close();
      }}
    >
      {isDir ? (
        <>
          {!isRemoteWorkspace && onCreateFile && (
            <MenuItem onSelect={() => run(() => onCreateFile(item.path))}>
              <FilePlus />
              New File
            </MenuItem>
          )}
          {!isRemoteWorkspace && onCreateDirectory && (
            <MenuItem onSelect={() => run(() => onCreateDirectory(item.path))}>
              <FolderPlus />
              New Folder
            </MenuItem>
          )}
          <MenuItem onSelect={() => run(onNewNote)}>
            <NotePencil />
            New Note
          </MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => run(onExpandAll)}>
            <ArrowsOutSimple />
            Expand All
          </MenuItem>
          <MenuItem onSelect={() => run(onCollapseAll)}>
            <ArrowsInSimple />
            Collapse All
          </MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => run(copyAtPath)}>
            <Copy />
            Copy @path
          </MenuItem>
          {!isRemoteWorkspace && onCopyNode && (
            <MenuItem onSelect={() => run(() => onCopyNode(item.path, true))}>
              <Clipboard />
              Copy
            </MenuItem>
          )}
          {!isRemoteWorkspace && onCutNode && (
            <MenuItem onSelect={() => run(() => onCutNode(item.path, true))}>
              <Scissors />
              Cut
            </MenuItem>
          )}
          {!isRemoteWorkspace && hasCopiedFile && onPasteInto && (
            <MenuItem onSelect={() => run(() => onPasteInto(item.path))}>
              <Clipboard />
              Paste
            </MenuItem>
          )}
          {!isRemoteWorkspace && canRename && (
            <MenuItem onSelect={startRename}>
              <PencilSimple />
              Rename
            </MenuItem>
          )}
          {!isRemoteWorkspace && (
            <>
              <MenuSeparator />
              <MenuItem onSelect={() => run(reveal)}>
                <MagnifyingGlass />
                {getRevealInFileManagerLabel()}
              </MenuItem>
            </>
          )}
          {!isRemoteWorkspace && onAddToGitignore && !isGitIgnored && (
            <MenuItem onSelect={() => run(() => onAddToGitignore(item.path, true))}>
              <ProhibitInset />
              Add to .gitignore
            </MenuItem>
          )}
          {onDeleteFile && <MenuSeparator />}
          {onDeleteFile && (
            <MenuItem
              variant="destructive"
              onSelect={() => run(() => onDeleteFile(item.path, true))}
            >
              <Trash />
              Delete
            </MenuItem>
          )}
        </>
      ) : (
        <>
          {!isDeleted && onOpenInPane && (
            <>
              <MenuItem onSelect={() => run(() => onOpenInPane(item.path, { kind: 'tab' }))}>
                <AppWindow />
                Open in New Tab
              </MenuItem>
              <MenuItem
                onSelect={() =>
                  run(() => onOpenInPane(item.path, { kind: 'split', direction: 'vertical' }))
                }
              >
                <SquareSplitHorizontal />
                Open in Split Right
              </MenuItem>
              <MenuItem
                onSelect={() =>
                  run(() => onOpenInPane(item.path, { kind: 'split', direction: 'horizontal' }))
                }
              >
                <SquareSplitVertical />
                Open in Split Down
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          {!isDeleted && (
            <MenuItem onSelect={() => run(copyAtPath)}>
              <Copy />
              Copy @path
            </MenuItem>
          )}
          {!isDeleted && !isRemoteWorkspace && onCopyNode && (
            <MenuItem onSelect={() => run(() => onCopyNode(item.path, false))}>
              <Clipboard />
              Copy
            </MenuItem>
          )}
          {!isDeleted && !isRemoteWorkspace && onCutNode && (
            <MenuItem onSelect={() => run(() => onCutNode(item.path, false))}>
              <Scissors />
              Cut
            </MenuItem>
          )}
          {!isRemoteWorkspace && hasCopiedFile && onPasteInto && (
            <MenuItem onSelect={() => run(() => onPasteInto(parentOf(item.path)))}>
              <Clipboard />
              Paste
            </MenuItem>
          )}
          {!isDeleted && ((!isRemoteWorkspace && canRename) || (onRestoreFile && fileStatus)) && (
            <MenuSeparator />
          )}
          {!isDeleted && !isRemoteWorkspace && canRename && (
            <MenuItem onSelect={startRename}>
              <PencilSimple />
              Rename
            </MenuItem>
          )}
          {onRestoreFile && fileStatus && (
            <MenuItem onSelect={() => run(() => onRestoreFile(item.path, fileStatus))}>
              <ArrowCounterClockwise />
              Rollback
            </MenuItem>
          )}
          {((!isDeleted && !isRemoteWorkspace) || onShowFileHistory) &&
            (!isDeleted || (hasCopiedFile && onPasteInto) || (onRestoreFile && fileStatus)) && (
              <MenuSeparator />
            )}
          {!isDeleted && !isRemoteWorkspace && (
            <MenuItem onSelect={() => run(reveal)}>
              <MagnifyingGlass />
              {getRevealInFileManagerLabel()}
            </MenuItem>
          )}
          {!isDeleted && !isRemoteWorkspace && (
            <MenuItem onSelect={() => run(openDefault)}>
              <ArrowSquareOut />
              Open in Default App
            </MenuItem>
          )}
          {!isDeleted && !isRemoteWorkspace && isBrowserPreviewable && onOpenHtmlInBrowser && (
            <MenuItem onSelect={() => run(() => onOpenHtmlInBrowser(item.path))}>
              <Globe />
              Open Browser Preview
            </MenuItem>
          )}
          {onShowFileHistory && (
            <MenuItem onSelect={() => run(() => onShowFileHistory(item.path))}>
              <ClockCounterClockwise />
              File History
            </MenuItem>
          )}
          {!isDeleted && !isRemoteWorkspace && onAddToGitignore && !isGitIgnored && (
            <MenuItem onSelect={() => run(() => onAddToGitignore(item.path, false))}>
              <ProhibitInset />
              Add to .gitignore
            </MenuItem>
          )}
          {onDeleteFile && !isDeleted && <MenuSeparator />}
          {onDeleteFile && !isDeleted && (
            <MenuItem variant="destructive" onSelect={() => run(() => onDeleteFile(item.path))}>
              <Trash />
              Delete File
            </MenuItem>
          )}
        </>
      )}
    </div>,
    document.body
  );
}

function MenuItem({
  children,
  className,
  variant = 'default',
  onSelect,
}: {
  children: React.ReactNode;
  className?: string;
  variant?: 'default' | 'destructive';
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      data-variant={variant}
      onClick={onSelect}
      className={cn(menuItemClass, 'w-full text-left hover:bg-foreground/8', className)}
    >
      {children}
    </button>
  );
}

function MenuSeparator() {
  return <hr className={cn(menuSeparatorClass, 'border-0')} />;
}
