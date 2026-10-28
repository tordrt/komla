import { create } from 'zustand';

import { pathAfterMove, type FileTreeMove } from '@/lib/file-tree-moves';

import { useConfigStore } from './config.store';

import type {
  FileViewerTransitionRequest,
  PendingFileViewerTransition,
} from '@/lib/file-viewer-transition';

/** File viewer mode: browse for file tree, diff for git changes */
export type FileViewerMode = 'browse' | 'diff';

export interface FileTreeReveal {
  path: string;
  expiresAt: number;
}

const FILE_TREE_REVEAL_TIMEOUT_MS = 10_000;

/** Sub-mode within diff view: changes (working tree) or history (commit log) */
export type DiffSubMode = 'changes' | 'history';

/** Inline preview layout: full (overlays terminal) or side-by-side */
export type InlinePreviewLayout = 'full' | 'side-by-side';

/** Diff layout: old and new side by side, or one column */
export type DiffViewMode = 'split' | 'unified';

const DIFF_VIEW_MODE_STORAGE_KEY = 'komla.diffViewMode';
// Returned for workspaces without tabs so getTabs() is stable in selectors.
const EMPTY_TABS: string[] = [];

function readStoredDiffViewMode(): DiffViewMode {
  try {
    return window.localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY) === 'unified'
      ? 'unified'
      : 'split';
  } catch {
    return 'split';
  }
}

function storeDiffViewMode(mode: DiffViewMode): void {
  try {
    window.localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable; the choice still applies for this session.
  }
}

interface FileViewerState {
  // File viewer: workspace ID that currently has file viewer open, or null
  fileViewerWorkspaceId: string | null;
  // File viewer mode: 'browse' for file tree, 'diff' for git changes
  fileViewerMode: FileViewerMode;
  // Initial file path to focus when opening file viewer (set from inline panel, reset on close)
  fileViewerInitialFilePath: string | null;
  fileViewerInitialLineNumber: number | null;
  // Sub-mode for diff view: 'changes' (working tree) or 'history' (commit log)
  fileViewerDiffSubMode: DiffSubMode;
  // Initial history filter path (set when opening file history from inline panel)
  fileViewerHistoryFilterPath: string | null;
  // Last selected file in diff viewer per working directory
  lastDiffFileByWorkingDir: Record<string, string>;
  // Expanded folders in diff viewer per working directory
  expandedDiffFoldersByWorkingDir: Record<string, string[]>;
  // Inline file tree panel state per workspace
  inlineFileTreeByWorkspace: Record<
    string,
    {
      open: boolean;
      mode: 'diff' | 'browse';
      comparisonBranch?: string | null;
      // Set only for "changes since target branch": readers compare against the workspace's
      // current target (selectDiffComparison), not the comparisonBranch stored here.
      useMergeBase?: boolean;
    }
  >;
  // A folder a terminal link asked the inline file tree to show, until the tree
  // shows it. Brief, so a folder the tree doesn't list never takes focus later.
  fileTreeRevealByWorkspace: Record<string, FileTreeReveal>;
  // Full-screen diff comparison state per workspace. Kept separate from the
  // inline file tree so explicit branch compares do not alter the workspace panel.
  fileViewerDiffComparisonByWorkspace: Record<
    string,
    {
      comparisonBranch?: string | null;
      useMergeBase?: boolean;
    }
  >;
  // Inline file tree width ratio per workspace (0-1 of center pane width)
  inlineFileTreeWidthByWorkspace: Record<string, number>;
  // Inline file preview state per workspace (opened from the right file panel)
  inlineFilePreviewByWorkspace: Record<
    string,
    {
      open: boolean;
      mode: FileViewerMode;
      filePath: string | null;
      lineNumber?: number;
      layout: InlinePreviewLayout;
      isDirty?: boolean;
    }
  >;
  inlineFilePreviewNavRequestByWorkspace: Record<string, number>;
  // Pending navigation request when the current preview has unsaved changes —
  // the file tree click handler stages the target here instead of mutating
  // filePath, so the panel can show a confirm dialog without the store ever
  // pointing at the unconfirmed file.
  inlineFilePreviewPendingNavByWorkspace: Record<
    string,
    {
      mode: FileViewerMode;
      filePath: string;
      lineNumber?: number;
      // When set, the staged nav also represents an "open in browser
      // preview" action. confirmDiscard applies the additional mode flips
      // (htmlViewMode + inlineFileTreeMode) only on confirm — flipping them
      // up-front would leak browser mode if the user cancels the prompt.
      htmlPreviewIntent?: boolean;
      // When set, confirmDiscard also switches the tree to its files.
      browseTree?: boolean;
    } | null
  >;
  // Pending close request when the current preview has unsaved changes — used
  // by the file tree to surface the unsaved-changes dialog when re-clicking
  // the open dirty file (which would otherwise drop edits silently).
  inlineFilePreviewPendingCloseByWorkspace: Record<string, boolean>;
  // Pending mode change (diff ↔ browse) when the current preview has unsaved
  // changes — flipping mode reloads the file in a different editor and would
  // silently drop edits, so the dialog confirms before applying.
  inlineFilePreviewPendingModeChangeByWorkspace: Record<string, FileViewerMode | null>;
  // One pending full-screen transition. The mounted dialog owns dirty state
  // and consumes this through the transition module.
  pendingFileViewerTransition: PendingFileViewerTransition | null;
  pendingFileViewerBlameRequest: { workspaceId: string; nonce: number } | null;
  // Inline file preview width ratio per workspace (0-1 of terminal+preview area, excluding file tree)
  inlineFilePreviewWidthByWorkspace: Record<string, number>;
  // Live follow mode per workspace (auto-navigate to latest changed file)
  liveFollowByWorkspace: Record<string, boolean>;
  // Split/unified diff layout chosen by the user (all workspaces, remembered across restarts)
  diffViewMode: DiffViewMode;
  setDiffViewMode: (mode: DiffViewMode) => void;
  // Persisted diff state per workspace (restored on reopen)
  diffSubModeByWorkspace: Record<string, DiffSubMode>;
  diffSelectedFileByWorkspace: Record<string, string | null>;
  diffSelectedCommitByWorkspace: Record<string, string | null>;
  diffHistorySelectedFileByWorkspace: Record<string, string | null>;
  diffHistoryBranchByWorkspace: Record<string, string | null>;
  diffHistoryFilterPathByWorkspace: Record<string, string | null>;
  // Browse mode tabs per workspace (full screen file viewer only)
  fileViewerTabsByWorkspace: Record<string, string[]>;
  // Active tab path per workspace
  fileViewerActiveTabByWorkspace: Record<string, string | null>;
  // Preview tab per workspace (single click, replaced by next file opened)
  fileViewerPreviewTabByWorkspace: Record<string, string | null>;
  // Counter incremented to request closing the active tab (consumed by FileViewerDialog)
  closeTabRequest: number;
  // Counter incremented to request closing the file viewer (consumed by FileViewerDialog)
  closeViewerRequest: number;

  // File viewer actions
  openFileViewer: (
    workspaceId: string,
    mode: FileViewerMode,
    initialFilePath?: string,
    diffSubMode?: DiffSubMode,
    historyFilterPath?: string
  ) => void;
  closeFileViewer: () => void;
  setFileViewerMode: (mode: FileViewerMode) => void;
  setDiffSubMode: (subMode: DiffSubMode) => void;
  // Last diff file persistence
  setLastDiffFile: (workingDirectory: string, fileKey: string) => void;
  getLastDiffFile: (workingDirectory: string) => string | undefined;
  // Expanded diff folders persistence
  setExpandedDiffFolders: (workingDirectory: string, folders: string[]) => void;
  getExpandedDiffFolders: (workingDirectory: string) => string[] | undefined;
  // Inline file tree panel actions
  toggleInlineFileTree: (workspaceId: string) => void;
  setInlineFileTreeOpen: (workspaceId: string, open: boolean) => void;
  setInlineFileTreeMode: (workspaceId: string, mode: 'diff' | 'browse') => void;
  // Opens the inline file tree on its files and has it show a workspace folder.
  revealInFileTree: (workspaceId: string, folderPath: string) => void;
  clearFileTreeReveal: (workspaceId: string, folderPath: string) => void;
  setInlineFileTreeComparisonBranch: (
    workspaceId: string,
    branch: string | null,
    useMergeBase?: boolean
  ) => void;
  setFileViewerDiffComparisonBranch: (
    workspaceId: string,
    branch: string | null,
    useMergeBase?: boolean
  ) => void;
  copyInlineFileTreeComparisonToFileViewerDiff: (workspaceId: string) => void;
  setInlineFileTreeWidth: (workspaceId: string, widthRatio: number) => void;
  // Inline file preview actions
  openInlineFilePreview: (
    workspaceId: string,
    mode: FileViewerMode,
    filePath: string,
    lineNumber?: number
  ) => void;
  closeInlineFilePreview: (workspaceId: string) => void;
  clearInlineFilePreviewLineNumber: (workspaceId: string) => void;
  setInlineFilePreviewMode: (workspaceId: string, mode: FileViewerMode) => void;
  setInlineFilePreviewLayout: (workspaceId: string, layout: InlinePreviewLayout) => void;
  setInlineFilePreviewWidth: (workspaceId: string, widthRatio: number) => void;
  setInlineFilePreviewDirty: (workspaceId: string, isDirty: boolean) => void;
  reserveInlineFilePreviewNav: (workspaceId: string) => number;
  // Requests a navigation to filePath for the inline preview. If the current
  // preview is dirty and points at a different file, the request is staged
  // (the panel will prompt for confirmation); otherwise it navigates directly.
  // `browseTree` also switches the tree to its files once the nav lands.
  requestInlineFilePreviewNav: (
    workspaceId: string,
    mode: FileViewerMode,
    filePath: string,
    lineNumber?: number,
    options?: { htmlPreviewIntent?: boolean; browseTree?: boolean; requestId?: number }
  ) => void;
  clearInlineFilePreviewPendingNav: (workspaceId: string) => void;
  // Requests close of the inline preview. If the current preview is dirty, the
  // request is staged (panel shows confirm dialog); otherwise closes directly.
  requestInlineFilePreviewClose: (workspaceId: string) => void;
  clearInlineFilePreviewPendingClose: (workspaceId: string) => void;
  // Requests a tree+preview mode change. If the open preview is dirty and the
  // mode would actually change, the request is staged (panel shows confirm
  // dialog); otherwise both modes are applied directly.
  requestInlineFilePreviewModeChange: (workspaceId: string, nextMode: FileViewerMode) => void;
  clearInlineFilePreviewPendingModeChange: (workspaceId: string) => void;
  // Drops all three inline-preview pending discard slots for one workspace at
  // once. Used by `confirmDiscard` to snapshot-then-clear-all-then-act so a
  // sibling slot staged while the dialog was open can't survive past the
  // current decision.
  clearAllInlineFilePreviewPendingDiscardSlots: (workspaceId: string) => void;
  requestFileViewerTransition: (request: FileViewerTransitionRequest) => void;
  clearPendingFileViewerTransition: () => void;
  requestFileViewerBlame: (workspaceId: string) => void;
  clearPendingFileViewerBlameRequest: () => void;
  // Diff state persistence (per workspace, survives close/reopen)
  getDiffSubMode: (workspaceId: string) => DiffSubMode;
  saveDiffSelections: (
    workspaceId: string,
    selections: {
      selectedFile?: string | null;
      selectedCommitHash?: string | null;
      historySelectedFile?: string | null;
      historyBranch?: string | null;
      historyFilterPath?: string | null;
    }
  ) => void;
  getDiffSelections: (workspaceId: string) => {
    selectedFile: string | null;
    selectedCommitHash: string | null;
    historySelectedFile: string | null;
    historyBranch: string | null;
    historyFilterPath: string | null;
  };
  // Show gitignored files toggle (per workspace, not persisted)
  showGitIgnoredByWorkspace: Record<string, boolean>;
  toggleShowGitIgnored: (workspaceId: string) => void;
  // Live follow actions
  setLiveFollow: (workspaceId: string, enabled: boolean) => void;
  toggleLiveFollow: (workspaceId: string) => void;
  // File picker query persistence (per workspace)
  filePickerQueryByWorkspace: Record<string, string>;
  setFilePickerQuery: (workspaceId: string, query: string) => void;
  getFilePickerQuery: (workspaceId: string) => string;
  // Browse mode tab actions (full screen file viewer only)
  openTab: (workspaceId: string, filePath: string, preview?: boolean) => void;
  closeTab: (workspaceId: string, filePath: string) => void;
  removeDeletedPathFromViewers: (workspaceId: string, deletedPath: string) => string | null;
  renamePathInViewers: (workspaceId: string, move: FileTreeMove) => void;
  setActiveTab: (workspaceId: string, filePath: string | null) => void;
  getActiveTab: (workspaceId: string) => string | null;
  getTabs: (workspaceId: string) => string[];
  getPreviewTab: (workspaceId: string) => string | null;
  setPreviewTab: (workspaceId: string, filePath: string | null) => void;
  requestCloseTab: () => void;
  requestCloseViewer: () => void;
  // Cleanup
  clearWorkspaceFileViewerState: (workspaceId: string) => void;
}

/** Opens a closed viewer in a transition's mode, on what the transition goes on to show. */
function openClosedViewerForMode(
  request: Extract<FileViewerTransitionRequest, { kind: 'mode' }>,
  get: () => FileViewerState,
  set: (partial: Partial<FileViewerState>) => void
): void {
  get().openFileViewer(
    request.workspaceId,
    request.mode,
    request.after?.kind === 'browse-file' || request.after?.kind === 'diff-file'
      ? request.after.filePath
      : undefined,
    request.diffSubMode,
    request.after?.kind === 'history-file' ? (request.after.filePath ?? undefined) : undefined
  );
  // The viewer that just opened selects the commit once it mounts.
  if (request.after?.kind === 'commit') set({ pendingFileViewerTransition: request });
  if (request.after?.kind === 'browse-file') {
    set({
      fileViewerInitialLineNumber: request.after.lineNumber ?? null,
      ...(request.after.enableBlame
        ? {
            pendingFileViewerBlameRequest: {
              workspaceId: request.workspaceId,
              nonce: Date.now(),
            },
          }
        : {}),
    });
  }
}

export const useFileViewerStore = create<FileViewerState>((set, get) => ({
  fileViewerWorkspaceId: null,
  fileViewerMode: 'browse' as FileViewerMode,
  fileViewerInitialFilePath: null,
  fileViewerInitialLineNumber: null,
  fileViewerDiffSubMode: 'changes' as DiffSubMode,
  fileViewerHistoryFilterPath: null,
  lastDiffFileByWorkingDir: {},
  expandedDiffFoldersByWorkingDir: {},
  inlineFileTreeByWorkspace: {},
  fileTreeRevealByWorkspace: {},
  fileViewerDiffComparisonByWorkspace: {},
  inlineFileTreeWidthByWorkspace: {},
  inlineFilePreviewByWorkspace: {},
  inlineFilePreviewNavRequestByWorkspace: {},
  inlineFilePreviewPendingNavByWorkspace: {},
  inlineFilePreviewPendingCloseByWorkspace: {},
  inlineFilePreviewPendingModeChangeByWorkspace: {},
  pendingFileViewerTransition: null,
  pendingFileViewerBlameRequest: null,
  inlineFilePreviewWidthByWorkspace: {},
  liveFollowByWorkspace: {},
  diffViewMode: readStoredDiffViewMode(),
  diffSubModeByWorkspace: {} as Record<string, DiffSubMode>,
  diffSelectedFileByWorkspace: {} as Record<string, string | null>,
  diffSelectedCommitByWorkspace: {} as Record<string, string | null>,
  diffHistorySelectedFileByWorkspace: {} as Record<string, string | null>,
  diffHistoryBranchByWorkspace: {} as Record<string, string | null>,
  diffHistoryFilterPathByWorkspace: {} as Record<string, string | null>,
  fileViewerTabsByWorkspace: {},
  fileViewerActiveTabByWorkspace: {},
  fileViewerPreviewTabByWorkspace: {},
  filePickerQueryByWorkspace: {},
  showGitIgnoredByWorkspace: {},
  closeTabRequest: 0,
  closeViewerRequest: 0,

  setFilePickerQuery: (workspaceId, query) => {
    set((state) => ({
      filePickerQueryByWorkspace: {
        ...state.filePickerQueryByWorkspace,
        [workspaceId]: query,
      },
    }));
  },

  getFilePickerQuery: (workspaceId) => {
    return get().filePickerQueryByWorkspace[workspaceId] ?? '';
  },

  // File viewer actions
  openFileViewer: (workspaceId, mode, initialFilePath, diffSubMode, historyFilterPath) => {
    const {
      diffSubModeByWorkspace,
      fileViewerDiffComparisonByWorkspace,
      inlineFileTreeByWorkspace,
    } = get();
    const storedSubMode = diffSubModeByWorkspace[workspaceId] ?? 'changes';
    const shouldSeedDiffComparison =
      mode === 'diff' && !(workspaceId in fileViewerDiffComparisonByWorkspace);
    const inlineComparison = inlineFileTreeByWorkspace[workspaceId];
    set({
      fileViewerWorkspaceId: workspaceId,
      fileViewerMode: mode,
      fileViewerInitialFilePath: initialFilePath ?? null,
      fileViewerInitialLineNumber: null,
      fileViewerDiffSubMode: diffSubMode ?? storedSubMode,
      fileViewerHistoryFilterPath: historyFilterPath ?? null,
      ...(shouldSeedDiffComparison && inlineComparison
        ? {
            fileViewerDiffComparisonByWorkspace: {
              ...fileViewerDiffComparisonByWorkspace,
              [workspaceId]: {
                comparisonBranch: inlineComparison.comparisonBranch ?? null,
                useMergeBase: inlineComparison.useMergeBase ?? false,
              },
            },
          }
        : {}),
    });
  },

  closeFileViewer: () => {
    const { fileViewerWorkspaceId, fileViewerDiffSubMode, diffSubModeByWorkspace } = get();
    set({
      fileViewerWorkspaceId: null,
      fileViewerInitialFilePath: null,
      fileViewerInitialLineNumber: null,
      fileViewerHistoryFilterPath: null,
      // Persist the sub-mode for the workspace so it restores on reopen
      ...(fileViewerWorkspaceId
        ? {
            diffSubModeByWorkspace: {
              ...diffSubModeByWorkspace,
              [fileViewerWorkspaceId]: fileViewerDiffSubMode,
            },
          }
        : {}),
    });
  },

  setFileViewerMode: (mode) => {
    set({ fileViewerMode: mode });
  },

  setDiffSubMode: (subMode) => {
    const { fileViewerWorkspaceId, diffSubModeByWorkspace } = get();
    set({
      fileViewerDiffSubMode: subMode,
      ...(fileViewerWorkspaceId
        ? {
            diffSubModeByWorkspace: {
              ...diffSubModeByWorkspace,
              [fileViewerWorkspaceId]: subMode,
            },
          }
        : {}),
    });
  },

  setDiffViewMode: (mode) => {
    storeDiffViewMode(mode);
    set({ diffViewMode: mode });
  },

  setLastDiffFile: (workingDirectory, fileKey) => {
    set((state) => ({
      lastDiffFileByWorkingDir: {
        ...state.lastDiffFileByWorkingDir,
        [workingDirectory]: fileKey,
      },
    }));
  },

  getLastDiffFile: (workingDirectory) => {
    return get().lastDiffFileByWorkingDir[workingDirectory];
  },

  setExpandedDiffFolders: (workingDirectory, folders) => {
    set((state) => ({
      expandedDiffFoldersByWorkingDir: {
        ...state.expandedDiffFoldersByWorkingDir,
        [workingDirectory]: folders,
      },
    }));
  },

  getExpandedDiffFolders: (workingDirectory) => {
    return get().expandedDiffFoldersByWorkingDir[workingDirectory];
  },

  toggleInlineFileTree: (workspaceId) => {
    const { inlineFileTreeByWorkspace } = get();
    const current = inlineFileTreeByWorkspace[workspaceId];
    const newOpen = !(current?.open ?? true);
    set({
      inlineFileTreeByWorkspace: {
        ...inlineFileTreeByWorkspace,
        [workspaceId]: {
          open: newOpen,
          mode: current?.mode ?? 'diff',
          comparisonBranch: current?.comparisonBranch,
          useMergeBase: current?.useMergeBase,
        },
      },
    });
    // Persist to workspace
    window.api.updateWorkspace(workspaceId, { fileTreeOpen: newOpen }).catch(() => {});
  },

  setInlineFileTreeOpen: (workspaceId, open) => {
    const { inlineFileTreeByWorkspace } = get();
    const current = inlineFileTreeByWorkspace[workspaceId];
    set({
      inlineFileTreeByWorkspace: {
        ...inlineFileTreeByWorkspace,
        [workspaceId]: {
          open,
          mode: current?.mode ?? 'diff',
          comparisonBranch: current?.comparisonBranch,
          useMergeBase: current?.useMergeBase,
        },
      },
    });
  },

  setInlineFileTreeMode: (workspaceId, mode) => {
    const { inlineFileTreeByWorkspace } = get();
    const current = inlineFileTreeByWorkspace[workspaceId];
    set({
      inlineFileTreeByWorkspace: {
        ...inlineFileTreeByWorkspace,
        [workspaceId]: {
          open: current?.open ?? true,
          mode,
          comparisonBranch: current?.comparisonBranch,
          useMergeBase: current?.useMergeBase,
        },
      },
    });
    // Persist to workspace
    window.api.updateWorkspace(workspaceId, { fileTreeMode: mode }).catch(() => {});
  },

  revealInFileTree: (workspaceId, folderPath) => {
    if (!(get().inlineFileTreeByWorkspace[workspaceId]?.open ?? true)) {
      get().toggleInlineFileTree(workspaceId);
    }
    get().requestInlineFilePreviewModeChange(workspaceId, 'browse');
    set((state) => ({
      fileTreeRevealByWorkspace: {
        ...state.fileTreeRevealByWorkspace,
        [workspaceId]: { path: folderPath, expiresAt: Date.now() + FILE_TREE_REVEAL_TIMEOUT_MS },
      },
    }));
  },

  clearFileTreeReveal: (workspaceId, folderPath) => {
    const { fileTreeRevealByWorkspace } = get();
    if (fileTreeRevealByWorkspace[workspaceId]?.path !== folderPath) return;
    const { [workspaceId]: _, ...rest } = fileTreeRevealByWorkspace;
    set({ fileTreeRevealByWorkspace: rest });
  },

  setInlineFileTreeComparisonBranch: (workspaceId, branch, useMergeBase) => {
    const { inlineFileTreeByWorkspace } = get();
    const current = inlineFileTreeByWorkspace[workspaceId];
    set({
      inlineFileTreeByWorkspace: {
        ...inlineFileTreeByWorkspace,
        [workspaceId]: {
          open: current?.open ?? true,
          mode: current?.mode ?? 'diff',
          comparisonBranch: branch,
          useMergeBase: useMergeBase ?? false,
        },
      },
    });
  },

  setFileViewerDiffComparisonBranch: (workspaceId, branch, useMergeBase) => {
    set((state) => ({
      fileViewerDiffComparisonByWorkspace: {
        ...state.fileViewerDiffComparisonByWorkspace,
        [workspaceId]: {
          comparisonBranch: branch,
          useMergeBase: useMergeBase ?? false,
        },
      },
    }));
  },

  copyInlineFileTreeComparisonToFileViewerDiff: (workspaceId) => {
    set((state) => {
      const inlineComparison = state.inlineFileTreeByWorkspace[workspaceId];
      return {
        fileViewerDiffComparisonByWorkspace: {
          ...state.fileViewerDiffComparisonByWorkspace,
          [workspaceId]: {
            comparisonBranch: inlineComparison?.comparisonBranch ?? null,
            useMergeBase: inlineComparison?.useMergeBase ?? false,
          },
        },
      };
    });
  },

  setInlineFileTreeWidth: (workspaceId, widthRatio) => {
    const clamped = Math.min(0.9, Math.max(0.05, widthRatio));
    set((state) => ({
      inlineFileTreeWidthByWorkspace: {
        ...state.inlineFileTreeWidthByWorkspace,
        [workspaceId]: clamped,
      },
    }));
  },

  openInlineFilePreview: (workspaceId, mode, filePath, lineNumber) => {
    get().reserveInlineFilePreviewNav(workspaceId);
    const { inlineFilePreviewByWorkspace } = get();
    const current = inlineFilePreviewByWorkspace[workspaceId];
    // Re-seed layout from the user's saved preference whenever the slot
    // wasn't already live — closed entries can carry a stale layout from
    // other actions that synthesize them, so current.layout is only
    // authoritative while the panel is open.
    const preferredLayout: InlinePreviewLayout =
      useConfigStore.getState().config?.defaultInlinePreviewLayout ?? 'full';
    const slotWasLive = current?.open;
    const layout: InlinePreviewLayout = slotWasLive
      ? (current?.layout ?? preferredLayout)
      : preferredLayout;
    const defaults = {
      open: false,
      mode: 'browse' as FileViewerMode,
      filePath: null as string | null,
      layout: preferredLayout,
    };
    set({
      inlineFilePreviewByWorkspace: {
        ...inlineFilePreviewByWorkspace,
        [workspaceId]: { ...defaults, ...current, layout, open: true, mode, filePath, lineNumber },
      },
    });
  },

  closeInlineFilePreview: (workspaceId) => {
    const {
      inlineFilePreviewByWorkspace,
      inlineFilePreviewPendingNavByWorkspace,
      inlineFilePreviewPendingCloseByWorkspace,
      inlineFilePreviewPendingModeChangeByWorkspace,
    } = get();
    const current = inlineFilePreviewByWorkspace[workspaceId];
    const defaults = {
      open: false,
      mode: 'browse' as FileViewerMode,
      filePath: null as string | null,
      layout: 'full' as InlinePreviewLayout,
    };
    set({
      inlineFilePreviewByWorkspace: {
        ...inlineFilePreviewByWorkspace,
        // filePath is force-cleared so the sidebar file tree can drop its
        // selection. Without this, closing the preview leaves the row looking
        // active and re-clicking it becomes a no-op (pierre's
        // selectOnlyPath/focus are both no-ops on an already-active row).
        [workspaceId]: { ...defaults, ...current, open: false, filePath: null },
      },
      inlineFilePreviewPendingNavByWorkspace: {
        ...inlineFilePreviewPendingNavByWorkspace,
        [workspaceId]: null,
      },
      inlineFilePreviewPendingCloseByWorkspace: {
        ...inlineFilePreviewPendingCloseByWorkspace,
        [workspaceId]: false,
      },
      inlineFilePreviewPendingModeChangeByWorkspace: {
        ...inlineFilePreviewPendingModeChangeByWorkspace,
        [workspaceId]: null,
      },
    });
  },

  clearInlineFilePreviewLineNumber: (workspaceId) => {
    const { inlineFilePreviewByWorkspace } = get();
    const current = inlineFilePreviewByWorkspace[workspaceId];
    if (!current || current.lineNumber === undefined) return;
    set({
      inlineFilePreviewByWorkspace: {
        ...inlineFilePreviewByWorkspace,
        [workspaceId]: { ...current, lineNumber: undefined },
      },
    });
  },

  setInlineFilePreviewMode: (workspaceId, mode) => {
    const { inlineFilePreviewByWorkspace } = get();
    const current = inlineFilePreviewByWorkspace[workspaceId];
    const defaults = {
      open: false,
      mode: 'browse' as FileViewerMode,
      filePath: null as string | null,
      layout: 'full' as InlinePreviewLayout,
    };
    set({
      inlineFilePreviewByWorkspace: {
        ...inlineFilePreviewByWorkspace,
        [workspaceId]: { ...defaults, ...current, mode },
      },
    });
  },

  setInlineFilePreviewLayout: (workspaceId, layout) => {
    const { inlineFilePreviewByWorkspace } = get();
    const current = inlineFilePreviewByWorkspace[workspaceId];
    const defaults = {
      open: false,
      mode: 'browse' as FileViewerMode,
      filePath: null as string | null,
      layout: 'full' as InlinePreviewLayout,
    };
    set({
      inlineFilePreviewByWorkspace: {
        ...inlineFilePreviewByWorkspace,
        [workspaceId]: { ...defaults, ...current, layout },
      },
    });
  },

  setInlineFilePreviewWidth: (workspaceId, widthRatio) => {
    const clamped = Math.min(0.95, Math.max(0.05, widthRatio));
    set((state) => ({
      inlineFilePreviewWidthByWorkspace: {
        ...state.inlineFilePreviewWidthByWorkspace,
        [workspaceId]: clamped,
      },
    }));
  },

  setInlineFilePreviewDirty: (workspaceId, isDirty) => {
    const { inlineFilePreviewByWorkspace } = get();
    const current = inlineFilePreviewByWorkspace[workspaceId];
    if (!current || current.isDirty === isDirty) return;
    set({
      inlineFilePreviewByWorkspace: {
        ...inlineFilePreviewByWorkspace,
        [workspaceId]: { ...current, isDirty },
      },
    });
  },

  reserveInlineFilePreviewNav: (workspaceId) => {
    const nextRequestId = (get().inlineFilePreviewNavRequestByWorkspace[workspaceId] ?? 0) + 1;
    set((state) => ({
      inlineFilePreviewNavRequestByWorkspace: {
        ...state.inlineFilePreviewNavRequestByWorkspace,
        [workspaceId]: nextRequestId,
      },
    }));
    return nextRequestId;
  },

  requestInlineFilePreviewNav: (workspaceId, mode, filePath, lineNumber, options) => {
    if (options?.requestId !== undefined) {
      if (get().inlineFilePreviewNavRequestByWorkspace[workspaceId] !== options.requestId) return;
    }
    const current = get().inlineFilePreviewByWorkspace[workspaceId];
    // Same-file mode swap (e.g. live-follow nudging from browse to diff on the
    // currently dirty file) also reloads the editor, so treat mode mismatch as
    // a blocking transition.
    const blockingDirty =
      !!current?.open &&
      !!current.isDirty &&
      (current.filePath !== filePath || current.mode !== mode);
    if (!blockingDirty) {
      if (
        options?.browseTree &&
        (get().inlineFileTreeByWorkspace[workspaceId]?.mode ?? 'diff') === 'diff'
      ) {
        get().setInlineFileTreeMode(workspaceId, 'browse');
      }
      get().openInlineFilePreview(workspaceId, mode, filePath, lineNumber);
      return;
    }
    if (options?.requestId === undefined) {
      get().reserveInlineFilePreviewNav(workspaceId);
    }
    // Mutual exclusion: clear sibling pending slots so the latest staged
    // intent always wins. Without this, a tree click → Cmd+W race could
    // leave the close request next to a stale nav request, and
    // confirmDiscard would act on the older one first.
    set((state) => ({
      inlineFilePreviewPendingNavByWorkspace: {
        ...state.inlineFilePreviewPendingNavByWorkspace,
        [workspaceId]: {
          mode,
          filePath,
          lineNumber,
          htmlPreviewIntent: options?.htmlPreviewIntent,
          browseTree: options?.browseTree,
        },
      },
      inlineFilePreviewPendingCloseByWorkspace: {
        ...state.inlineFilePreviewPendingCloseByWorkspace,
        [workspaceId]: false,
      },
      inlineFilePreviewPendingModeChangeByWorkspace: {
        ...state.inlineFilePreviewPendingModeChangeByWorkspace,
        [workspaceId]: null,
      },
    }));
  },

  clearInlineFilePreviewPendingNav: (workspaceId) => {
    const { inlineFilePreviewPendingNavByWorkspace } = get();
    if (!inlineFilePreviewPendingNavByWorkspace[workspaceId]) return;
    set({
      inlineFilePreviewPendingNavByWorkspace: {
        ...inlineFilePreviewPendingNavByWorkspace,
        [workspaceId]: null,
      },
    });
  },

  requestInlineFilePreviewClose: (workspaceId) => {
    const current = get().inlineFilePreviewByWorkspace[workspaceId];
    if (!current?.open) return;
    if (!current.isDirty) {
      get().closeInlineFilePreview(workspaceId);
      return;
    }
    set((state) => ({
      inlineFilePreviewPendingCloseByWorkspace: {
        ...state.inlineFilePreviewPendingCloseByWorkspace,
        [workspaceId]: true,
      },
      inlineFilePreviewPendingNavByWorkspace: {
        ...state.inlineFilePreviewPendingNavByWorkspace,
        [workspaceId]: null,
      },
      inlineFilePreviewPendingModeChangeByWorkspace: {
        ...state.inlineFilePreviewPendingModeChangeByWorkspace,
        [workspaceId]: null,
      },
    }));
  },

  clearInlineFilePreviewPendingClose: (workspaceId) => {
    const { inlineFilePreviewPendingCloseByWorkspace } = get();
    if (!inlineFilePreviewPendingCloseByWorkspace[workspaceId]) return;
    set({
      inlineFilePreviewPendingCloseByWorkspace: {
        ...inlineFilePreviewPendingCloseByWorkspace,
        [workspaceId]: false,
      },
    });
  },

  requestInlineFilePreviewModeChange: (workspaceId, nextMode) => {
    const current = get().inlineFilePreviewByWorkspace[workspaceId];
    const isOpen = !!current?.open;
    const isDirty = !!current?.isDirty;
    const wouldChange = !current || current.mode !== nextMode;

    if (!isOpen || !isDirty || !wouldChange) {
      // Safe to apply directly — preview is closed, clean, or already in the
      // requested mode.
      get().setInlineFileTreeMode(workspaceId, nextMode);
      get().setInlineFilePreviewMode(workspaceId, nextMode);
      return;
    }

    set((state) => ({
      inlineFilePreviewPendingModeChangeByWorkspace: {
        ...state.inlineFilePreviewPendingModeChangeByWorkspace,
        [workspaceId]: nextMode,
      },
      inlineFilePreviewPendingNavByWorkspace: {
        ...state.inlineFilePreviewPendingNavByWorkspace,
        [workspaceId]: null,
      },
      inlineFilePreviewPendingCloseByWorkspace: {
        ...state.inlineFilePreviewPendingCloseByWorkspace,
        [workspaceId]: false,
      },
    }));
  },

  clearInlineFilePreviewPendingModeChange: (workspaceId) => {
    const { inlineFilePreviewPendingModeChangeByWorkspace } = get();
    if (!inlineFilePreviewPendingModeChangeByWorkspace[workspaceId]) return;
    set({
      inlineFilePreviewPendingModeChangeByWorkspace: {
        ...inlineFilePreviewPendingModeChangeByWorkspace,
        [workspaceId]: null,
      },
    });
  },

  clearAllInlineFilePreviewPendingDiscardSlots: (workspaceId) => {
    const {
      inlineFilePreviewPendingNavByWorkspace,
      inlineFilePreviewPendingCloseByWorkspace,
      inlineFilePreviewPendingModeChangeByWorkspace,
    } = get();
    set({
      inlineFilePreviewPendingNavByWorkspace: {
        ...inlineFilePreviewPendingNavByWorkspace,
        [workspaceId]: null,
      },
      inlineFilePreviewPendingCloseByWorkspace: {
        ...inlineFilePreviewPendingCloseByWorkspace,
        [workspaceId]: false,
      },
      inlineFilePreviewPendingModeChangeByWorkspace: {
        ...inlineFilePreviewPendingModeChangeByWorkspace,
        [workspaceId]: null,
      },
    });
  },

  requestFileViewerTransition: (request) => {
    const { fileViewerWorkspaceId, fileViewerMode, fileViewerDiffSubMode } = get();
    const isOpen = fileViewerWorkspaceId === request.workspaceId;

    if (request.kind === 'toggle') {
      if (!isOpen) {
        get().openFileViewer(request.workspaceId, request.mode, undefined, request.diffSubMode);
        return;
      }
      const alreadySelected =
        fileViewerMode === request.mode &&
        (!request.diffSubMode || fileViewerDiffSubMode === request.diffSubMode);
      set({
        pendingFileViewerTransition: alreadySelected
          ? { kind: 'close', workspaceId: request.workspaceId }
          : {
              kind: 'mode',
              workspaceId: request.workspaceId,
              mode: request.mode,
              diffSubMode: request.diffSubMode,
            },
      });
      return;
    }

    if (isOpen) {
      set({ pendingFileViewerTransition: request });
      return;
    }

    if (request.kind === 'inline-preview') {
      get().closeFileViewer();
      get().openInlineFilePreview(
        request.workspaceId,
        'browse',
        request.filePath,
        request.lineNumber
      );
      return;
    }
    if (request.kind === 'mode') {
      openClosedViewerForMode(request, get, set);
      return;
    }
    if (request.kind === 'file') {
      get().openFileViewer(request.workspaceId, 'browse', request.filePath);
      set({ fileViewerInitialLineNumber: request.lineNumber ?? null });
    }
  },

  clearPendingFileViewerTransition: () => {
    if (!get().pendingFileViewerTransition) return;
    set({ pendingFileViewerTransition: null });
  },

  requestFileViewerBlame: (workspaceId) => {
    set({ pendingFileViewerBlameRequest: { workspaceId, nonce: Date.now() } });
  },

  clearPendingFileViewerBlameRequest: () => {
    if (!get().pendingFileViewerBlameRequest) return;
    set({ pendingFileViewerBlameRequest: null });
  },

  getDiffSubMode: (workspaceId) => {
    return get().diffSubModeByWorkspace[workspaceId] ?? 'changes';
  },

  saveDiffSelections: (workspaceId, selections) => {
    const state = get();
    set({
      ...(selections.selectedFile !== undefined
        ? {
            diffSelectedFileByWorkspace: {
              ...state.diffSelectedFileByWorkspace,
              [workspaceId]: selections.selectedFile,
            },
          }
        : {}),
      ...(selections.selectedCommitHash !== undefined
        ? {
            diffSelectedCommitByWorkspace: {
              ...state.diffSelectedCommitByWorkspace,
              [workspaceId]: selections.selectedCommitHash,
            },
          }
        : {}),
      ...(selections.historySelectedFile !== undefined
        ? {
            diffHistorySelectedFileByWorkspace: {
              ...state.diffHistorySelectedFileByWorkspace,
              [workspaceId]: selections.historySelectedFile,
            },
          }
        : {}),
      ...(selections.historyBranch !== undefined
        ? {
            diffHistoryBranchByWorkspace: {
              ...state.diffHistoryBranchByWorkspace,
              [workspaceId]: selections.historyBranch,
            },
          }
        : {}),
      ...(selections.historyFilterPath !== undefined
        ? {
            diffHistoryFilterPathByWorkspace: {
              ...state.diffHistoryFilterPathByWorkspace,
              [workspaceId]: selections.historyFilterPath,
            },
          }
        : {}),
    });
  },

  getDiffSelections: (workspaceId) => {
    const state = get();
    return {
      selectedFile: state.diffSelectedFileByWorkspace[workspaceId] ?? null,
      selectedCommitHash: state.diffSelectedCommitByWorkspace[workspaceId] ?? null,
      historySelectedFile: state.diffHistorySelectedFileByWorkspace[workspaceId] ?? null,
      historyBranch: state.diffHistoryBranchByWorkspace[workspaceId] ?? null,
      historyFilterPath: state.diffHistoryFilterPathByWorkspace[workspaceId] ?? null,
    };
  },

  setLiveFollow: (workspaceId, enabled) => {
    set((state) => ({
      liveFollowByWorkspace: {
        ...state.liveFollowByWorkspace,
        [workspaceId]: enabled,
      },
    }));
  },

  toggleLiveFollow: (workspaceId) => {
    set((state) => ({
      liveFollowByWorkspace: {
        ...state.liveFollowByWorkspace,
        [workspaceId]: !state.liveFollowByWorkspace[workspaceId],
      },
    }));
  },

  toggleShowGitIgnored: (workspaceId) => {
    set((state) => ({
      showGitIgnoredByWorkspace: {
        ...state.showGitIgnoredByWorkspace,
        [workspaceId]: !state.showGitIgnoredByWorkspace[workspaceId],
      },
    }));
  },

  openTab: (workspaceId, filePath, preview = false) => {
    set((state) => {
      if (preview) {
        // Preview tab: just set it without adding to persistent tabs
        return {
          fileViewerPreviewTabByWorkspace: {
            ...state.fileViewerPreviewTabByWorkspace,
            [workspaceId]: filePath,
          },
        };
      }

      const tabs = state.fileViewerTabsByWorkspace[workspaceId] ?? [];

      // If file is already a persistent tab, just activate it
      if (tabs.includes(filePath)) {
        return {
          fileViewerActiveTabByWorkspace: {
            ...state.fileViewerActiveTabByWorkspace,
            [workspaceId]: filePath,
          },
          fileViewerPreviewTabByWorkspace: {
            ...state.fileViewerPreviewTabByWorkspace,
            [workspaceId]: null,
          },
        };
      }

      // Add new persistent tab, replacing the preview tab if it matches
      const currentPreview = state.fileViewerPreviewTabByWorkspace[workspaceId];
      const newTabs = [...tabs, filePath];

      return {
        fileViewerTabsByWorkspace: {
          ...state.fileViewerTabsByWorkspace,
          [workspaceId]: newTabs,
        },
        fileViewerActiveTabByWorkspace: {
          ...state.fileViewerActiveTabByWorkspace,
          [workspaceId]: filePath,
        },
        fileViewerPreviewTabByWorkspace: {
          ...state.fileViewerPreviewTabByWorkspace,
          [workspaceId]: currentPreview === filePath ? null : (currentPreview ?? null),
        },
      };
    });
  },

  closeTab: (workspaceId, filePath) => {
    set((state) => {
      const tabs = state.fileViewerTabsByWorkspace[workspaceId] ?? [];
      const newTabs = tabs.filter((t) => t !== filePath);
      const activeTab = state.fileViewerActiveTabByWorkspace[workspaceId];

      let newActiveTab = activeTab;
      if (activeTab === filePath) {
        // Tab being closed is active, switch to another tab
        newActiveTab = newTabs.length > 0 ? newTabs[newTabs.length - 1] : null;
      }

      return {
        fileViewerTabsByWorkspace: {
          ...state.fileViewerTabsByWorkspace,
          [workspaceId]: newTabs,
        },
        fileViewerActiveTabByWorkspace: {
          ...state.fileViewerActiveTabByWorkspace,
          [workspaceId]: newActiveTab,
        },
      };
    });
  },

  removeDeletedPathFromViewers: (workspaceId, deletedPath) => {
    const isDeletedPath = (candidate: string | null | undefined): boolean =>
      !!candidate && (candidate === deletedPath || candidate.startsWith(`${deletedPath}/`));
    const state = get();
    const tabs = state.fileViewerTabsByWorkspace[workspaceId] ?? [];
    const remainingTabs = tabs.filter((path) => !isDeletedPath(path));
    const preview = state.fileViewerPreviewTabByWorkspace[workspaceId] ?? null;
    const remainingPreview = isDeletedPath(preview) ? null : preview;
    const active = state.fileViewerActiveTabByWorkspace[workspaceId] ?? null;
    const nextActive = isDeletedPath(active)
      ? (remainingTabs[remainingTabs.length - 1] ?? remainingPreview)
      : active;

    set({
      fileViewerTabsByWorkspace: {
        ...state.fileViewerTabsByWorkspace,
        [workspaceId]: remainingTabs,
      },
      fileViewerPreviewTabByWorkspace: {
        ...state.fileViewerPreviewTabByWorkspace,
        [workspaceId]: remainingPreview,
      },
      fileViewerActiveTabByWorkspace: {
        ...state.fileViewerActiveTabByWorkspace,
        [workspaceId]: nextActive,
      },
    });
    const inlinePreview = state.inlineFilePreviewByWorkspace[workspaceId];
    if (isDeletedPath(inlinePreview?.filePath)) {
      get().closeInlineFilePreview(workspaceId);
    } else {
      const pendingNav = state.inlineFilePreviewPendingNavByWorkspace[workspaceId];
      if (isDeletedPath(pendingNav?.filePath)) {
        get().clearInlineFilePreviewPendingNav(workspaceId);
      }
    }
    return nextActive;
  },

  renamePathInViewers: (workspaceId, move) => {
    const follow = (path: string | null | undefined): string | null =>
      path ? (pathAfterMove(path, move) ?? path) : null;
    set((state) => {
      const inlinePreview = state.inlineFilePreviewByWorkspace[workspaceId];
      return {
        fileViewerTabsByWorkspace: {
          ...state.fileViewerTabsByWorkspace,
          [workspaceId]: (state.fileViewerTabsByWorkspace[workspaceId] ?? []).map(
            (path) => follow(path) ?? path
          ),
        },
        fileViewerPreviewTabByWorkspace: {
          ...state.fileViewerPreviewTabByWorkspace,
          [workspaceId]: follow(state.fileViewerPreviewTabByWorkspace[workspaceId]),
        },
        fileViewerActiveTabByWorkspace: {
          ...state.fileViewerActiveTabByWorkspace,
          [workspaceId]: follow(state.fileViewerActiveTabByWorkspace[workspaceId]),
        },
        ...(inlinePreview?.filePath && {
          inlineFilePreviewByWorkspace: {
            ...state.inlineFilePreviewByWorkspace,
            [workspaceId]: { ...inlinePreview, filePath: follow(inlinePreview.filePath) },
          },
        }),
      };
    });
  },

  setActiveTab: (workspaceId, filePath) => {
    set((state) => ({
      fileViewerActiveTabByWorkspace: {
        ...state.fileViewerActiveTabByWorkspace,
        [workspaceId]: filePath,
      },
    }));
  },

  getActiveTab: (workspaceId) => {
    return get().fileViewerActiveTabByWorkspace[workspaceId] ?? null;
  },

  getTabs: (workspaceId) => {
    return get().fileViewerTabsByWorkspace[workspaceId] ?? EMPTY_TABS;
  },

  getPreviewTab: (workspaceId) => {
    return get().fileViewerPreviewTabByWorkspace[workspaceId] ?? null;
  },

  setPreviewTab: (workspaceId, filePath) => {
    set((state) => ({
      fileViewerPreviewTabByWorkspace: {
        ...state.fileViewerPreviewTabByWorkspace,
        [workspaceId]: filePath,
      },
      fileViewerActiveTabByWorkspace: {
        ...state.fileViewerActiveTabByWorkspace,
        [workspaceId]: filePath,
      },
    }));
  },

  requestCloseTab: () => {
    set((state) => ({ closeTabRequest: state.closeTabRequest + 1 }));
  },

  requestCloseViewer: () => {
    set((state) => ({ closeViewerRequest: state.closeViewerRequest + 1 }));
  },

  clearWorkspaceFileViewerState: (workspaceId) => {
    const {
      inlineFileTreeByWorkspace,
      fileTreeRevealByWorkspace,
      fileViewerDiffComparisonByWorkspace,
      inlineFileTreeWidthByWorkspace,
      inlineFilePreviewByWorkspace,
      inlineFilePreviewNavRequestByWorkspace,
      inlineFilePreviewWidthByWorkspace,
      inlineFilePreviewPendingNavByWorkspace,
      inlineFilePreviewPendingCloseByWorkspace,
      inlineFilePreviewPendingModeChangeByWorkspace,
      liveFollowByWorkspace,
      diffSubModeByWorkspace,
      diffSelectedFileByWorkspace,
      diffSelectedCommitByWorkspace,
      diffHistorySelectedFileByWorkspace,
      diffHistoryBranchByWorkspace,
      diffHistoryFilterPathByWorkspace,
      fileViewerTabsByWorkspace,
      fileViewerActiveTabByWorkspace,
      fileViewerPreviewTabByWorkspace,
      filePickerQueryByWorkspace,
      showGitIgnoredByWorkspace,
    } = get();
    const newInlineFileTree = { ...inlineFileTreeByWorkspace };
    const newFileTreeReveal = { ...fileTreeRevealByWorkspace };
    const newFileViewerDiffComparison = { ...fileViewerDiffComparisonByWorkspace };
    const newInlineFileTreeWidths = { ...inlineFileTreeWidthByWorkspace };
    const newInlineFilePreview = { ...inlineFilePreviewByWorkspace };
    const newInlineFilePreviewNavRequest = { ...inlineFilePreviewNavRequestByWorkspace };
    const newInlineFilePreviewWidths = { ...inlineFilePreviewWidthByWorkspace };
    const newInlinePendingNav = { ...inlineFilePreviewPendingNavByWorkspace };
    const newInlinePendingClose = { ...inlineFilePreviewPendingCloseByWorkspace };
    const newInlinePendingModeChange = { ...inlineFilePreviewPendingModeChangeByWorkspace };
    const newLiveFollow = { ...liveFollowByWorkspace };
    const newDiffSubMode = { ...diffSubModeByWorkspace };
    const newDiffSelectedFile = { ...diffSelectedFileByWorkspace };
    const newDiffSelectedCommit = { ...diffSelectedCommitByWorkspace };
    const newDiffHistorySelectedFile = { ...diffHistorySelectedFileByWorkspace };
    const newDiffHistoryBranch = { ...diffHistoryBranchByWorkspace };
    const newDiffHistoryFilterPath = { ...diffHistoryFilterPathByWorkspace };
    const newTabs = { ...fileViewerTabsByWorkspace };
    const newActiveTabs = { ...fileViewerActiveTabByWorkspace };
    const newPreviewTabs = { ...fileViewerPreviewTabByWorkspace };
    const newPickerQuery = { ...filePickerQueryByWorkspace };
    const newShowGitIgnored = { ...showGitIgnoredByWorkspace };

    delete newInlineFileTree[workspaceId];
    delete newFileTreeReveal[workspaceId];
    delete newFileViewerDiffComparison[workspaceId];
    delete newInlineFileTreeWidths[workspaceId];
    delete newInlineFilePreview[workspaceId];
    delete newInlineFilePreviewNavRequest[workspaceId];
    delete newInlineFilePreviewWidths[workspaceId];
    delete newInlinePendingNav[workspaceId];
    delete newInlinePendingClose[workspaceId];
    delete newInlinePendingModeChange[workspaceId];
    delete newLiveFollow[workspaceId];
    delete newDiffSubMode[workspaceId];
    delete newDiffSelectedFile[workspaceId];
    delete newDiffSelectedCommit[workspaceId];
    delete newDiffHistorySelectedFile[workspaceId];
    delete newDiffHistoryBranch[workspaceId];
    delete newDiffHistoryFilterPath[workspaceId];
    delete newTabs[workspaceId];
    delete newActiveTabs[workspaceId];
    delete newPreviewTabs[workspaceId];
    delete newPickerQuery[workspaceId];
    delete newShowGitIgnored[workspaceId];

    const { pendingFileViewerTransition, pendingFileViewerBlameRequest } = get();
    set({
      inlineFileTreeByWorkspace: newInlineFileTree,
      fileTreeRevealByWorkspace: newFileTreeReveal,
      fileViewerDiffComparisonByWorkspace: newFileViewerDiffComparison,
      inlineFileTreeWidthByWorkspace: newInlineFileTreeWidths,
      inlineFilePreviewByWorkspace: newInlineFilePreview,
      inlineFilePreviewNavRequestByWorkspace: newInlineFilePreviewNavRequest,
      inlineFilePreviewWidthByWorkspace: newInlineFilePreviewWidths,
      inlineFilePreviewPendingNavByWorkspace: newInlinePendingNav,
      inlineFilePreviewPendingCloseByWorkspace: newInlinePendingClose,
      inlineFilePreviewPendingModeChangeByWorkspace: newInlinePendingModeChange,
      liveFollowByWorkspace: newLiveFollow,
      diffSubModeByWorkspace: newDiffSubMode,
      diffSelectedFileByWorkspace: newDiffSelectedFile,
      diffSelectedCommitByWorkspace: newDiffSelectedCommit,
      diffHistorySelectedFileByWorkspace: newDiffHistorySelectedFile,
      diffHistoryBranchByWorkspace: newDiffHistoryBranch,
      diffHistoryFilterPathByWorkspace: newDiffHistoryFilterPath,
      fileViewerTabsByWorkspace: newTabs,
      fileViewerActiveTabByWorkspace: newActiveTabs,
      fileViewerPreviewTabByWorkspace: newPreviewTabs,
      filePickerQueryByWorkspace: newPickerQuery,
      showGitIgnoredByWorkspace: newShowGitIgnored,
      ...(pendingFileViewerTransition?.workspaceId === workspaceId
        ? { pendingFileViewerTransition: null }
        : {}),
      ...(pendingFileViewerBlameRequest?.workspaceId === workspaceId
        ? { pendingFileViewerBlameRequest: null }
        : {}),
    });
  },
}));
