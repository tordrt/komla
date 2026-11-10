import { create } from 'zustand';

import { pathAfterMove, type FileTreeMove } from '@/lib/file-tree-moves';
import {
  decideInlinePreviewTransition,
  type FileViewerTransitionRequest,
  type InlinePreviewTransition,
  type InlinePreviewTransitionDecision,
  type PendingFileViewerTransition,
} from '@/lib/file-viewer-transition';
import { isImportedFilePath } from '@/lib/workspace-file-paths';

import { useConfigStore } from './config.store';

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
  // The note open over the file viewer's file or diff, which stays underneath it.
  fileViewerNoteName: string | null;
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
  // The file switch, mode change or close that waits on the preview's Unsaved Changes prompt,
  // which shows while there is one. Nothing it would change has changed yet, so the file tree
  // never points at a file the user hasn't agreed to open, and cancelling leaves nothing to undo.
  inlineFilePreviewPendingTransitionByWorkspace: Record<string, InlinePreviewTransition | null>;
  // One pending full-screen transition. The mounted dialog owns dirty state
  // and consumes this through the transition module.
  pendingFileViewerTransition: PendingFileViewerTransition | null;
  pendingFileViewerBlameRequest: { workspaceId: string; nonce: number } | null;
  // Inline file preview width ratio per workspace (0-1 of terminal+preview area, excluding file tree)
  inlineFilePreviewWidthByWorkspace: Record<string, number>;
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
  /** Shows a note over the open file viewer's file or diff, or with null goes back to it. */
  showFileViewerNote: (name: string | null) => void;
  setFileViewerMode: (mode: FileViewerMode) => void;
  setDiffSubMode: (subMode: DiffSubMode) => void;
  // Last diff file persistence
  setLastDiffFile: (workingDirectory: string, fileKey: string) => void;
  getLastDiffFile: (workingDirectory: string) => string | undefined;
  // Expanded diff folders persistence
  setExpandedDiffFolders: (workingDirectory: string, folders: string[]) => void;
  getExpandedDiffFolders: (workingDirectory: string) => string[] | undefined;
  /**
   * The sidebar panel each workspace's sidebar last showed, by id, and whether it shows it in place
   * of the file tree. Choosing Diff or Files, or anything that shows the tree, hides it.
   */
  inlineSidebarPanelByWorkspace: Record<string, { id: string; shown: boolean }>;
  /**
   * Shows a sidebar panel in place of the file tree, and saves that it does unless `save` is
   * false, as when restoring what was saved.
   */
  showInlineSidebarPanel: (workspaceId: string, id: string, options?: { save?: boolean }) => void;
  /** Shows a sidebar panel, opening the sidebar first if it's closed, as a status item's click. */
  openInlineSidebarPanel: (workspaceId: string, id: string) => void;
  // Inline file tree panel actions
  toggleInlineFileTree: (workspaceId: string) => void;
  setInlineFileTreeOpen: (workspaceId: string, open: boolean) => void;
  /**
   * Shows the tree in `mode`, hiding a sidebar panel shown in its place, unless `keepSidebarPanel`:
   * for a change the user didn't make here, such as restoring the saved mode.
   */
  setInlineFileTreeMode: (
    workspaceId: string,
    mode: 'diff' | 'browse',
    /** `save` false sets the mode without saving it, as when restoring what was saved. */
    options?: { keepSidebarPanel?: boolean; save?: boolean }
  ) => void;
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
  // Requests close of the inline preview. If the current preview is dirty, the
  // request is staged (panel shows confirm dialog); otherwise closes directly.
  // `unsaved` says the edits are unsaved where the panel knows better than the store.
  requestInlineFilePreviewClose: (workspaceId: string, options?: { unsaved?: boolean }) => void;
  // Requests a tree+preview mode change. If the open preview is dirty and the
  // mode would actually change, the request is staged (panel shows confirm
  // dialog); otherwise both modes are applied directly.
  requestInlineFilePreviewModeChange: (workspaceId: string, nextMode: FileViewerMode) => void;
  /** Whether the preview would ask before `transition`, for a caller with more to do once it lands. */
  inlineFilePreviewWouldAsk: (workspaceId: string, transition: InlinePreviewTransition) => boolean;
  /** The Unsaved Changes prompt's answer: Discard applies the waiting transition, Cancel drops it. */
  answerInlineFilePreviewPrompt: (workspaceId: string, answer: 'discard' | 'cancel') => void;
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

  // Imported files section collapsed (per workspace, not persisted)
  importedFilesCollapsedByWorkspace: Record<string, boolean>;
  setImportedFilesCollapsed: (workspaceId: string, collapsed: boolean) => void;
  // Notes section collapsed (per workspace, not persisted)
  notesCollapsedByWorkspace: Record<string, boolean>;
  setNotesCollapsed: (workspaceId: string, collapsed: boolean) => void;
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

/**
 * Whether a workspace's file panel is open. Until `TerminalTabs` seeds it from the workspace's saved
 * `fileTreeOpen`, a workspace counts as closed, as one saved before that field existed does, so
 * this agrees with `defaultFileTreeOpen`, off out of the box.
 */
export function isInlineFileTreeOpen(
  state: Pick<FileViewerState, 'inlineFileTreeByWorkspace'>,
  workspaceId: string
): boolean {
  return state.inlineFileTreeByWorkspace[workspaceId]?.open ?? false;
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

type FileViewerStoreGet = () => FileViewerState;
type FileViewerStoreSet = (partial: Partial<FileViewerState>) => void;

/** The only writer of a workspace's pending inline preview transition, as a state patch. */
function pendingInlineTransitionPatch(
  state: FileViewerState,
  workspaceId: string,
  transition: InlinePreviewTransition | null
): Pick<FileViewerState, 'inlineFilePreviewPendingTransitionByWorkspace'> {
  return {
    inlineFilePreviewPendingTransitionByWorkspace: {
      ...state.inlineFilePreviewPendingTransitionByWorkspace,
      [workspaceId]: transition,
    },
  };
}

function setPendingInlineTransition(
  get: FileViewerStoreGet,
  set: FileViewerStoreSet,
  workspaceId: string,
  transition: InlinePreviewTransition | null
): void {
  const state = get();
  if ((state.inlineFilePreviewPendingTransitionByWorkspace[workspaceId] ?? null) === transition) {
    return;
  }
  set(pendingInlineTransitionPatch(state, workspaceId, transition));
}

function decideFor(
  get: FileViewerStoreGet,
  workspaceId: string,
  transition: InlinePreviewTransition,
  unsaved?: boolean
) {
  const preview = get().inlineFilePreviewByWorkspace[workspaceId];
  return decideInlinePreviewTransition(transition, {
    open: !!preview?.open,
    dirty: unsaved ?? !!preview?.isDirty,
    filePath: preview?.filePath ?? null,
    mode: preview?.mode ?? 'browse',
  });
}

/** Applies a transition the preview needn't ask about, or else has it wait for the prompt. */
function requestInlineTransition(
  get: FileViewerStoreGet,
  set: FileViewerStoreSet,
  workspaceId: string,
  transition: InlinePreviewTransition,
  unsaved?: boolean
): InlinePreviewTransitionDecision {
  const decision = decideFor(get, workspaceId, transition, unsaved);
  if (decision === 'apply') applyInlineTransition(get, workspaceId, transition);
  if (decision === 'confirm') setPendingInlineTransition(get, set, workspaceId, transition);
  return decision;
}

function applyInlineTransition(
  get: FileViewerStoreGet,
  workspaceId: string,
  transition: InlinePreviewTransition
): void {
  const store = get();
  switch (transition.kind) {
    case 'file':
      if (
        (transition.browseTree || transition.htmlPreviewIntent) &&
        store.inlineFileTreeByWorkspace[workspaceId]?.mode !== 'browse'
      ) {
        store.setInlineFileTreeMode(workspaceId, 'browse');
      }
      get().openInlineFilePreview(
        workspaceId,
        transition.mode,
        transition.filePath,
        transition.lineNumber
      );
      return;
    case 'mode':
      store.setInlineFileTreeMode(workspaceId, transition.mode);
      get().setInlineFilePreviewMode(workspaceId, transition.mode);
      return;
    case 'close':
      store.closeInlineFilePreview(workspaceId);
  }
}

export const useFileViewerStore = create<FileViewerState>((set, get) => ({
  fileViewerWorkspaceId: null,
  fileViewerMode: 'browse',
  fileViewerInitialFilePath: null,
  fileViewerInitialLineNumber: null,
  fileViewerDiffSubMode: 'changes',
  fileViewerHistoryFilterPath: null,
  fileViewerNoteName: null,
  lastDiffFileByWorkingDir: {},
  expandedDiffFoldersByWorkingDir: {},
  inlineFileTreeByWorkspace: {},
  inlineSidebarPanelByWorkspace: {},
  fileTreeRevealByWorkspace: {},
  fileViewerDiffComparisonByWorkspace: {},
  inlineFileTreeWidthByWorkspace: {},
  inlineFilePreviewByWorkspace: {},
  inlineFilePreviewNavRequestByWorkspace: {},
  inlineFilePreviewPendingTransitionByWorkspace: {},
  pendingFileViewerTransition: null,
  pendingFileViewerBlameRequest: null,
  inlineFilePreviewWidthByWorkspace: {},
  diffViewMode: readStoredDiffViewMode(),
  diffSubModeByWorkspace: {},
  diffSelectedFileByWorkspace: {},
  diffSelectedCommitByWorkspace: {},
  diffHistorySelectedFileByWorkspace: {},
  diffHistoryBranchByWorkspace: {},
  diffHistoryFilterPathByWorkspace: {},
  fileViewerTabsByWorkspace: {},
  fileViewerActiveTabByWorkspace: {},
  fileViewerPreviewTabByWorkspace: {},
  filePickerQueryByWorkspace: {},
  showGitIgnoredByWorkspace: {},
  importedFilesCollapsedByWorkspace: {},
  notesCollapsedByWorkspace: {},
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
      fileViewerNoteName: null,
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
      fileViewerNoteName: null,
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
  showFileViewerNote: (name) => {
    if (get().fileViewerNoteName !== name) set({ fileViewerNoteName: name });
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
    const newOpen = !isInlineFileTreeOpen({ inlineFileTreeByWorkspace }, workspaceId);
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

  showInlineSidebarPanel: (workspaceId, id, options) => {
    set((state) => ({
      inlineSidebarPanelByWorkspace: {
        ...state.inlineSidebarPanelByWorkspace,
        [workspaceId]: { id, shown: true },
      },
    }));
    if (options?.save === false) return;
    window.api.updateWorkspace(workspaceId, { sidebarPanelId: id }).catch(() => {});
  },

  openInlineSidebarPanel: (workspaceId, id) => {
    if (!isInlineFileTreeOpen(get(), workspaceId)) {
      get().toggleInlineFileTree(workspaceId);
    }
    get().showInlineSidebarPanel(workspaceId, id);
  },

  setInlineFileTreeMode: (workspaceId, mode, options) => {
    const { inlineFileTreeByWorkspace, inlineSidebarPanelByWorkspace } = get();
    const current = inlineFileTreeByWorkspace[workspaceId];
    const panel = inlineSidebarPanelByWorkspace[workspaceId];
    const hidesPanel = panel?.shown && !options?.keepSidebarPanel;
    set({
      // The tree shows again; the panel's tab keeps the panel for next time.
      ...(hidesPanel && {
        inlineSidebarPanelByWorkspace: {
          ...inlineSidebarPanelByWorkspace,
          [workspaceId]: { ...panel, shown: false },
        },
      }),
      inlineFileTreeByWorkspace: {
        ...inlineFileTreeByWorkspace,
        [workspaceId]: {
          open: isInlineFileTreeOpen({ inlineFileTreeByWorkspace }, workspaceId),
          mode,
          comparisonBranch: current?.comparisonBranch,
          useMergeBase: current?.useMergeBase,
        },
      },
    });
    if (options?.save === false) return;
    window.api
      .updateWorkspace(workspaceId, {
        fileTreeMode: mode,
        ...(hidesPanel && { sidebarPanelId: null }),
      })
      .catch(() => {});
  },

  revealInFileTree: (workspaceId, folderPath) => {
    if (!isInlineFileTreeOpen(get(), workspaceId)) {
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
          open: isInlineFileTreeOpen({ inlineFileTreeByWorkspace }, workspaceId),
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
        // filePath is force-cleared so the sidebar file tree can drop its
        // selection. Without this, closing the preview leaves the row looking
        // active and re-clicking it becomes a no-op (pierre's
        // selectOnlyPath/focus are both no-ops on an already-active row).
        [workspaceId]: { ...defaults, ...current, open: false, filePath: null },
      },
      ...pendingInlineTransitionPatch(get(), workspaceId, null),
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
    const transition: InlinePreviewTransition = {
      kind: 'file',
      mode,
      filePath,
      lineNumber,
      htmlPreviewIntent: options?.htmlPreviewIntent,
      browseTree: options?.browseTree,
    };
    const decision = requestInlineTransition(get, set, workspaceId, transition);
    // A navigation still resolving its target is now older than this one.
    if (decision === 'confirm' && options?.requestId === undefined) {
      get().reserveInlineFilePreviewNav(workspaceId);
    }
  },

  requestInlineFilePreviewClose: (workspaceId, options) => {
    requestInlineTransition(get, set, workspaceId, { kind: 'close' }, options?.unsaved);
  },

  requestInlineFilePreviewModeChange: (workspaceId, nextMode) => {
    const current = get().inlineFilePreviewByWorkspace[workspaceId];
    // An imported file is out of git, so it has no diff to switch to: the tree alone changes.
    if (
      nextMode === 'diff' &&
      current?.open &&
      current.filePath &&
      isImportedFilePath(current.filePath)
    ) {
      get().setInlineFileTreeMode(workspaceId, nextMode);
      return;
    }
    requestInlineTransition(get, set, workspaceId, { kind: 'mode', mode: nextMode });
  },

  inlineFilePreviewWouldAsk: (workspaceId, transition) =>
    decideFor(get, workspaceId, transition) === 'confirm',

  answerInlineFilePreviewPrompt: (workspaceId, answer) => {
    const transition = get().inlineFilePreviewPendingTransitionByWorkspace[workspaceId];
    if (!transition) return;
    // Cleared first: a request made while applying this one starts afresh.
    setPendingInlineTransition(get, set, workspaceId, null);
    if (answer === 'discard') applyInlineTransition(get, workspaceId, transition);
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

  setImportedFilesCollapsed: (workspaceId, collapsed) => {
    set((state) => ({
      importedFilesCollapsedByWorkspace: {
        ...state.importedFilesCollapsedByWorkspace,
        [workspaceId]: collapsed,
      },
    }));
  },

  setNotesCollapsed: (workspaceId, collapsed) => {
    set((state) => ({
      notesCollapsedByWorkspace: {
        ...state.notesCollapsedByWorkspace,
        [workspaceId]: collapsed,
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
      const pending = state.inlineFilePreviewPendingTransitionByWorkspace[workspaceId];
      if (pending?.kind === 'file' && isDeletedPath(pending.filePath)) {
        setPendingInlineTransition(get, set, workspaceId, null);
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
      inlineSidebarPanelByWorkspace,
      fileTreeRevealByWorkspace,
      fileViewerDiffComparisonByWorkspace,
      inlineFileTreeWidthByWorkspace,
      inlineFilePreviewByWorkspace,
      inlineFilePreviewNavRequestByWorkspace,
      inlineFilePreviewWidthByWorkspace,
      inlineFilePreviewPendingTransitionByWorkspace,
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
      importedFilesCollapsedByWorkspace,
      notesCollapsedByWorkspace,
    } = get();
    const newInlineFileTree = { ...inlineFileTreeByWorkspace };
    const newInlineSidebarPanel = { ...inlineSidebarPanelByWorkspace };
    const newFileTreeReveal = { ...fileTreeRevealByWorkspace };
    const newFileViewerDiffComparison = { ...fileViewerDiffComparisonByWorkspace };
    const newInlineFileTreeWidths = { ...inlineFileTreeWidthByWorkspace };
    const newInlineFilePreview = { ...inlineFilePreviewByWorkspace };
    const newInlineFilePreviewNavRequest = { ...inlineFilePreviewNavRequestByWorkspace };
    const newInlineFilePreviewWidths = { ...inlineFilePreviewWidthByWorkspace };
    const newInlinePendingTransition = { ...inlineFilePreviewPendingTransitionByWorkspace };
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
    const newImportedFilesCollapsed = { ...importedFilesCollapsedByWorkspace };
    const newNotesCollapsed = { ...notesCollapsedByWorkspace };

    delete newInlineFileTree[workspaceId];
    delete newInlineSidebarPanel[workspaceId];
    delete newFileTreeReveal[workspaceId];
    delete newFileViewerDiffComparison[workspaceId];
    delete newInlineFileTreeWidths[workspaceId];
    delete newInlineFilePreview[workspaceId];
    delete newInlineFilePreviewNavRequest[workspaceId];
    delete newInlineFilePreviewWidths[workspaceId];
    delete newInlinePendingTransition[workspaceId];
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
    delete newImportedFilesCollapsed[workspaceId];
    delete newNotesCollapsed[workspaceId];

    const { pendingFileViewerTransition, pendingFileViewerBlameRequest } = get();
    set({
      inlineFileTreeByWorkspace: newInlineFileTree,
      inlineSidebarPanelByWorkspace: newInlineSidebarPanel,
      fileTreeRevealByWorkspace: newFileTreeReveal,
      fileViewerDiffComparisonByWorkspace: newFileViewerDiffComparison,
      inlineFileTreeWidthByWorkspace: newInlineFileTreeWidths,
      inlineFilePreviewByWorkspace: newInlineFilePreview,
      inlineFilePreviewNavRequestByWorkspace: newInlineFilePreviewNavRequest,
      inlineFilePreviewWidthByWorkspace: newInlineFilePreviewWidths,
      inlineFilePreviewPendingTransitionByWorkspace: newInlinePendingTransition,
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
      importedFilesCollapsedByWorkspace: newImportedFilesCollapsed,
      notesCollapsedByWorkspace: newNotesCollapsed,
      ...(pendingFileViewerTransition?.workspaceId === workspaceId
        ? { pendingFileViewerTransition: null }
        : {}),
      ...(pendingFileViewerBlameRequest?.workspaceId === workspaceId
        ? { pendingFileViewerBlameRequest: null }
        : {}),
    });
  },
}));
