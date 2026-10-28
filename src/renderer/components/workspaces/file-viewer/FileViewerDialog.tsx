import { useEffect, useCallback, useRef, useState, useMemo } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  moveFileTreePaths,
  pathAfterMove,
  renameFileTreePath,
  type FileTreeMove,
} from '@/lib/file-tree-moves';
import { pasteFileTreeNode } from '@/lib/file-tree-paste';
import {
  decideFileViewerTransition,
  type FileViewerTransition,
} from '@/lib/file-viewer-transition';
import { joinAbsPath } from '@/lib/fs-path';
import { ensureMonacoInitialized } from '@/lib/monaco-loader';
import { useActivePalette } from '@/lib/palette-runtime';
import { followMovedFilePanes, getUnsavedFilePanePaths } from '@/lib/pane-surfaces';
import { getRevealInFileManagerLabel } from '@/lib/platform-labels';
import { primaryForMode } from '@/lib/primary-color';
import { colorToOklchValues, getProjectColor } from '@/lib/project-colors';
import { executeShortcutAction } from '@/lib/shortcut-actions';
import { findRenameSource, useFileListStore } from '@/stores/file-list.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useGitStatusStore } from '@/stores/git-status.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useToastStore } from '@/stores/toast.store';
import {
  resolveWorkspaceTargetBranch,
  type Workspace,
  type FileChange,
  type BlameHunk,
} from '@/types';

import { dispatchFileViewerKeydown, isEditorEscapeTarget } from './file-viewer-keyboard';
import {
  COPY_AT_PATH_KEYBINDING,
  computeEditorChangeEffects,
  getFlatFileKeys,
  formatAtPathWithLine,
  readMountedEditor,
  getAncestorPaths,
  removeNonFunctionalActions,
  shouldNavigateAfterDeletion,
} from './file-viewer-utils';
import { FileViewerConfirmDialogs } from './FileViewerConfirmDialogs';
import { FileViewerMainPane } from './FileViewerMainPane';
import { resolveCurrentFile } from './FileViewerSidebar';
import { setHtmlViewMode } from './html-view-mode';
import { useBlameState } from './useBlameState';
import {
  useCloseTabRequest,
  useCloseViewerRequest,
  useInitialFileTarget,
  useResetOnClose,
} from './useFileViewerEffects';
import { useFileViewerState } from './useFileViewerState';
import { useFileWatcherSync } from './useFileWatcherSync';
import { useLiveFollow } from './useLiveFollow';

import type { MarkdownEditorHandle } from './markdown/RichMarkdownEditor';
import type { FileViewerMode } from './types';
import type { editor as monacoEditor } from 'monaco-editor';

// Module-level cache for Monaco editor view states (scroll position, cursor, etc.)
// Keyed by "workspaceId:filePath" — survives dialog close/reopen within the session.
const editorViewStateCache = new Map<string, monacoEditor.ICodeEditorViewState>();

function viewStateCacheKey(workspaceId: string, filePath: string): string {
  return `${workspaceId}:${filePath}`;
}

interface FileViewerDialogProps {
  workspace: Workspace;
  open: boolean;
  mode: FileViewerMode;
  onOpenChange: (open: boolean) => void;
  initialFilePath?: string | null;
  initialLineNumber?: number;
  initialHistoryFilterPath?: string | null;
}

export function FileViewerDialog({
  workspace,
  open,
  mode: initialMode,
  onOpenChange,
  initialFilePath,
  initialLineNumber,
  initialHistoryFilterPath,
}: FileViewerDialogProps) {
  const SIDEBAR_MIN_WIDTH = 190;
  const SIDEBAR_MAX_WIDTH = 600;
  const HISTORY_SIDEBAR_WIDTH = 300;
  const isRemoteWorkspace = workspace.backend?.kind === 'ssh';
  const isGitWorkspace = workspace.isWorktree;

  // Resolve target branch for quick toggle
  const gitStatus = useGitStatusStore((s) => s.getStatus(workspace.id));
  const project = useProjectsStore((s) =>
    workspace.projectId ? s.projects.find((p) => p.id === workspace.projectId) : undefined
  );
  const targetBranch =
    resolveWorkspaceTargetBranch(workspace, project?.baseBranch, gitStatus?.status?.mainBranch) ||
    'main';

  // Compute project accent color for --primary override (dialog renders in a portal outside mainRef)
  const paletteMode = useActivePalette().mode;
  const projectColorOklch = useMemo(() => {
    if (!project) return undefined;
    const hsl = project.color || getProjectColor(project.name);
    const oklch = colorToOklchValues(hsl);
    return oklch ? primaryForMode(oklch, paletteMode) : undefined;
  }, [project, paletteMode]);

  const state = useFileViewerState(
    workspace.workingDirectory,
    open,
    isGitWorkspace ? initialMode : 'browse',
    workspace.id,
    isGitWorkspace,
    initialHistoryFilterPath
  );
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  // Set while a Markdown file shows as rich text, which then holds the buffer instead of Monaco.
  const markdownEditorRef = useRef<MarkdownEditorHandle | null>(null);
  const diffEditorRef = useRef<monacoEditor.IStandaloneDiffEditor | null>(null);
  const currentFilePathRef = useRef<string | null>(null);
  // The current file while it has unsaved edits, which tree moves leave alone.
  const unsavedFilePathRef = useRef<string | null>(null);
  // Updated synchronously during render (not in useEffect) so child onMount callbacks
  // see the current file path even before parent effects run.
  const browseFilePathRef = useRef<string | null>(state.editor.filePath);

  // Save view state during render BEFORE the old editor unmounts.
  // When filePath changes, openFile sets loadingFile=true which causes EditorPane to
  // unmount the Monaco editor. By saving here (during render, before DOM updates),
  // the old editor is still alive and saveViewState() works.
  if (
    state.mode === 'browse' &&
    state.editor.filePath !== browseFilePathRef.current &&
    browseFilePathRef.current &&
    editorRef.current
  ) {
    const viewState = editorRef.current.saveViewState();
    if (viewState) {
      editorViewStateCache.set(
        viewStateCacheKey(workspace.id, browseFilePathRef.current),
        viewState
      );
    }
  }
  browseFilePathRef.current = state.editor.filePath;
  const saveFileRef = useRef<() => void | Promise<void>>(() => {});
  const hideUnchangedRef = useRef(state.diff.hideUnchangedRegions);

  // Save the current editor's view state (scroll position, cursor, selections) to the cache.
  // Only meaningful in browse mode — in diff mode editorRef may point to a stale instance.
  const saveEditorViewState = useCallback(() => {
    if (state.mode !== 'browse') return;
    const editor = editorRef.current;
    const filePath = currentFilePathRef.current;
    if (editor && filePath) {
      const viewState = editor.saveViewState();
      if (viewState) {
        editorViewStateCache.set(viewStateCacheKey(workspace.id, filePath), viewState);
      }
    }
  }, [workspace.id, state.mode]);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [filesSidebarWidth, setFilesSidebarWidth] = useState(SIDEBAR_MIN_WIDTH);
  const [historySidebarWidth, setHistorySidebarWidth] = useState(HISTORY_SIDEBAR_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isMonacoReady, setIsMonacoReady] = useState(false);
  const [monacoLoadError, setMonacoLoadError] = useState<string | null>(null);
  const [fileToDelete, setFileToDelete] = useState<{ path: string; isDirectory: boolean } | null>(
    null
  );
  const [fileToRestore, setFileToRestore] = useState<{
    path: string;
    status: FileChange['status'];
  } | null>(null);

  useEffect(() => {
    if (!open || !isRemoteWorkspace) return;
    useFileListStore
      .getState()
      .fetchFileList(workspace.workingDirectory, false, workspace.id)
      .catch(() => {});
  }, [open, isRemoteWorkspace, workspace.id, workspace.workingDirectory]);
  const [rollbackAllConfirmOpen, setRollbackAllConfirmOpen] = useState(false);
  const [unsavedConfirmOpen, setUnsavedConfirmOpen] = useState(false);
  const [pendingTransition, setPendingTransition] = useState<FileViewerTransition | null>(null);
  // Bumped when the unsaved-changes dialog is dismissed without applying — the
  // SidebarFileTree uses this to realign pierre's focus back to currentFile,
  // since the focus-observing effect already moved it to the rejected target
  // before our handler decided to refuse the navigation.
  const [focusAlignmentSignal, setFocusAlignmentSignal] = useState(0);
  const bumpFocusAlignment = useCallback(() => {
    setFocusAlignmentSignal((n) => n + 1);
  }, []);
  const clearPendingTransition = useCallback(() => setPendingTransition(null), []);

  // Copy/paste state
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [copiedIsDirectory, setCopiedIsDirectory] = useState(false);
  const [isCut, setIsCut] = useState(false);
  const [overwriteTarget, setOverwriteTarget] = useState<{
    src: string;
    dest: string;
    isDirectory: boolean;
  } | null>(null);

  // Create file/folder state
  const [createTarget, setCreateTarget] = useState<{
    parentDir: string;
    type: 'file' | 'directory';
  } | null>(null);
  const [createValue, setCreateValue] = useState('');

  // Conflict resolution state
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);

  // Change navigation state
  const [currentChangeIndex, setCurrentChangeIndex] = useState(-1);
  const [totalChanges, setTotalChanges] = useState(0);
  const pendingChangeTargetRef = useRef<'first' | 'last' | null>(null);
  const pendingLineJumpRef = useRef<number | null>(null);
  const handleCloseTabRef = useRef<
    (filePath: string, options?: { skipDirtyCheck?: boolean }) => void
  >(() => {});
  const closeViewerRef = useRef<() => void>(() => {});

  // Live follow state
  const liveFollow = useFileViewerStore((s) => !!s.liveFollowByWorkspace[workspace.id]);

  // Blame state
  const blame = useBlameState();
  const { blameEnabled, clearBlame, loadBlame, toggleBlame } = blame;
  const blameToggleRef = useRef(toggleBlame);
  blameToggleRef.current = toggleBlame;

  // Diff sub-mode (changes vs history tab)
  const diffSubMode = useFileViewerStore((s) => s.fileViewerDiffSubMode);
  const setDiffSubMode = useFileViewerStore((s) => s.setDiffSubMode);
  // History's one-line commits want more room than file names, so it keeps its own width.
  const showsHistory = state.mode === 'diff' && diffSubMode === 'history';
  const sidebarWidth = showsHistory ? historySidebarWidth : filesSidebarWidth;
  const setSidebarWidth = showsHistory ? setHistorySidebarWidth : setFilesSidebarWidth;

  // Browse mode tabs (full screen file viewer only)
  const tabs = useFileViewerStore((s) => s.getTabs(workspace.id));
  const previewTab = useFileViewerStore((s) => s.getPreviewTab(workspace.id));
  const openTab = useFileViewerStore((s) => s.openTab);
  const closeTab = useFileViewerStore((s) => s.closeTab);
  const setActiveTab = useFileViewerStore((s) => s.setActiveTab);
  const setPreviewTab = useFileViewerStore((s) => s.setPreviewTab);

  const applyModeTransitionAfter = useCallback(
    (after: Extract<FileViewerTransition, { kind: 'mode' }>['after']) => {
      if (!after) return;
      if (after.kind === 'history-file') {
        state.diff.setHistoryFilterPath(after.filePath);
        return;
      }
      if (after.kind === 'browser-file') {
        setHtmlViewMode(workspace.workingDirectory, 'browser');
        openTab(workspace.id, after.filePath, false);
        if (state.editor.filePath !== after.filePath) void state.editor.openFile(after.filePath);
        return;
      }
      if (after.kind === 'browse-file') {
        if (after.lineNumber) pendingLineJumpRef.current = after.lineNumber;
        setPreviewTab(workspace.id, after.filePath);
        void state.editor.openFile(after.filePath);
        if (after.enableBlame) useFileViewerStore.getState().requestFileViewerBlame(workspace.id);
        return;
      }
      if (after.kind === 'diff-file') {
        void state.diff.selectFileByPath(after.filePath);
        return;
      }
      void state.diff.loadCommitsUntil(after.commitHash).then(() => {
        void state.diff.selectCommit(after.commitHash, after.filePath);
      });
    },
    [openTab, setPreviewTab, state.diff, state.editor, workspace.id, workspace.workingDirectory]
  );

  const handleModeChange = useCallback(
    (
      newMode: FileViewerMode,
      nextDiffSubMode?: 'changes' | 'history',
      after?: Extract<FileViewerTransition, { kind: 'mode' }>['after']
    ): boolean => {
      const transition: FileViewerTransition = {
        kind: 'mode',
        mode: newMode,
        diffSubMode: nextDiffSubMode,
        after,
      };
      const decision = decideFileViewerTransition(transition, {
        dirty: state.editor.isDirty,
        mode: state.mode,
        diffSubMode,
        currentFilePath: state.editor.filePath,
      });
      if (decision.kind === 'confirm') {
        setPendingTransition(transition);
        setUnsavedConfirmOpen(true);
        return false;
      }
      if (state.mode !== newMode) {
        state.setMode(newMode);
        useFileViewerStore.getState().setFileViewerMode(newMode);
      }
      if (nextDiffSubMode) setDiffSubMode(nextDiffSubMode);
      applyModeTransitionAfter(after);
      return true;
    },
    [state, diffSubMode, setDiffSubMode, applyModeTransitionAfter]
  );

  // Handle tab switching (browse mode only)
  const handleSwitchTab = useCallback(
    (filePath: string) => {
      if (state.editor.isDirty) {
        setPendingTransition({ kind: 'file', filePath, browseAction: 'persistent' });
        setUnsavedConfirmOpen(true);
        return;
      }
      setActiveTab(workspace.id, filePath);
      void state.editor.openFile(filePath);
    },
    [state.editor, workspace.id, setActiveTab]
  );

  // Handle tab closing (browse mode only)
  const handleCloseTab = useCallback(
    (filePath: string, options?: { skipDirtyCheck?: boolean }) => {
      if (!options?.skipDirtyCheck && state.editor.isDirty && filePath === state.editor.filePath) {
        setPendingTransition({ kind: 'file', filePath, browseAction: 'close-tab' });
        setUnsavedConfirmOpen(true);
        return;
      }

      const currentTabs = useFileViewerStore.getState().getTabs(workspace.id);
      const currentPreview = useFileViewerStore.getState().getPreviewTab(workspace.id);
      const isActiveFile = filePath === state.editor.filePath;

      // If closing the preview tab (not a persistent tab), just clear it
      if (filePath === currentPreview && !currentTabs.includes(filePath)) {
        setPreviewTab(workspace.id, null);
        if (isActiveFile && currentTabs.length > 0) {
          void state.editor.openFile(currentTabs[currentTabs.length - 1]);
        } else if (isActiveFile) {
          // Nothing left — close the file viewer
          state.editor.reset();
          onOpenChange(false);
        }
        return;
      }

      closeTab(workspace.id, filePath);

      if (isActiveFile) {
        const newTabs = currentTabs.filter((t) => t !== filePath);
        if (newTabs.length > 0) {
          void state.editor.openFile(newTabs[newTabs.length - 1]);
        } else if (currentPreview && currentPreview !== filePath) {
          void state.editor.openFile(currentPreview);
        } else {
          // Nothing left — close the file viewer
          state.editor.reset();
          onOpenChange(false);
        }
      }
    },
    [workspace.id, closeTab, setPreviewTab, state.editor, onOpenChange]
  );
  handleCloseTabRef.current = handleCloseTab;

  const handleBlameHunkClick = useCallback(
    (hunk: BlameHunk) => {
      const filePath = state.editor.filePath;
      handleModeChange('diff', 'history', {
        kind: 'commit',
        commitHash: hunk.commitHash,
        filePath: filePath ?? undefined,
      });
    },
    [handleModeChange, state.editor.filePath]
  );

  const handleSidebarResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizingSidebar(true);
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const handleMouseMove = (e: MouseEvent) => {
        const newWidth = Math.min(
          Math.max(SIDEBAR_MIN_WIDTH, startWidth + (e.clientX - startX)),
          SIDEBAR_MAX_WIDTH
        );
        setSidebarWidth(newWidth);
      };

      const handleMouseUp = () => {
        setIsResizingSidebar(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [sidebarWidth, setSidebarWidth]
  );

  const jumpToLine = useCallback((lineNumber: number) => {
    if (!Number.isFinite(lineNumber) || lineNumber <= 0) return;
    pendingLineJumpRef.current = lineNumber;
    if (markdownEditorRef.current) {
      markdownEditorRef.current.revealLine(lineNumber);
      pendingLineJumpRef.current = null;
      return;
    }
    if (!editorRef.current) return;
    editorRef.current.revealLineInCenter(lineNumber);
    editorRef.current.setPosition({ lineNumber, column: 1 });
    editorRef.current.focus();
    pendingLineJumpRef.current = null;
  }, []);

  // Track baseline content for diff editor to distinguish user edits from file loads.
  // Set on mount (in handleDiffEditorMount) and on save. The DiffEditor remounts on
  // file switch (via key change), so the mount handler always sets the correct baseline.
  const diffBaselineRef = useRef<string | null>(null);

  useResetOnClose({
    open,
    setIsMonacoReady,
    setMonacoLoadError,
    setFileToDelete,
    setFileToRestore,
    setCreateTarget,
    setUnsavedConfirmOpen,
    setCopiedPath,
    setCurrentChangeIndex,
    setTotalChanges,
    setConflictDialogOpen,
    pendingLineJumpRef,
    diffBaselineRef,
    extraReset: clearPendingTransition,
  });

  // React to close-tab requests from ShortcutProvider (pane-close intercepted at IPC level)
  useCloseTabRequest({
    open,
    mode: state.mode,
    editorFilePath: state.editor.filePath,
    closeTabRef: handleCloseTabRef,
    onOpenChange,
  });

  // Keep currentFilePathRef in sync (for Monaco addAction closures that capture at mount time)
  useEffect(() => {
    if (state.mode === 'diff') {
      currentFilePathRef.current =
        diffSubMode === 'history'
          ? state.diff.historySelectedFile
          : state.diff.selectedFile
            ? state.diff.selectedFile
            : null;
    } else {
      currentFilePathRef.current = state.editor.filePath;
    }
    unsavedFilePathRef.current = state.editor.isDirty ? currentFilePathRef.current : null;
  }, [
    diffSubMode,
    state.mode,
    state.diff.selectedFile,
    state.diff.historySelectedFile,
    state.editor.filePath,
    state.editor.isDirty,
  ]);

  // Keep hideUnchangedRef in sync for Monaco context menu action
  useEffect(() => {
    hideUnchangedRef.current = state.diff.hideUnchangedRegions;
  }, [state.diff.hideUnchangedRegions]);

  // Load/clear blame when toggle or file changes
  useEffect(() => {
    if (blameEnabled && state.editor.filePath && state.mode === 'browse') {
      void loadBlame(workspace.workingDirectory, state.editor.filePath);
    } else {
      clearBlame();
    }
  }, [
    blameEnabled,
    clearBlame,
    loadBlame,
    state.editor.filePath,
    state.mode,
    workspace.workingDirectory,
  ]);

  // Clear blame when dialog closes
  useEffect(() => {
    if (!open) clearBlame();
  }, [open, clearBlame]);

  const pendingFileViewerBlameRequest = useFileViewerStore((s) => s.pendingFileViewerBlameRequest);
  useEffect(() => {
    if (!open) return;
    if (!pendingFileViewerBlameRequest) return;
    if (pendingFileViewerBlameRequest.workspaceId !== workspace.id) return;
    useFileViewerStore.getState().clearPendingFileViewerBlameRequest();
    if (isRemoteWorkspace) return;
    if (!blameEnabled) {
      toggleBlame();
    }
  }, [
    pendingFileViewerBlameRequest,
    open,
    workspace.id,
    isRemoteWorkspace,
    blameEnabled,
    toggleBlame,
  ]);

  // Compute changed file items for diff mode tree (preserves isDirectory hint)
  const changedFiles = useMemo(() => {
    if (!state.diff.diffData?.files) return [];
    return state.diff.diffData.files.map((f) => ({ path: f.path, isDirectory: f.isDirectory }));
  }, [state.diff.diffData?.files]);

  // Compute file statuses from diff data (accounts for comparison branch)
  const diffFileStatuses = useMemo(() => {
    if (!state.diff.diffData?.files) return undefined;
    const statuses = new Map<string, FileChange['status']>();
    for (const f of state.diff.diffData.files) {
      statuses.set(f.path, f.status);
      for (const ancestor of getAncestorPaths(f.path)) {
        if (!statuses.has(ancestor)) {
          statuses.set(ancestor, 'modified');
        }
      }
    }
    return statuses;
  }, [state.diff.diffData?.files]);

  // Reset state when dialog closes (lazily, after diffBaselineRef is declared below)

  // Lazy-load Monaco only when the file viewer opens.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setMonacoLoadError(null);
    setIsMonacoReady(false);

    void ensureMonacoInitialized()
      .then(() => {
        if (!cancelled) setIsMonacoReady(true);
      })
      .catch((error) => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : 'Unknown Monaco initialization error';
        setMonacoLoadError(`Failed to initialize editor: ${message}`);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Watch for conflicts and show dialog
  useEffect(() => {
    if (state.editor.hasExternalChange && state.editor.isDirty) {
      setConflictDialogOpen(true);
    }
  }, [state.editor.hasExternalChange, state.editor.isDirty]);

  // Handle file selection - single click opens preview tab (for browse mode).
  // Re-clicking the preview tab promotes it to persistent, matching double-click.
  const handleFileSelect = useCallback(
    (path: string) => {
      if (state.editor.isDirty) {
        setPendingTransition({
          kind: 'file',
          filePath: path,
          browseAction: state.mode === 'browse' ? 'preview' : null,
        });
        setUnsavedConfirmOpen(true);
        return;
      }
      if (state.mode === 'browse') {
        const preview = useFileViewerStore.getState().getPreviewTab(workspace.id);
        if (preview === path) {
          openTab(workspace.id, path, false);
        } else {
          setPreviewTab(workspace.id, path);
        }
      }
      void state.editor.openFile(path);
    },
    [state.editor, state.mode, workspace.id, setPreviewTab, openTab]
  );

  // Handle file double-click - opens persistent tab (for browse mode)
  const handleFileDoubleClick = useCallback(
    (path: string) => {
      if (state.editor.isDirty) {
        setPendingTransition({
          kind: 'file',
          filePath: path,
          browseAction: state.mode === 'browse' ? 'persistent' : null,
        });
        setUnsavedConfirmOpen(true);
        return;
      }
      // Open as persistent tab in browse mode
      if (state.mode === 'browse') {
        openTab(workspace.id, path, false);
      }
      void state.editor.openFile(path);
    },
    [state.editor, state.mode, workspace.id, openTab]
  );

  const handleOpenInBrowserPreview = useCallback(
    (path: string) => {
      // The browser preview mode flip is folded into openInBrowse so it only
      // happens when the action actually proceeds. Setting it eagerly would
      // leak the browser-mode flag if the user cancels the discard prompt,
      // hiding the original dirty source buffer behind the iframe.
      handleModeChange('browse', undefined, { kind: 'browser-file', filePath: path });
    },
    [handleModeChange]
  );

  // Internal diff file selection (no dirty check)
  const selectDiffFile = useCallback(
    async (fileKey: string) => {
      state.editor.setIsDirty(false);
      await state.diff.selectFileByPath(fileKey);
    },
    [state.diff, state.editor]
  );

  // Handle diff file click (for diff mode) - checks for unsaved changes
  const handleDiffFileClick = useCallback(
    async (fileKey: string) => {
      if (state.editor.isDirty) {
        setPendingTransition({ kind: 'file', filePath: fileKey, browseAction: null });
        setUnsavedConfirmOpen(true);
        return;
      }
      await selectDiffFile(fileKey);
    },
    [state.editor.isDirty, selectDiffFile]
  );

  // Arrow-key navigation: update selection immediately, debounce the diff load
  // so holding ↓/↑ doesn't fire an IPC fetch for every file passed through.
  const handleDiffFileNavigate = useCallback(
    (fileKey: string) => {
      if (state.editor.isDirty) {
        setPendingTransition({ kind: 'file', filePath: fileKey, browseAction: null });
        setUnsavedConfirmOpen(true);
        return;
      }
      state.editor.setIsDirty(false);
      state.diff.selectFileByPathDeferred(fileKey);
    },
    [state.editor, state.diff]
  );

  // Handle sidebar file click - routes through dirty-aware handlers per mode.
  // Stable identity via ref pattern: useInitialFileTarget receives a closure
  // that re-derives on every render (state.mode, state.diff change), but its
  // useEffect re-runs deps include focusedPath which the parent realignment
  // bumps. Without ref-stabilization the effect re-runs after Cancel and
  // re-fires onFileSelect for the rejected target, spawning a second dialog.
  const handleSidebarFileClickImpl = useCallback(
    (path: string) => {
      if (state.mode === 'diff') {
        const file = state.diff.grouped.files.find((f) => f.path === path);
        if (!file) return;
        void handleDiffFileClick(path);
      } else {
        // Browse mode - open in editor
        handleFileSelect(path);
      }
    },
    [state.mode, state.diff, handleDiffFileClick, handleFileSelect]
  );
  const handleSidebarFileClickRef = useRef(handleSidebarFileClickImpl);
  handleSidebarFileClickRef.current = handleSidebarFileClickImpl;
  const handleSidebarFileClick = useCallback((path: string) => {
    handleSidebarFileClickRef.current(path);
  }, []);

  // Open initial file from picker or inline panel when dialog opens
  useInitialFileTarget({
    open,
    initialFilePath,
    initialLineNumber,
    mode: state.mode,
    editorFilePath: state.editor.filePath,
    workspaceId: workspace.id,
    jumpToLine,
    pendingLineJumpRef,
    openTab,
    openFile: state.editor.openFile,
    selectInDiff: (path) => handleSidebarFileClickRef.current(path),
  });

  // Restore active tab when reopening without an explicit initial file
  const hasRestoredActiveTab = useRef(false);
  useEffect(() => {
    if (!open) {
      hasRestoredActiveTab.current = false;
      return;
    }
    if (initialFilePath || hasRestoredActiveTab.current) return;
    if (state.mode !== 'browse') return;

    const tabToRestore = useFileViewerStore.getState().getActiveTab(workspace.id);
    if (tabToRestore && state.editor.filePath !== tabToRestore) {
      hasRestoredActiveTab.current = true;
      void state.editor.openFile(tabToRestore);
    }
  }, [open, initialFilePath, state.mode, state.editor, workspace.id]);

  // File operations
  const handleDeleteFile = useCallback((path: string, isDirectory = false) => {
    setFileToDelete({ path, isDirectory });
  }, []);

  const handleRestoreFile = useCallback((path: string, status: FileChange['status']) => {
    setFileToRestore({ path, status });
  }, []);

  const handleRollbackAll = useCallback(() => {
    setRollbackAllConfirmOpen(true);
  }, []);

  const handleShowFileHistory = useCallback(
    (filePath: string) => {
      // Stage filter setup behind handleModeChange so a cancelled dirty
      // prompt doesn't leave the history filter set on the next diff open.
      handleModeChange('diff', 'history', { kind: 'history-file', filePath });
    },
    [handleModeChange]
  );

  // Live follow: toggle handler
  const handleToggleLiveFollow = useCallback(() => {
    const store = useFileViewerStore.getState();
    const wasEnabled = !!store.liveFollowByWorkspace[workspace.id];
    store.toggleLiveFollow(workspace.id);

    // On enabling: navigate to the most-changed file
    if (!wasEnabled && state.diff.diffData?.files) {
      const files = state.diff.diffData.files.filter((f) => !f.isDirectory);
      if (files.length > 0) {
        const best = files.reduce((a, b) =>
          a.additions + a.deletions >= b.additions + b.deletions ? a : b
        );
        handleSidebarFileClick(best.path);
      }
    }
  }, [workspace.id, state.diff.diffData?.files, handleSidebarFileClick]);

  // Live follow: auto-navigate to the most-changed file on diff refresh

  const confirmRollbackAll = useCallback(async () => {
    setRollbackAllConfirmOpen(false);
    try {
      const result = await window.api.discardWorkspaceChanges(workspace.id);
      if (result.success) {
        useToastStore.getState().addToast('Rolled back all changes', 'success');
        const store = useFileListStore.getState();
        if (!isRemoteWorkspace) {
          store.fetchFileList(workspace.workingDirectory).catch(() => {});
          store.fetchFileStatuses(workspace.workingDirectory).catch(() => {});
        }
        void state.diff.refresh();
        state.editor.reset();
      } else {
        useToastStore.getState().addToast(`Failed to rollback: ${result.message}`, 'error');
      }
    } catch (err) {
      useToastStore
        .getState()
        .addToast(
          `Failed to rollback: ${err instanceof Error ? err.message : 'Unknown error'}`,
          'error'
        );
    }
  }, [isRemoteWorkspace, workspace.id, workspace.workingDirectory, state.diff, state.editor]);

  const _handleDiffDeleteFile = useCallback((file: FileChange) => {
    setFileToDelete({ path: file.path, isDirectory: !!file.isDirectory });
  }, []);

  const _handleDiffRestoreFile = useCallback((file: FileChange) => {
    setFileToRestore({ path: file.path, status: file.status });
  }, []);

  const confirmDeleteFile = useCallback(async () => {
    if (!fileToDelete) return;
    const { path } = fileToDelete;
    setFileToDelete(null);
    try {
      if (isRemoteWorkspace) {
        await window.api.deleteWorkspacePath(workspace.id, path);
      } else {
        await window.api.deleteFile(workspace.workingDirectory, path, 'modified');
      }
      useToastStore.getState().addToast(`Deleted ${path}`, 'success');
      const store = useFileListStore.getState();
      store.evictPath(workspace.workingDirectory, path);
      const editorWasDeleted = shouldNavigateAfterDeletion(
        () => {
          const { fileViewerMode, fileViewerWorkspaceId } = useFileViewerStore.getState();
          return { mode: fileViewerMode, workspaceId: fileViewerWorkspaceId };
        },
        workspace.id,
        browseFilePathRef.current,
        path
      );
      const nextActivePath = useFileViewerStore
        .getState()
        .removeDeletedPathFromViewers(workspace.id, path);
      if (editorWasDeleted) {
        if (nextActivePath) {
          void state.editor.openFile(nextActivePath);
        } else {
          state.editor.reset();
          onOpenChange(false);
        }
      }
    } catch (err) {
      useToastStore
        .getState()
        .addToast(
          `Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`,
          'error'
        );
    } finally {
      const store = useFileListStore.getState();
      const includeGitIgnored =
        !!useFileViewerStore.getState().showGitIgnoredByWorkspace[workspace.id];
      store
        .fetchFileList(
          workspace.workingDirectory,
          includeGitIgnored,
          isRemoteWorkspace ? workspace.id : undefined
        )
        .catch(() => {});
      if (!isRemoteWorkspace) {
        store.fetchFileStatuses(workspace.workingDirectory).catch(() => {});
      }
      void state.diff.refresh();
    }
  }, [
    fileToDelete,
    isRemoteWorkspace,
    workspace.id,
    workspace.workingDirectory,
    state.diff,
    state.editor,
    onOpenChange,
  ]);

  const confirmRestoreFile = useCallback(async () => {
    if (!fileToRestore) return;
    const { path, status } = fileToRestore;
    setFileToRestore(null);
    try {
      const oldPath = findRenameSource(workspace.workingDirectory, path, workspace.id);
      await window.api.restoreWorkspaceFile(workspace.id, path, status, oldPath);
      const label =
        status === 'deleted'
          ? 'Restored'
          : status === 'untracked' || status === 'added'
            ? 'Removed'
            : 'Rolled back';
      useToastStore.getState().addToast(`${label} ${path}`, 'success');
      const store = useFileListStore.getState();
      if (!isRemoteWorkspace) {
        store.fetchFileList(workspace.workingDirectory).catch(() => {});
        store.fetchFileStatuses(workspace.workingDirectory).catch(() => {});
      }
      void state.diff.refresh();
      if (state.editor.filePath === path) {
        state.editor.reset();
      }
    } catch (err) {
      useToastStore
        .getState()
        .addToast(
          `Failed to rollback: ${err instanceof Error ? err.message : 'Unknown error'}`,
          'error'
        );
    }
  }, [
    fileToRestore,
    isRemoteWorkspace,
    workspace.id,
    workspace.workingDirectory,
    state.diff,
    state.editor,
  ]);

  // Copy/paste handlers. The OS clipboard gets the absolute path so pasting
  // in a terminal or text editor gives you the filesystem location; in-tree
  // Paste below still reads from the in-app state because the OS clipboard
  // can't round-trip the cut-vs-copy distinction.
  const handleCopyNode = useCallback(
    (path: string, isDirectory: boolean) => {
      setCopiedPath(path);
      setCopiedIsDirectory(isDirectory);
      setIsCut(false);
      window.api.copyToClipboard(joinAbsPath(workspace.workingDirectory, path));
      const name = path.split('/').pop() || path;
      useToastStore.getState().addToast(`Copied ${name}`, 'success');
    },
    [workspace.workingDirectory]
  );

  const handleCutNode = useCallback(
    (path: string, isDirectory: boolean) => {
      setCopiedPath(path);
      setCopiedIsDirectory(isDirectory);
      setIsCut(true);
      window.api.copyToClipboard(joinAbsPath(workspace.workingDirectory, path));
      const name = path.split('/').pop() || path;
      useToastStore.getState().addToast(`Cut ${name}`, 'success');
    },
    [workspace.workingDirectory]
  );

  const handlePasteInto = useCallback(
    async (targetDir: string) => {
      if (!copiedPath) return;
      const name = copiedPath.split('/').pop() || copiedPath;
      const destPath = targetDir ? `${targetDir}/${name}` : name;
      // Moving a node onto itself would "overwrite" it and then trash the original.
      if (isCut && destPath === copiedPath) return;

      try {
        const exists = await window.api.fileExists(workspace.workingDirectory, destPath);
        if (exists) {
          setOverwriteTarget({ src: copiedPath, dest: destPath, isDirectory: copiedIsDirectory });
          return;
        }
        await pasteFileTreeNode(workspace.workingDirectory, {
          src: copiedPath,
          dest: destPath,
          isDirectory: copiedIsDirectory,
          isCut,
          overwrite: false,
        });
        if (isCut) {
          setCopiedPath(null);
          setIsCut(false);
        }
        useToastStore.getState().addToast(`${isCut ? 'Moved' : 'Pasted'} ${name}`, 'success');
        const store = useFileListStore.getState();
        store.fetchFileList(workspace.workingDirectory).catch(() => {});
        store.fetchFileStatuses(workspace.workingDirectory).catch(() => {});
      } catch (err) {
        useToastStore
          .getState()
          .addToast(
            `Failed to paste: ${err instanceof Error ? err.message : 'Unknown error'}`,
            'error'
          );
      }
    },
    [copiedPath, copiedIsDirectory, isCut, workspace.workingDirectory]
  );

  const confirmOverwrite = useCallback(async () => {
    if (!overwriteTarget) return;
    const { src, dest, isDirectory } = overwriteTarget;
    setOverwriteTarget(null);
    try {
      await pasteFileTreeNode(workspace.workingDirectory, {
        src,
        dest,
        isDirectory,
        isCut,
        overwrite: true,
      });
      if (isCut) {
        setCopiedPath(null);
        setIsCut(false);
      }
      const name = src.split('/').pop() || src;
      useToastStore
        .getState()
        .addToast(`${isCut ? 'Moved' : 'Pasted'} ${name} (overwritten)`, 'success');
      const store = useFileListStore.getState();
      store.fetchFileList(workspace.workingDirectory).catch(() => {});
      store.fetchFileStatuses(workspace.workingDirectory).catch(() => {});
    } catch (err) {
      useToastStore
        .getState()
        .addToast(
          `Failed to paste: ${err instanceof Error ? err.message : 'Unknown error'}`,
          'error'
        );
    }
  }, [overwriteTarget, isCut, workspace.workingDirectory]);

  // After tree moves or their undo: re-list the tree, refresh the diff, and
  // follow the moved paths in the tabs, the open file and the file panes. None
  // of them has unsaved edits, since those block the move.
  const treeMoveOptions = useMemo(
    () => ({
      getUnsavedPaths: () => {
        const paths = getUnsavedFilePanePaths(workspace.id);
        return unsavedFilePathRef.current ? [unsavedFilePathRef.current, ...paths] : paths;
      },
      onMoved: async (moves: FileTreeMove[]) => {
        const store = useFileListStore.getState();
        const listed = Promise.all([
          store.fetchFileList(workspace.workingDirectory).catch(() => {}),
          store.fetchFileStatuses(workspace.workingDirectory).catch(() => {}),
        ]);
        void state.diff.refresh();
        const viewer = useFileViewerStore.getState();
        for (const move of moves) {
          viewer.renamePathInViewers(workspace.id, move);
          followMovedFilePanes(workspace.id, move);
        }
        const openPath = browseFilePathRef.current;
        const followed =
          openPath && moves.reduce((path, move) => pathAfterMove(path, move) ?? path, openPath);
        if (followed && followed !== openPath) void state.editor.openFile(followed);
        await listed;
      },
    }),
    [workspace.workingDirectory, workspace.id, state.diff, state.editor]
  );

  const handleRenameComplete = useCallback(
    (sourcePath: string, destinationPath: string, _isFolder: boolean) =>
      renameFileTreePath(
        workspace.workingDirectory,
        { from: sourcePath, to: destinationPath },
        treeMoveOptions
      ),
    [workspace.workingDirectory, treeMoveOptions]
  );

  // Create file/folder handlers
  const handleCreateFile = useCallback((parentDir: string) => {
    setCreateTarget({ parentDir, type: 'file' });
    setCreateValue('');
  }, []);

  const handleCreateDirectory = useCallback((parentDir: string) => {
    setCreateTarget({ parentDir, type: 'directory' });
    setCreateValue('');
  }, []);

  const confirmCreate = useCallback(async () => {
    if (!createTarget || !createValue.trim()) return;
    const { parentDir, type } = createTarget;
    const name = createValue.trim();
    const newPath = parentDir ? `${parentDir}/${name}` : name;

    setCreateTarget(null);
    try {
      const exists = await window.api.fileExists(workspace.workingDirectory, newPath);
      if (exists) {
        useToastStore.getState().addToast(`"${name}" already exists`, 'error');
        return;
      }
      if (type === 'file') {
        await window.api.writeFile(workspace.workingDirectory, newPath, '');
      } else {
        await window.api.createDirectory(workspace.workingDirectory, newPath);
        // Track user-created empty dir so it appears in the tree without a full directory scan
        useFileListStore.getState().addUserCreatedDir(workspace.workingDirectory, newPath);
      }
      useToastStore.getState().addToast(`Created ${name}`, 'success');
      const store = useFileListStore.getState();
      store.fetchFileList(workspace.workingDirectory).catch(() => {});
      store.fetchFileStatuses(workspace.workingDirectory).catch(() => {});
      if (type === 'file') {
        void state.editor.openFile(newPath);
      }
    } catch (err) {
      useToastStore
        .getState()
        .addToast(
          `Failed to create: ${err instanceof Error ? err.message : 'Unknown error'}`,
          'error'
        );
    }
  }, [createTarget, createValue, workspace.workingDirectory, state.editor]);

  // Move nodes (drag & drop)
  const handleMoveNodes = useCallback(
    (sourcePaths: string[], targetDir: string) =>
      moveFileTreePaths(workspace.workingDirectory, sourcePaths, targetDir, treeMoveOptions),
    [workspace.workingDirectory, treeMoveOptions]
  );

  // Add to .gitignore
  const handleAddToGitignore = useCallback(
    async (path: string, isDirectory: boolean) => {
      const pattern = isDirectory ? `${path}/` : path;
      try {
        let content = '';
        try {
          content = await window.api.readFile(workspace.workingDirectory, '.gitignore');
        } catch {
          // .gitignore doesn't exist yet
        }
        const lines = content.split('\n');
        if (lines.some((line) => line.trim() === pattern)) {
          useToastStore.getState().addToast(`"${pattern}" is already in .gitignore`, 'info');
          return;
        }
        const newContent =
          content.endsWith('\n') || content === ''
            ? `${content}${pattern}\n`
            : `${content}\n${pattern}\n`;
        await window.api.writeFile(workspace.workingDirectory, '.gitignore', newContent);
        useToastStore.getState().addToast(`Added "${pattern}" to .gitignore`, 'success');
        const store = useFileListStore.getState();
        store.fetchFileList(workspace.workingDirectory).catch(() => {});
        store.fetchFileStatuses(workspace.workingDirectory).catch(() => {});
      } catch (err) {
        useToastStore
          .getState()
          .addToast(
            `Failed to update .gitignore: ${err instanceof Error ? err.message : 'Unknown error'}`,
            'error'
          );
      }
    },
    [workspace.workingDirectory]
  );

  // Save file
  const saveFile = useCallback(async () => {
    const filePath =
      state.mode === 'diff'
        ? state.diff.selectedFile
          ? state.diff.selectedFile
          : null
        : state.editor.filePath;
    if (!filePath || !state.editor.isDirty) return;

    const readBuffer = () =>
      state.mode === 'browse'
        ? (markdownEditorRef.current?.getMarkdown() ??
          readMountedEditor(editorRef.current) ??
          // An HTML file's preview replaces its source editor; every edit made there is kept here.
          state.editor.fileContent ??
          undefined)
        : diffEditorRef.current?.getModifiedEditor().getValue();
    const content = readBuffer();

    if (content === undefined) return;

    try {
      if (isRemoteWorkspace) {
        await window.api.writeWorkspaceFile(workspace.id, filePath, content);
      } else {
        await window.api.writeFile(workspace.workingDirectory, filePath, content);
      }
      const fileName = filePath.split('/').pop() || filePath;
      useToastStore.getState().addToast(`Saved ${fileName}`, 'success');
      // Edits typed while the write was in flight are still unsaved.
      const latest = readBuffer();
      state.editor.setIsDirty(latest !== undefined && latest !== content);
      if (state.mode === 'diff') {
        // Update baseline so dirty detection stays correct. The file watcher
        // will mark the cache as stale and trigger a background re-fetch, but
        // the DiffEditor ignores prop changes after mount, so no flicker.
        diffBaselineRef.current = content;
      } else {
        state.editor.setDiskContent(content);
        state.editor.setMissingOnDisk(false);
      }
    } catch (err) {
      useToastStore
        .getState()
        .addToast(
          `Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`,
          'error'
        );
    }
  }, [
    isRemoteWorkspace,
    state.editor,
    state.diff.selectedFile,
    state.mode,
    workspace.id,
    workspace.workingDirectory,
  ]);

  saveFileRef.current = saveFile;

  // Keep a Monaco context key in sync with dirty state so the Save action is
  // only visible when there are unsaved changes.
  const isDirtyKeyRef = useRef<monacoEditor.IContextKey<boolean> | null>(null);
  const isDirtyKeyDiffRef = useRef<monacoEditor.IContextKey<boolean> | null>(null);

  useEffect(() => {
    isDirtyKeyRef.current?.set(state.editor.isDirty);
    isDirtyKeyDiffRef.current?.set(state.editor.isDirty);
  }, [state.editor.isDirty]);

  // Register "Save" context menu action on a Monaco code editor
  const registerSaveAction = useCallback(
    (editor: monacoEditor.IStandaloneCodeEditor, keyRef: typeof isDirtyKeyRef) => {
      const key = editor.createContextKey<boolean>('komla.isDirty', false);
      keyRef.current = key;
      editor.addAction({
        id: 'save-file',
        label: 'Save',
        contextMenuGroupId: '1_modification',
        contextMenuOrder: 1,
        precondition: 'komla.isDirty',
        keybindings: [],
        run: () => {
          void saveFileRef.current();
        },
      });
    },
    []
  );

  // Register "Copy @path" context menu action on a Monaco code editor
  const registerCopyAtPathAction = useCallback((editor: monacoEditor.IStandaloneCodeEditor) => {
    editor.addAction({
      id: 'copy-at-path',
      label: 'Copy @path',
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 3,
      keybindings: [COPY_AT_PATH_KEYBINDING],
      run: (ed) => {
        const filePath = currentFilePathRef.current;
        if (!filePath) return;
        const atPath = formatAtPathWithLine(filePath, ed);
        window.api.copyToClipboard(atPath);
        useToastStore.getState().addToast(`Copied ${atPath}`, 'success');
      },
    });
  }, []);

  // Register "Toggle unchanged lines" context menu action on a Monaco diff editor
  const registerToggleUnchangedAction = useCallback(
    (editor: monacoEditor.IStandaloneCodeEditor) => {
      editor.addAction({
        id: 'toggle-unchanged-lines',
        label: 'Toggle Unchanged Lines',
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.5,
        keybindings: [],
        run: () => {
          state.diff.setHideUnchangedRegions(!hideUnchangedRef.current);
        },
      });
    },
    [state.diff]
  );

  // Override Monaco's Cmd+Shift+E to dispatch our file.tree shortcut
  // Uses well-known Monaco enum values: KeyMod.CtrlCmd=2048, KeyMod.Shift=1024, KeyCode.KeyE=35
  const overrideFileTreeShortcut = useCallback((editor: monacoEditor.IStandaloneCodeEditor) => {
    editor.addAction({
      id: 'override-cmd-shift-e',
      label: 'Toggle File Tree',
      keybindings: [2048 | 1024 | 35],
      run: () => {
        executeShortcutAction('file.tree');
      },
    });
  }, []);

  const registerToggleBlameAction = useCallback(
    (editor: monacoEditor.IStandaloneCodeEditor) => {
      if (isRemoteWorkspace) return;
      editor.addAction({
        id: 'toggle-blame',
        label: 'Toggle Blame',
        contextMenuGroupId: 'z_blame',
        contextMenuOrder: 1,
        keybindings: [],
        run: () => {
          if (state.mode === 'diff') {
            const filePath = currentFilePathRef.current;
            if (!filePath) return;
            handleModeChange('browse', undefined, {
              kind: 'browse-file',
              filePath,
              enableBlame: true,
            });
            return;
          }
          blameToggleRef.current();
        },
      });
    },
    [handleModeChange, isRemoteWorkspace, state.mode]
  );

  const registerFileHistoryAction = useCallback(
    (editor: monacoEditor.IStandaloneCodeEditor) => {
      if (!isGitWorkspace) return;
      editor.addAction({
        id: 'show-file-history',
        label: 'File History',
        contextMenuGroupId: 'z_blame',
        contextMenuOrder: 2,
        keybindings: [],
        run: () => {
          const filePath = currentFilePathRef.current;
          if (filePath) handleShowFileHistory(filePath);
        },
      });
    },
    [isGitWorkspace, handleShowFileHistory]
  );

  const registerRollbackAction = useCallback(
    (editor: monacoEditor.IStandaloneCodeEditor) => {
      if (!isGitWorkspace) return;
      editor.addAction({
        id: 'rollback-file',
        label: 'Rollback',
        contextMenuGroupId: 'z_blame',
        contextMenuOrder: 3,
        keybindings: [],
        run: () => {
          const filePath = currentFilePathRef.current;
          if (!filePath) return;
          const statuses = useFileListStore.getState().getFileStatuses(workspace.workingDirectory);
          const status = statuses?.statuses.get(filePath);
          if (status) handleRestoreFile(filePath, status);
        },
      });
    },
    [isGitWorkspace, workspace.workingDirectory, handleRestoreFile]
  );

  const registerRevealInFinderAction = useCallback(
    (editor: monacoEditor.IStandaloneCodeEditor) => {
      if (isRemoteWorkspace) return;
      editor.addAction({
        id: 'reveal-in-finder',
        label: getRevealInFileManagerLabel(),
        contextMenuGroupId: 'z_blame',
        contextMenuOrder: 4,
        keybindings: [],
        run: () => {
          const filePath = currentFilePathRef.current;
          if (filePath) window.api.showItemInFolder(`${workspace.workingDirectory}/${filePath}`);
        },
      });
    },
    [isRemoteWorkspace, workspace.workingDirectory]
  );

  const registerAddToGitignoreAction = useCallback(
    (editor: monacoEditor.IStandaloneCodeEditor) => {
      if (!isGitWorkspace || isRemoteWorkspace) return;
      editor.addAction({
        id: 'add-to-gitignore',
        label: 'Add to .gitignore',
        contextMenuGroupId: 'z_blame',
        contextMenuOrder: 5,
        keybindings: [],
        run: () => {
          const filePath = currentFilePathRef.current;
          if (filePath) void handleAddToGitignore(filePath, false);
        },
      });
    },
    [isGitWorkspace, isRemoteWorkspace, handleAddToGitignore]
  );

  const handleMarkdownEditorMount = useCallback((handle: MarkdownEditorHandle | null) => {
    markdownEditorRef.current = handle;
    if (handle && pendingLineJumpRef.current) {
      handle.revealLine(pendingLineJumpRef.current);
      pendingLineJumpRef.current = null;
    }
  }, []);

  // Editor mount handlers
  const handleEditorMount = useCallback(
    (editor: monacoEditor.IStandaloneCodeEditor) => {
      editorRef.current = editor;
      removeNonFunctionalActions(editor);
      registerSaveAction(editor, isDirtyKeyRef);
      registerCopyAtPathAction(editor);

      registerToggleBlameAction(editor);
      registerFileHistoryAction(editor);
      registerRollbackAction(editor);
      registerRevealInFinderAction(editor);
      registerAddToGitignoreAction(editor);
      overrideFileTreeShortcut(editor);
      const pendingLineJump = pendingLineJumpRef.current;
      const hasLineJump = !!pendingLineJump;
      if (pendingLineJump) {
        jumpToLine(pendingLineJump);
      }

      // Restore saved view state (scroll position, cursor) for this file,
      // but only if there's no explicit line jump taking precedence.
      // Use browseFilePathRef (updated synchronously) since currentFilePathRef
      // is synced via a parent useEffect that hasn't run yet at child mount time.
      const filePath = browseFilePathRef.current;
      if (filePath && !hasLineJump) {
        const cached = editorViewStateCache.get(viewStateCacheKey(workspace.id, filePath));
        if (cached) {
          editor.restoreViewState(cached);
        }
      }
    },
    [
      registerSaveAction,
      registerCopyAtPathAction,

      registerToggleBlameAction,
      registerFileHistoryAction,
      registerRollbackAction,
      registerRevealInFinderAction,
      registerAddToGitignoreAction,
      overrideFileTreeShortcut,
      jumpToLine,
      workspace.id,
    ]
  );

  const registerGitEditorActions = useCallback(
    (editor: monacoEditor.IStandaloneCodeEditor) => {
      registerFileHistoryAction(editor);
      registerRollbackAction(editor);
      registerRevealInFinderAction(editor);
      registerAddToGitignoreAction(editor);
    },
    [
      registerFileHistoryAction,
      registerRollbackAction,
      registerRevealInFinderAction,
      registerAddToGitignoreAction,
    ]
  );

  const handleDiffEditorMount = useCallback(
    (editor: monacoEditor.IStandaloneDiffEditor) => {
      diffEditorRef.current = editor;
      removeNonFunctionalActions(editor.getModifiedEditor());
      removeNonFunctionalActions(editor.getOriginalEditor());
      registerSaveAction(editor.getModifiedEditor(), isDirtyKeyDiffRef);
      registerCopyAtPathAction(editor.getModifiedEditor());
      registerCopyAtPathAction(editor.getOriginalEditor());

      registerToggleUnchangedAction(editor.getModifiedEditor());
      registerToggleUnchangedAction(editor.getOriginalEditor());
      registerToggleBlameAction(editor.getModifiedEditor());
      registerToggleBlameAction(editor.getOriginalEditor());
      registerGitEditorActions(editor.getModifiedEditor());
      registerGitEditorActions(editor.getOriginalEditor());
      overrideFileTreeShortcut(editor.getModifiedEditor());
      overrideFileTreeShortcut(editor.getOriginalEditor());

      // Track edits in the modified (right-side) editor to set dirty state
      const modifiedEditor = editor.getModifiedEditor();
      // Set baseline from actual editor content on mount (before listener is active)
      diffBaselineRef.current = modifiedEditor.getValue();
      modifiedEditor.onDidChangeModelContent(() => {
        const currentContent = modifiedEditor.getValue();
        const isDirty = currentContent !== diffBaselineRef.current;
        state.editor.setIsDirty(isDirty);
      });

      // Update change count and handle pending navigation
      const updateChanges = () => {
        const changes = editor.getLineChanges();
        const count = changes?.length ?? 0;
        setTotalChanges(count);

        const target = pendingChangeTargetRef.current;
        if (target && changes && changes.length > 0) {
          pendingChangeTargetRef.current = null;
          const idx = target === 'first' ? 0 : changes.length - 1;
          setCurrentChangeIndex(idx);
          const change = changes[idx];
          const line = change.modifiedStartLineNumber;
          modifiedEditor.revealLineInCenter(line);
          modifiedEditor.setPosition({ lineNumber: line, column: 1 });
        }
      };

      editor.onDidUpdateDiff(updateChanges);
      updateChanges();
    },
    [
      registerSaveAction,
      registerCopyAtPathAction,

      registerToggleUnchangedAction,
      registerToggleBlameAction,
      registerGitEditorActions,
      overrideFileTreeShortcut,
      state.editor,
    ]
  );

  // Change navigation
  const navigateToChange = useCallback((index: number) => {
    const editor = diffEditorRef.current;
    if (!editor) return;
    const changes = editor.getLineChanges();
    if (!changes || index < 0 || index >= changes.length) return;
    setCurrentChangeIndex(index);
    const change = changes[index];
    const line = change.modifiedStartLineNumber;
    const modifiedEditor = editor.getModifiedEditor();
    modifiedEditor.revealLineInCenter(line);
    modifiedEditor.setPosition({ lineNumber: line, column: 1 });
  }, []);

  const advanceToAdjacentFile = useCallback(
    (direction: 'next' | 'prev') => {
      if (state.mode !== 'diff') return;
      const subMode = useFileViewerStore.getState().fileViewerDiffSubMode;
      const pendingTarget = direction === 'next' ? 'first' : 'last';

      const pickAdjacent = (paths: string[], current: string | null | undefined) => {
        if (paths.length === 0) return null;
        const curIdx = current ? paths.indexOf(current) : -1;
        if (direction === 'next') {
          return paths[curIdx < paths.length - 1 ? curIdx + 1 : 0];
        }
        return paths[curIdx > 0 ? curIdx - 1 : paths.length - 1];
      };

      if (subMode === 'history') {
        const files = state.diff.commitDiff?.files;
        if (!files) return;
        const target = pickAdjacent(
          files.map((f) => f.path),
          state.diff.historySelectedFile
        );
        if (target === null) return;
        pendingChangeTargetRef.current = pendingTarget;
        setCurrentChangeIndex(-1);
        void state.diff.selectHistoryFile(target);
      } else {
        const target = pickAdjacent(getFlatFileKeys(state.diff.grouped), state.diff.selectedFile);
        if (target === null) return;
        pendingChangeTargetRef.current = pendingTarget;
        setCurrentChangeIndex(-1);
        void handleDiffFileClick(target);
      }
    },
    [state.mode, state.diff, handleDiffFileClick]
  );

  const goToNextChange = useCallback(() => {
    const editor = diffEditorRef.current;
    const changes = editor?.getLineChanges();
    const count = changes?.length ?? 0;

    if (count > 0 && currentChangeIndex < count - 1) {
      navigateToChange(currentChangeIndex + 1);
    } else {
      advanceToAdjacentFile('next');
    }
  }, [currentChangeIndex, navigateToChange, advanceToAdjacentFile]);

  const goToPreviousChange = useCallback(() => {
    const editor = diffEditorRef.current;
    const changes = editor?.getLineChanges();
    const count = changes?.length ?? 0;

    if (count > 0 && currentChangeIndex > 0) {
      navigateToChange(currentChangeIndex - 1);
    } else {
      advanceToAdjacentFile('prev');
    }
  }, [currentChangeIndex, navigateToChange, advanceToAdjacentFile]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return;

    const handler = (e: KeyboardEvent) => {
      dispatchFileViewerKeydown(e, {
        mode: state.mode,
        diffSubMode,
        isGitWorkspace,
        editorFilePath: state.editor.filePath,
        diffSelectedFile: state.diff.selectedFile,
        diffGrouped: state.diff.grouped,
        historyFilePaths: state.diff.commitDiff?.files.map((f) => f.path) ?? [],
        historySelectedFile: state.diff.historySelectedFile,
        currentFilePathRef,
        monacoEditorRef: editorRef,
        diffEditorRef,
        closeTabRef: handleCloseTabRef,
        closeViewer: () => closeViewerRef.current(),
        saveFile,
        setSidebarOpen,
        handleModeChange,
        goToNextChange,
        goToPreviousChange,
        handleDiffFileNavigate,
        setFileToDelete: handleDeleteFile,
        setDiffViewMode: state.diff.setViewMode,
        handleHistoryFileNavigate: (path) => void state.diff.selectHistoryFile(path),
        setHistoryViewMode: state.diff.setHistoryViewMode,
        copyToClipboard: window.api.copyToClipboard,
        showToast: (message, variant) => useToastStore.getState().addToast(message, variant),
        getSelection: () => window.getSelection()?.toString() ?? '',
        getActiveElement: () => document.activeElement,
      });
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    open,
    state,
    diffSubMode,
    saveFile,
    goToNextChange,
    goToPreviousChange,
    handleDiffFileNavigate,
    handleDeleteFile,
    isGitWorkspace,
    handleModeChange,
  ]);

  // Reset change index when file changes
  useEffect(() => {
    if (!pendingChangeTargetRef.current) {
      setCurrentChangeIndex(-1);
      setTotalChanges(0);
    }
  }, [state.diff.selectedFile]);

  // Auto-refresh on file watcher events with smart conflict detection
  useFileWatcherSync({
    open,
    workspaceId: workspace.id,
    workingDirectory: workspace.workingDirectory,
    isRemoteWorkspace,
    diff: state.diff,
    editor: state.editor,
  });

  // Live follow: auto-navigate to the most-changed file on diff refresh
  useLiveFollow({
    liveFollow,
    diffFiles: state.diff.diffData?.files,
    hasFullDiff: state.diff.hasFullDiff,
    onSelectMostChanged: (path) => handleSidebarFileClickRef.current(path),
  });

  // Handle dialog close with unsaved check
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        // Save editor scroll/cursor state before closing
        saveEditorViewState();

        // Check for unsaved changes - compare actual content to baseline for diff mode
        let hasUnsavedChanges = state.editor.isDirty;
        if (state.mode === 'diff' && diffEditorRef.current && diffBaselineRef.current !== null) {
          const currentContent = diffEditorRef.current.getModifiedEditor().getValue();
          hasUnsavedChanges = currentContent !== diffBaselineRef.current;
        }

        if (hasUnsavedChanges) {
          setPendingTransition({ kind: 'close' });
          setUnsavedConfirmOpen(true);
          return;
        }
        state.editor.reset();
      }
      onOpenChange(nextOpen);
    },
    [state.editor, state.mode, onOpenChange, saveEditorViewState]
  );

  useEffect(() => {
    closeViewerRef.current = () => handleOpenChange(false);
  }, [handleOpenChange]);

  useCloseViewerRequest({ open, handleOpenChange });

  const requestedTransition = useFileViewerStore((s) => s.pendingFileViewerTransition);
  useEffect(() => {
    if (!open || !requestedTransition || requestedTransition.workspaceId !== workspace.id) return;
    useFileViewerStore.getState().clearPendingFileViewerTransition();

    if (requestedTransition.kind === 'mode') {
      handleModeChange(
        requestedTransition.mode,
        requestedTransition.diffSubMode,
        requestedTransition.after
      );
      return;
    }
    if (requestedTransition.kind === 'close') {
      handleOpenChange(false);
      return;
    }
    if (requestedTransition.kind === 'inline-preview') {
      const transition: FileViewerTransition = requestedTransition;
      const decision = decideFileViewerTransition(transition, {
        dirty: state.editor.isDirty,
        mode: state.mode,
        diffSubMode,
        currentFilePath: state.editor.filePath,
      });
      if (decision.kind === 'confirm') {
        setPendingTransition(transition);
        setUnsavedConfirmOpen(true);
        return;
      }
      state.editor.reset();
      const store = useFileViewerStore.getState();
      store.closeFileViewer();
      store.openInlineFilePreview(
        workspace.id,
        'browse',
        requestedTransition.filePath,
        requestedTransition.lineNumber
      );
      return;
    }
    if (requestedTransition.lineNumber) {
      pendingLineJumpRef.current = requestedTransition.lineNumber;
    }
    if (state.mode === 'browse') {
      handleFileSelect(requestedTransition.filePath);
    } else {
      handleModeChange('browse', undefined, {
        kind: 'browse-file',
        filePath: requestedTransition.filePath,
        lineNumber: requestedTransition.lineNumber,
      });
    }
  }, [
    requestedTransition,
    open,
    workspace.id,
    state.editor,
    state.mode,
    diffSubMode,
    handleModeChange,
    handleOpenChange,
    handleFileSelect,
  ]);

  const applyConfirmedFileTransition = useCallback(
    (transition: Extract<FileViewerTransition, { kind: 'file' }>) => {
      if (state.mode === 'diff') {
        void selectDiffFile(transition.filePath);
        return;
      }
      if (transition.browseAction === 'close-tab') {
        handleCloseTabRef.current(transition.filePath, { skipDirtyCheck: true });
        return;
      }
      if (transition.browseAction === 'persistent') {
        openTab(workspace.id, transition.filePath, false);
      } else {
        setPreviewTab(workspace.id, transition.filePath);
      }
      if (transition.lineNumber) pendingLineJumpRef.current = transition.lineNumber;
      void state.editor.openFile(transition.filePath);
    },
    [state.mode, state.editor, selectDiffFile, openTab, setPreviewTab, workspace.id]
  );

  const confirmDiscard = useCallback(() => {
    setUnsavedConfirmOpen(false);
    clearPendingTransition();
    state.editor.setIsDirty(false);

    if (!pendingTransition) return;
    if (pendingTransition.kind === 'inline-preview') {
      state.editor.reset();
      const store = useFileViewerStore.getState();
      store.closeFileViewer();
      store.openInlineFilePreview(
        workspace.id,
        'browse',
        pendingTransition.filePath,
        pendingTransition.lineNumber
      );
      return;
    }
    if (pendingTransition.kind === 'mode') {
      if (state.mode !== pendingTransition.mode) {
        state.setMode(pendingTransition.mode);
        useFileViewerStore.getState().setFileViewerMode(pendingTransition.mode);
      }
      if (pendingTransition.diffSubMode) setDiffSubMode(pendingTransition.diffSubMode);
      applyModeTransitionAfter(pendingTransition.after);
      return;
    }
    if (pendingTransition.kind === 'file') {
      applyConfirmedFileTransition(pendingTransition);
      return;
    }
    state.editor.reset();
    onOpenChange(false);
  }, [
    onOpenChange,
    state,
    pendingTransition,
    workspace.id,
    setDiffSubMode,
    clearPendingTransition,
    applyModeTransitionAfter,
    applyConfirmedFileTransition,
  ]);

  const handleEditorChange = useCallback(
    (content: string) => {
      state.editor.setFileContent(content);
      const previewPath = useFileViewerStore.getState().getPreviewTab(workspace.id);
      const { isDirty, promotePreview } = computeEditorChangeEffects({
        content,
        diskContent: state.editor.diskContent,
        mode: state.mode,
        filePath: state.editor.filePath,
        previewPath,
      });
      state.editor.setIsDirty(isDirty);
      if (promotePreview && state.editor.filePath) {
        openTab(workspace.id, state.editor.filePath, false);
      }
    },
    [state.editor, state.mode, workspace.id, openTab]
  );

  // Conflict resolution handlers
  const handleKeepMyChanges = useCallback(() => {
    setConflictDialogOpen(false);
    state.editor.setExternalChange(false);
    // Keep editing - local changes preserved
  }, [state.editor]);

  const handleReloadFromDisk = useCallback(() => {
    setConflictDialogOpen(false);
    void state.editor.reloadFromDisk();
  }, [state.editor]);

  const cancelUnsaved = useCallback(() => {
    setUnsavedConfirmOpen(false);
    clearPendingTransition();
    bumpFocusAlignment();
  }, [clearPendingTransition, bumpFocusAlignment]);

  const sidebarCurrentFile = resolveCurrentFile(
    state.mode,
    state.diff.selectedFile,
    state.editor.filePath
  );

  return (
    <>
      <Dialog open={open} modal={false}>
        {/* The whole window, title bar included: the toolbar is the top row. */}
        <DialogContent
          className="top-0 left-0 flex h-screen max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none"
          floating={false}
          style={
            projectColorOklch
              ? ({ '--primary': projectColorOklch } as React.CSSProperties)
              : undefined
          }
          showCloseButton={false}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            // This runs before the editor sees the key. Escape aimed at the editor closes the
            // viewer from the window keydown handler, once the find bar, suggestions and vim
            // have had their turn.
            if (isEditorEscapeTarget(e.target)) return;
            handleOpenChange(false);
          }}
          onPointerDownOutside={(e) => {
            // Fullscreen viewers close explicitly (Close/Escape), never from menu interactions.
            e.preventDefault();
          }}
          onFocusOutside={(e) => {
            // Prevent closing when focus moves to portaled content (nested dialogs)
            e.preventDefault();
          }}
        >
          {/* Hidden for accessibility */}
          <DialogHeader className="sr-only">
            <DialogTitle>{workspace.name}</DialogTitle>
            <DialogDescription>File viewer</DialogDescription>
          </DialogHeader>

          <FileViewerMainPane
            workspace={workspace}
            isGitWorkspace={isGitWorkspace}
            isRemoteWorkspace={isRemoteWorkspace}
            state={state}
            blame={blame}
            diffSubMode={diffSubMode}
            sidebarOpen={sidebarOpen}
            sidebarWidth={sidebarWidth}
            isResizingSidebar={isResizingSidebar}
            onResizeStart={handleSidebarResizeStart}
            setSidebarOpen={setSidebarOpen}
            sidebarCurrentFile={sidebarCurrentFile}
            focusAlignmentSignal={focusAlignmentSignal}
            onExitHistory={() => {
              handleModeChange('diff', 'changes', { kind: 'history-file', filePath: null });
            }}
            changedFiles={changedFiles}
            diffFileStatuses={diffFileStatuses}
            liveFollow={liveFollow}
            copiedPath={copiedPath}
            targetBranch={targetBranch}
            handleSidebarFileClick={handleSidebarFileClick}
            handleFileDoubleClick={handleFileDoubleClick}
            handleDeleteFile={handleDeleteFile}
            handleRestoreFile={handleRestoreFile}
            handleRenameComplete={handleRenameComplete}
            handleCreateFile={handleCreateFile}
            handleCreateDirectory={handleCreateDirectory}
            handleMoveNodes={handleMoveNodes}
            handleAddToGitignore={handleAddToGitignore}
            handleRollbackAll={handleRollbackAll}
            handleCopyNode={handleCopyNode}
            handleCutNode={handleCutNode}
            handlePasteInto={handlePasteInto}
            handleToggleLiveFollow={handleToggleLiveFollow}
            handleShowFileHistory={handleShowFileHistory}
            handleOpenInBrowserPreview={handleOpenInBrowserPreview}
            tabs={tabs}
            previewTab={previewTab}
            handleSwitchTab={handleSwitchTab}
            handleCloseTab={handleCloseTab}
            totalChanges={totalChanges}
            currentChangeIndex={currentChangeIndex}
            goToPreviousChange={goToPreviousChange}
            goToNextChange={goToNextChange}
            onClose={() => handleOpenChange(false)}
            isMonacoReady={isMonacoReady}
            monacoLoadError={monacoLoadError}
            handleEditorChange={handleEditorChange}
            handleEditorMount={handleEditorMount}
            handleMarkdownEditorMount={handleMarkdownEditorMount}
            handleDiffEditorMount={handleDiffEditorMount}
            handleBlameHunkClick={handleBlameHunkClick}
          />
        </DialogContent>
      </Dialog>

      <FileViewerConfirmDialogs
        fileToDelete={fileToDelete}
        deletesPermanently={isRemoteWorkspace}
        onCancelDelete={() => setFileToDelete(null)}
        onConfirmDelete={confirmDeleteFile}
        createTarget={createTarget}
        createValue={createValue}
        onCreateValueChange={setCreateValue}
        onCancelCreate={() => setCreateTarget(null)}
        onConfirmCreate={() => void confirmCreate()}
        fileToRestore={fileToRestore}
        onCancelRestore={() => setFileToRestore(null)}
        onConfirmRestore={confirmRestoreFile}
        rollbackAllConfirmOpen={rollbackAllConfirmOpen}
        onCancelRollbackAll={() => setRollbackAllConfirmOpen(false)}
        onConfirmRollbackAll={confirmRollbackAll}
        unsavedConfirmOpen={unsavedConfirmOpen}
        pendingTransition={pendingTransition}
        onCancelUnsaved={cancelUnsaved}
        onConfirmDiscard={confirmDiscard}
        overwriteTarget={overwriteTarget}
        onCancelOverwrite={() => setOverwriteTarget(null)}
        onConfirmOverwrite={confirmOverwrite}
        conflictDialogOpen={conflictDialogOpen}
        conflictFilePath={state.editor.filePath}
        onKeepMyChanges={handleKeepMyChanges}
        onReloadFromDisk={handleReloadFromDisk}
      />
    </>
  );
}
