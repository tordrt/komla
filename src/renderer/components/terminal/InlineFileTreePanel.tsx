import { lazy, Suspense, useMemo, useEffect, useCallback, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useDiffComparison } from '@/hooks/useDiffComparison';
import { moveFileTreePaths, renameFileTreePath, type FileTreeMove } from '@/lib/file-tree-moves';
import { pasteFileTreeNode } from '@/lib/file-tree-paste';
import { joinAbsPath } from '@/lib/fs-path';
import {
  followMovedFilePanes,
  getUnsavedFilePanePaths,
  openFilePane,
  type PaneSurfacePlacement,
} from '@/lib/pane-surfaces';
import { useConfigStore } from '@/stores/config.store';
import { findRenameSource, useFileListStore } from '@/stores/file-list.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useGitStatusStore } from '@/stores/git-status.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { resolveWorkspaceTargetBranch, type FileChange } from '@/types';

import { getAncestorPaths } from '../workspaces/file-viewer/file-viewer-utils';
import { setHtmlViewMode } from '../workspaces/file-viewer/html-view-mode';

import { computeInitDefaults } from './inline-file-tree-defaults';
import { pickBestLiveFollowFile } from './live-follow-picker';
import { useConfirmDialog } from './useConfirmDialog';

// Lazy so the file tree library (@pierre/trees) stays out of the startup bundle.
const SidebarFileTree = lazy(() =>
  import('../workspaces/file-viewer/SidebarFileTree').then((module) => ({
    default: module.SidebarFileTree,
  }))
);

interface InlineFileTreePanelProps {
  workspaceId: string;
  workingDirectory: string;
  isGitWorkspace: boolean;
  isActive?: boolean;
}

export function InlineFileTreePanel({
  workspaceId,
  workingDirectory,
  isGitWorkspace,
  isActive = true,
}: InlineFileTreePanelProps) {
  const mode = useFileViewerStore((s) => s.inlineFileTreeByWorkspace[workspaceId]?.mode ?? 'diff');
  const effectiveMode = isGitWorkspace ? mode : 'browse';

  const { comparisonBranch, useMergeBase } = useDiffComparison(workspaceId, 'inline');

  // Resolve target branch name (same pattern as TargetBranchSelector)
  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const isRemoteWorkspace = workspace?.backend?.kind === 'ssh';
  const isReconnectingRemoteWorkspace = useWorkspacesStore((s) =>
    s.reconnectingSshWorkspaceIds.has(workspaceId)
  );
  const isDataActive = isActive && (!isRemoteWorkspace || !isReconnectingRemoteWorkspace);
  const gitStatus = useGitStatusStore((s) => s.getStatus(workspaceId));
  const project = useProjectsStore((s) =>
    workspace?.projectId ? s.projects.find((p) => p.id === workspace.projectId) : undefined
  );
  const resolvedTargetBranch = resolveWorkspaceTargetBranch(
    workspace,
    project?.baseBranch,
    gitStatus?.status?.mainBranch
  );
  const targetBranch = resolvedTargetBranch || 'main';

  const liveFollow = useFileViewerStore((s) => !!s.liveFollowByWorkspace[workspaceId]);

  const previewState = useFileViewerStore((s) => s.inlineFilePreviewByWorkspace[workspaceId]);
  const reveal = useFileViewerStore((s) => s.fileTreeRevealByWorkspace[workspaceId] ?? null);
  // Fall back to the full-screen viewer's active tab only while that viewer is
  // open for this workspace. The inline preview takes precedence as the
  // foreground UI when both are set.
  const viewerActiveTab = useFileViewerStore(
    (s) => s.fileViewerActiveTabByWorkspace[workspaceId] ?? null
  );
  const fileViewerWorkspaceId = useFileViewerStore((s) => s.fileViewerWorkspaceId);
  const currentFile =
    previewState?.open && previewState.filePath
      ? previewState.filePath
      : fileViewerWorkspaceId === workspaceId
        ? viewerActiveTab
        : null;

  // Pierre moves focus on mousedown, so a click that's then rejected by the
  // unsaved-changes dialog leaves the wrong row focused. Bump this signal
  // whenever a staged nav clears (Cancel or Discard) so the file tree
  // realigns its focus with currentFile.
  const pendingNav = useFileViewerStore(
    (s) => s.inlineFilePreviewPendingNavByWorkspace[workspaceId] ?? null
  );
  const [focusAlignmentSignal, setFocusAlignmentSignal] = useState(0);
  const prevPendingNavRef = useRef(pendingNav);
  useEffect(() => {
    if (prevPendingNavRef.current && !pendingNav) {
      setFocusAlignmentSignal((v) => v + 1);
    }
    prevPendingNavRef.current = pendingNav;
  }, [pendingNav]);

  // Track previous diff files for change detection in live follow mode
  const prevDiffFilesRef = useRef<FileChange[] | null>(null);

  // Initialize defaults from config once the workspace is active and branch data is ready.
  // Gated on isActive so hidden workspaces don't eagerly persist the 'main' fallback
  // before real git metadata arrives.
  const hasInitializedDefaults = useRef(false);
  useEffect(() => {
    if (hasInitializedDefaults.current) return;

    const config = useConfigStore.getState().config;
    const store = useFileViewerStore.getState();
    const result = computeInitDefaults({
      isActive: isDataActive,
      isGitWorkspace,
      workspaceId,
      resolvedTargetBranch,
      targetBranch,
      defaultLiveFollow: !!config?.defaultLiveFollow,
      defaultCompareTargetBranch: !!config?.defaultCompareTargetBranch,
      currentLiveFollow: store.liveFollowByWorkspace[workspaceId],
      currentComparisonBranch: store.inlineFileTreeByWorkspace[workspaceId]?.comparisonBranch,
    });

    if (result.setLiveFollow !== undefined) {
      store.setLiveFollow(workspaceId, result.setLiveFollow);
    }
    if (result.setComparisonBranch) {
      store.setInlineFileTreeComparisonBranch(
        workspaceId,
        result.setComparisonBranch.branch,
        result.setComparisonBranch.useMergeBase
      );
    }
    hasInitializedDefaults.current = result.initialized;
  }, [isDataActive, workspaceId, isGitWorkspace, targetBranch, resolvedTargetBranch]);

  const { getDiff, fetchDiffIfNeeded } = useFileListStore();
  const cached = getDiff(workingDirectory, comparisonBranch, useMergeBase, workspaceId);
  const diffData = cached?.data;
  const hasFullDiff = cached?.hasFullDiff ?? false;
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const comparisonLoadingRef = useRef(false);

  // Fetch diff data on mount and when working directory / comparison branch changes
  useEffect(() => {
    if (!isDataActive || !isGitWorkspace) return;
    void fetchDiffIfNeeded(workingDirectory, comparisonBranch, useMergeBase, workspaceId);
  }, [
    isDataActive,
    isGitWorkspace,
    workingDirectory,
    comparisonBranch,
    useMergeBase,
    workspaceId,
    fetchDiffIfNeeded,
  ]);

  // Auto-refresh on worktree changes
  const fetchDiffRef = useRef(useFileListStore.getState().fetchDiff);
  fetchDiffRef.current = useFileListStore.getState().fetchDiff;
  const fetchFileListRef = useRef(useFileListStore.getState().fetchFileList);
  fetchFileListRef.current = useFileListStore.getState().fetchFileList;
  const fetchFileStatusesRef = useRef(useFileListStore.getState().fetchFileStatuses);
  fetchFileStatusesRef.current = useFileListStore.getState().fetchFileStatuses;
  const comparisonBranchRef = useRef(comparisonBranch);
  comparisonBranchRef.current = comparisonBranch;
  const useMergeBaseRef = useRef(useMergeBase);
  useMergeBaseRef.current = useMergeBase;
  const applyPushedFileStatusRef = useRef(useFileListStore.getState().applyPushedFileStatus);
  applyPushedFileStatusRef.current = useFileListStore.getState().applyPushedFileStatus;
  useEffect(() => {
    if (!isDataActive) return;
    const unsubscribe = window.api.onWorktreeChanged(
      (changedWorkspaceId, _changeTypes, _activityAt, pushedFileStatus) => {
        if (changedWorkspaceId === workspaceId) {
          // Keep the browse tree fresh. SidebarFileTree re-lists a remote tree once
          // useWorktreeWatcher marks its list stale, which a report does when files come or go.
          if (!isRemoteWorkspace) {
            void fetchFileListRef.current(workingDirectory, false, workspaceId);
          }
          if (!isGitWorkspace) return;
          // Use pushed data if available, otherwise fetch via IPC
          if (pushedFileStatus) {
            applyPushedFileStatusRef.current(workingDirectory, pushedFileStatus, workspaceId);
          } else if (!isRemoteWorkspace) {
            void fetchFileStatusesRef.current(workingDirectory);
          }
          // Force re-fetch (preserves existing data during loading, unlike invalidateDiffs which clears it)
          void fetchDiffRef.current(
            workingDirectory,
            comparisonBranchRef.current,
            useMergeBaseRef.current,
            workspaceId
          );
        }
      }
    );
    return unsubscribe;
  }, [isDataActive, isGitWorkspace, isRemoteWorkspace, workspaceId, workingDirectory]);

  // Compute changed file items for diff mode tree (preserves isDirectory hint)
  const changedFiles = useMemo(() => {
    if (!diffData?.files) return [];
    return diffData.files.map((f) => ({ path: f.path, isDirectory: f.isDirectory }));
  }, [diffData?.files]);

  // Compute file statuses from diff data
  const diffFileStatuses = useMemo(() => {
    if (!diffData?.files) return undefined;
    const statuses = new Map<string, FileChange['status']>();
    for (const f of diffData.files) {
      statuses.set(f.path, f.status);
      for (const ancestor of getAncestorPaths(f.path)) {
        if (!statuses.has(ancestor)) {
          statuses.set(ancestor, 'modified');
        }
      }
    }
    return statuses;
  }, [diffData?.files]);

  const diffSummary = diffData?.summary;

  // Toggle live follow mode
  const handleToggleLiveFollow = useCallback(() => {
    const store = useFileViewerStore.getState();
    const wasEnabled = !!store.liveFollowByWorkspace[workspaceId];
    store.toggleLiveFollow(workspaceId);

    // On enabling: navigate to the most-changed file in diff mode. Route
    // through requestInlineFilePreviewNav so a dirty preview prompts before
    // being reloaded to a different file.
    if (!wasEnabled && diffData?.files) {
      const files = diffData.files.filter((f) => !f.isDirectory);
      if (files.length > 0) {
        // Pick the file with the most changes
        const best = files.reduce((a, b) =>
          a.additions + a.deletions >= b.additions + b.deletions ? a : b
        );
        store.requestInlineFilePreviewNav(workspaceId, 'diff', best.path);
      }
    }
  }, [workspaceId, diffData?.files]);

  // Live follow: auto-navigate to the most-changed file on diff refresh
  useEffect(() => {
    // Don't baseline from the loading placeholder (hasFullDiff is false while
    // fetchDiff is in-flight with a cold cache, which creates files: []).
    if (!liveFollow || !diffData?.files || !hasFullDiff) {
      if (hasFullDiff) {
        prevDiffFilesRef.current = diffData?.files ?? null;
      }
      return;
    }

    const prevFiles = prevDiffFilesRef.current;
    prevDiffFilesRef.current = diffData.files;

    const bestPath = pickBestLiveFollowFile(prevFiles, diffData.files);
    if (!bestPath) return;

    const store = useFileViewerStore.getState();
    const current = store.inlineFilePreviewByWorkspace[workspaceId];
    // Don't interrupt browse mode - only auto-navigate when already in diff mode or preview is closed
    if (current?.open && current.mode !== 'diff') return;

    // Route through requestInlineFilePreviewNav so a dirty preview prompts
    // before being reloaded to a different file.
    store.requestInlineFilePreviewNav(workspaceId, 'diff', bestPath);
    // Default to split view when live follow opens a new preview (not already open)
    if (!current?.open) {
      store.setInlineFilePreviewLayout(workspaceId, 'side-by-side');
    }
    // Switch the file tree tab to diff if it's currently in browse mode
    if (store.inlineFileTreeByWorkspace[workspaceId]?.mode !== 'diff') {
      store.setInlineFileTreeMode(workspaceId, 'diff');
    }
  }, [liveFollow, diffData?.files, hasFullDiff, workspaceId]);

  // The mode is read fresh from the store rather than closed over —
  // otherwise a mode switch rebuilds this callback, which re-runs the
  // focus-observing effect in SidebarFileTree (onFileSelect is a dep).
  // After a close that has cleared the preview's filePath, that re-run
  // sees focusedPath still on the closed file with lastOpenedRef=null,
  // fires onFileSelect, and re-opens the preview we just closed.
  const handleFileSelect = useCallback(
    (path: string) => {
      const store = useFileViewerStore.getState();
      const preview = store.inlineFilePreviewByWorkspace[workspaceId];

      // Re-clicking the currently open file toggles preview closed. Route
      // through requestInlineFilePreviewClose so dirty edits prompt the
      // unsaved-changes dialog instead of being silently discarded.
      if (preview?.open && preview.filePath === path) {
        store.requestInlineFilePreviewClose(workspaceId);
        return;
      }

      const currentMode = store.inlineFileTreeByWorkspace[workspaceId]?.mode ?? 'diff';
      const mode = isGitWorkspace ? currentMode : 'browse';
      // Routes through the store action which prompts for confirmation when
      // the current preview has unsaved changes — otherwise we'd flip
      // previewState.filePath to the rejected target and have to unwind it.
      store.requestInlineFilePreviewNav(workspaceId, mode, path);
    },
    [workspaceId, isGitWorkspace]
  );

  // Close the preview if we flip to browse mode while a git-deleted file is
  // open. Diff mode renders the deletion diff fine; browse mode would try to
  // read the missing file off disk and surface an ENOENT to the editor area.
  useEffect(() => {
    if (effectiveMode === 'diff') return;
    if (!currentFile) return;
    if (diffFileStatuses?.get(currentFile) !== 'deleted') return;
    useFileViewerStore.getState().closeInlineFilePreview(workspaceId);
  }, [effectiveMode, currentFile, diffFileStatuses, workspaceId]);

  const { confirm, confirmDialog } = useConfirmDialog();

  const handleRestoreFile = useCallback(
    async (path: string, status: FileChange['status']) => {
      const confirmed = await confirm(
        status === 'deleted'
          ? {
              title: 'Restore Deleted File',
              description: (
                <>
                  Are you sure you want to restore <strong>{path}</strong> to its last committed
                  state?
                </>
              ),
              confirmLabel: 'Restore',
            }
          : status === 'untracked' || status === 'added'
            ? {
                title: 'Remove New File',
                description: (
                  <>
                    Are you sure you want to remove <strong>{path}</strong>? This file will be
                    deleted.
                  </>
                ),
                confirmLabel: 'Remove',
              }
            : {
                title: 'Rollback Changes',
                description: (
                  <>
                    Are you sure you want to rollback all changes to <strong>{path}</strong>? This
                    will restore it to its last committed state.
                  </>
                ),
                confirmLabel: 'Rollback',
              }
      );
      if (!confirmed) return;

      const oldPath = findRenameSource(workingDirectory, path, workspaceId);
      try {
        if (isRemoteWorkspace) {
          await window.api.restoreWorkspaceFile(workspaceId, path, status, oldPath);
        } else {
          await window.api.restoreFile(workingDirectory, path, status, oldPath);
        }
        const successLabel =
          status === 'deleted'
            ? 'Restored'
            : status === 'untracked' || status === 'added'
              ? 'Removed'
              : 'Rolled back';
        useToastStore.getState().addToast(`${successLabel} ${path}`, 'success');

        const store = useFileListStore.getState();
        const refreshes: Promise<unknown>[] = [
          store.fetchDiff(workingDirectory, undefined, undefined, workspaceId),
          store.fetchFileList(workingDirectory, false, workspaceId),
        ];
        if (!isRemoteWorkspace) refreshes.push(store.fetchFileStatuses(workingDirectory));
        await Promise.all(refreshes);
      } catch (err) {
        useToastStore
          .getState()
          .addToast(
            `Failed to rollback: ${err instanceof Error ? err.message : 'Unknown error'}`,
            'error'
          );
      }
    },
    [workingDirectory, isRemoteWorkspace, workspaceId, confirm]
  );

  const handleRollbackAll = useCallback(async () => {
    const confirmed = await confirm({
      title: 'Rollback All Changes',
      description:
        'Are you sure you want to rollback all uncommitted changes? This will restore all modified files to their last committed state and remove untracked files.',
      confirmLabel: 'Rollback All',
    });
    if (!confirmed) return;

    try {
      const result = isRemoteWorkspace
        ? await window.api.discardWorkspaceChanges(workspaceId)
        : await window.api.discardAllChanges(workingDirectory);
      if (result.success) {
        useToastStore.getState().addToast('Rolled back all changes', 'success');
        const store = useFileListStore.getState();
        const refreshes: Promise<unknown>[] = [
          store.fetchDiff(workingDirectory, undefined, undefined, workspaceId),
          store.fetchFileList(workingDirectory, false, workspaceId),
        ];
        if (!isRemoteWorkspace) refreshes.push(store.fetchFileStatuses(workingDirectory));
        await Promise.all(refreshes);
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
  }, [workingDirectory, isRemoteWorkspace, workspaceId, confirm]);

  const refreshFileLists = useCallback(() => {
    const store = useFileListStore.getState();
    const includeGitIgnored =
      !!useFileViewerStore.getState().showGitIgnoredByWorkspace[workspaceId];
    store.fetchFileList(workingDirectory, includeGitIgnored, workspaceId).catch(() => {});
    if (!isRemoteWorkspace) {
      store.fetchFileStatuses(workingDirectory).catch(() => {});
    }
    if (isGitWorkspace) {
      store.fetchDiff(workingDirectory, undefined, undefined, workspaceId).catch(() => {});
    }
  }, [workingDirectory, isGitWorkspace, isRemoteWorkspace, workspaceId]);

  useEffect(() => {
    if (!isDataActive || !isRemoteWorkspace) return;
    useFileListStore
      .getState()
      .fetchFileList(workingDirectory, false, workspaceId)
      .catch(() => {});
  }, [isDataActive, isRemoteWorkspace, workingDirectory, workspaceId]);

  const handleDeleteFile = useCallback(
    async (path: string, isDirectory?: boolean) => {
      const confirmed = await confirm({
        title: isDirectory ? 'Delete Folder' : 'Delete',
        description: (
          <>
            {isDirectory ? (
              <>
                Are you sure you want to delete <strong>{path}</strong> and all of its contents?
              </>
            ) : (
              <>
                Are you sure you want to delete <strong>{path}</strong>?
              </>
            )}
            {isRemoteWorkspace && ' It is deleted permanently on the remote host.'}
          </>
        ),
        confirmLabel: 'Delete',
        // A local delete goes to the trash, so Enter may confirm it.
        focusConfirm: !isRemoteWorkspace,
      });
      if (!confirmed) return;
      try {
        if (isRemoteWorkspace) {
          await window.api.deleteWorkspacePath(workspaceId, path);
        } else {
          await window.api.deleteFile(workingDirectory, path, 'modified');
        }
        useToastStore.getState().addToast(`Deleted ${path}`, 'success');
        useFileListStore.getState().evictPath(workingDirectory, path);
        useFileViewerStore.getState().removeDeletedPathFromViewers(workspaceId, path);
      } catch (err) {
        useToastStore
          .getState()
          .addToast(
            `Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`,
            'error'
          );
      } finally {
        refreshFileLists();
      }
    },
    [workingDirectory, isRemoteWorkspace, workspaceId, refreshFileLists, confirm]
  );

  // Unsaved edits in the preview or a file pane would stay on the old path, so
  // tree moves leave those files alone. After the moves, or their undo, the
  // tabs, the preview and the file panes follow the moved paths.
  const treeMoveOptions = useMemo(
    () => ({
      getUnsavedPaths: () => {
        const preview = useFileViewerStore.getState().inlineFilePreviewByWorkspace[workspaceId];
        const paths = getUnsavedFilePanePaths(workspaceId);
        return preview?.open && preview.isDirty && preview.filePath
          ? [preview.filePath, ...paths]
          : paths;
      },
      onMoved: (moves: FileTreeMove[]) => {
        const viewer = useFileViewerStore.getState();
        for (const move of moves) {
          viewer.renamePathInViewers(workspaceId, move);
          followMovedFilePanes(workspaceId, move);
        }
        refreshFileLists();
      },
    }),
    [workspaceId, refreshFileLists]
  );

  const handleRenameComplete = useCallback(
    (sourcePath: string, destinationPath: string, _isFolder: boolean) =>
      renameFileTreePath(
        workingDirectory,
        { from: sourcePath, to: destinationPath },
        treeMoveOptions
      ),
    [workingDirectory, treeMoveOptions]
  );

  // Create file/folder state
  const [createTarget, setCreateTarget] = useState<{
    parentDir: string;
    type: 'file' | 'directory';
  } | null>(null);
  const [createValue, setCreateValue] = useState('');

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
      const exists = await window.api.fileExists(workingDirectory, newPath);
      if (exists) {
        useToastStore.getState().addToast(`"${name}" already exists`, 'error');
        return;
      }
      if (type === 'file') {
        await window.api.writeFile(workingDirectory, newPath, '');
      } else {
        await window.api.createDirectory(workingDirectory, newPath);
        // Track user-created empty dir so it appears in the tree without a full directory scan
        useFileListStore.getState().addUserCreatedDir(workingDirectory, newPath);
      }
      useToastStore.getState().addToast(`Created ${name}`, 'success');
      refreshFileLists();
    } catch (err) {
      useToastStore
        .getState()
        .addToast(
          `Failed to create: ${err instanceof Error ? err.message : 'Unknown error'}`,
          'error'
        );
    }
  }, [createTarget, createValue, workingDirectory, refreshFileLists]);

  const handleMoveNodes = useCallback(
    (sourcePaths: string[], targetDir: string) =>
      moveFileTreePaths(workingDirectory, sourcePaths, targetDir, treeMoveOptions),
    [workingDirectory, treeMoveOptions]
  );

  const handleAddToGitignore = useCallback(
    async (path: string, isDirectory: boolean) => {
      const pattern = isDirectory ? `${path}/` : path;
      try {
        let content = '';
        try {
          content = await window.api.readFile(workingDirectory, '.gitignore');
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
        await window.api.writeFile(workingDirectory, '.gitignore', newContent);
        useToastStore.getState().addToast(`Added "${pattern}" to .gitignore`, 'success');
        refreshFileLists();
      } catch (err) {
        useToastStore
          .getState()
          .addToast(
            `Failed to update .gitignore: ${err instanceof Error ? err.message : 'Unknown error'}`,
            'error'
          );
      }
    },
    [workingDirectory, refreshFileLists]
  );

  // Open file history in the file viewer dialog
  const handleShowFileHistory = useCallback(
    (filePath: string) => {
      useFileViewerStore.getState().requestFileViewerTransition({
        kind: 'mode',
        workspaceId,
        mode: 'diff',
        diffSubMode: 'history',
        after: { kind: 'history-file', filePath },
      });
    },
    [workspaceId]
  );

  const handleOpenInPane = useCallback(
    (path: string, placement: PaneSurfacePlacement) => {
      openFilePane(workspaceId, path, placement);
    },
    [workspaceId]
  );

  const handleOpenHtmlInBrowser = useCallback(
    (path: string) => {
      const store = useFileViewerStore.getState();
      const current = store.inlineFilePreviewByWorkspace[workspaceId];
      // Replicates the blocking check in requestInlineFilePreviewNav so we
      // know whether the nav will defer behind a discard prompt. If it will,
      // we must NOT flip the browser preview mode or tree mode up-front — cancelling
      // the prompt would leak both flips and hide the dirty source buffer
      // behind the iframe. Pass htmlPreviewIntent so confirmDiscard applies
      // the flips when the nav actually lands.
      const blockingDirty =
        !!current?.open &&
        !!current.isDirty &&
        (current.filePath !== path || current.mode !== 'browse');

      if (blockingDirty) {
        store.requestInlineFilePreviewNav(workspaceId, 'browse', path, undefined, {
          htmlPreviewIntent: true,
        });
        return;
      }

      setHtmlViewMode(workingDirectory, 'browser');
      if (store.inlineFileTreeByWorkspace[workspaceId]?.mode !== 'browse') {
        store.setInlineFileTreeMode(workspaceId, 'browse');
      }
      store.requestInlineFilePreviewNav(workspaceId, 'browse', path);
    },
    [workspaceId, workingDirectory]
  );

  // Toggle branch comparison mode (merge-base: shows only this branch's changes)
  const handleToggleBranchComparison = useCallback(async () => {
    if (comparisonLoadingRef.current) return;

    const store = useFileViewerStore.getState();
    const state = store.inlineFileTreeByWorkspace[workspaceId];
    const fileListStore = useFileListStore.getState();
    const showUncommittedChanges = !!state?.comparisonBranch && !!state?.useMergeBase;
    const nextBranch = showUncommittedChanges ? null : targetBranch;
    const nextUseMergeBase = !showUncommittedChanges;

    comparisonLoadingRef.current = true;
    setComparisonLoading(true);
    try {
      await fileListStore.fetchDiff(workingDirectory, nextBranch, nextUseMergeBase, workspaceId);
      store.setInlineFileTreeComparisonBranch(workspaceId, nextBranch, nextUseMergeBase);
    } catch {
      // Keep showing the current comparison when the replacement fails to load.
    } finally {
      comparisonLoadingRef.current = false;
      setComparisonLoading(false);
    }
  }, [workspaceId, workingDirectory, targetBranch]);

  // Copy/paste state
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [copiedIsDirectory, setCopiedIsDirectory] = useState(false);
  const [isCut, setIsCut] = useState(false);

  // Also write the absolute path to the OS clipboard so pasting in a terminal
  // or text editor gives you the path. Paste inside the file tree still reads
  // from the in-app state below — the OS clipboard can't round-trip our
  // cut-vs-copy distinction, and on-disk Paste should use what the user just
  // clicked on, not whatever else they may have Cmd+C'd in the meantime.
  const handleCopyNode = useCallback(
    (path: string, isDirectory: boolean) => {
      setCopiedPath(path);
      setCopiedIsDirectory(isDirectory);
      setIsCut(false);
      window.api.copyToClipboard(joinAbsPath(workingDirectory, path));
      const name = path.split('/').pop() || path;
      useToastStore.getState().addToast(`Copied ${name}`, 'success');
    },
    [workingDirectory]
  );

  const handleCutNode = useCallback(
    (path: string, isDirectory: boolean) => {
      setCopiedPath(path);
      setCopiedIsDirectory(isDirectory);
      setIsCut(true);
      window.api.copyToClipboard(joinAbsPath(workingDirectory, path));
      const name = path.split('/').pop() || path;
      useToastStore.getState().addToast(`Cut ${name}`, 'success');
    },
    [workingDirectory]
  );

  const handlePasteInto = useCallback(
    async (targetDir: string) => {
      if (!copiedPath) return;
      const name = copiedPath.split('/').pop() || copiedPath;
      const destPath = targetDir ? `${targetDir}/${name}` : name;
      // Moving a node onto itself would "overwrite" it and then trash the original.
      if (isCut && destPath === copiedPath) return;
      try {
        const exists = await window.api.fileExists(workingDirectory, destPath);
        if (exists) {
          const confirmed = await confirm({
            title: 'File Already Exists',
            description: (
              <>
                <strong>{name}</strong> already exists in {targetDir || 'the root directory'}. Do
                you want to overwrite it?
              </>
            ),
            confirmLabel: 'Overwrite',
          });
          if (!confirmed) return;
        }
        await pasteFileTreeNode(workingDirectory, {
          src: copiedPath,
          dest: destPath,
          isDirectory: copiedIsDirectory,
          isCut,
          overwrite: exists,
        });
        if (isCut) {
          setCopiedPath(null);
          setIsCut(false);
        }
        useToastStore.getState().addToast(`${isCut ? 'Moved' : 'Pasted'} ${name}`, 'success');
        refreshFileLists();
      } catch (err) {
        useToastStore
          .getState()
          .addToast(
            `Failed to paste: ${err instanceof Error ? err.message : 'Unknown error'}`,
            'error'
          );
      }
    },
    [copiedPath, copiedIsDirectory, isCut, workingDirectory, refreshFileLists, confirm]
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <Suspense fallback={null}>
        <SidebarFileTree
          workspaceId={workspaceId}
          workingDirectory={workingDirectory}
          isVisible={isDataActive}
          currentFile={currentFile}
          focusAlignmentSignal={focusAlignmentSignal}
          reveal={reveal}
          onFileSelect={handleFileSelect}
          isRemoteWorkspace={isRemoteWorkspace}
          onDeleteFile={handleDeleteFile}
          onRestoreFile={comparisonBranch ? undefined : handleRestoreFile}
          onRenameComplete={isRemoteWorkspace ? undefined : handleRenameComplete}
          onCreateFile={isRemoteWorkspace ? undefined : handleCreateFile}
          onCreateDirectory={isRemoteWorkspace ? undefined : handleCreateDirectory}
          onMoveNodes={isRemoteWorkspace ? undefined : handleMoveNodes}
          onAddToGitignore={isGitWorkspace && !isRemoteWorkspace ? handleAddToGitignore : undefined}
          onRollbackAll={isGitWorkspace && !comparisonBranch ? handleRollbackAll : undefined}
          onCopyNode={isRemoteWorkspace ? undefined : handleCopyNode}
          onCutNode={isRemoteWorkspace ? undefined : handleCutNode}
          onPasteInto={isRemoteWorkspace ? undefined : handlePasteInto}
          hasCopiedFile={copiedPath !== null}
          changedFilesOnly={effectiveMode === 'diff'}
          changedFiles={effectiveMode === 'diff' ? changedFiles : undefined}
          diffFileStatuses={effectiveMode === 'diff' ? diffFileStatuses : undefined}
          diffSummary={isGitWorkspace ? diffSummary : undefined}
          liveFollow={liveFollow}
          onToggleLiveFollow={
            isGitWorkspace && effectiveMode === 'diff' ? handleToggleLiveFollow : undefined
          }
          comparisonBranch={comparisonBranch}
          useMergeBase={useMergeBase}
          targetBranchName={targetBranch}
          diffLoading={comparisonLoading || (cached?.isLoading ?? false)}
          onToggleBranchComparison={isGitWorkspace ? handleToggleBranchComparison : undefined}
          onShowFileHistory={isGitWorkspace ? handleShowFileHistory : undefined}
          onOpenHtmlInBrowser={isRemoteWorkspace ? undefined : handleOpenHtmlInBrowser}
          onOpenInPane={handleOpenInPane}
          side="right"
          embedded
        />
      </Suspense>

      {/* Create file/folder dialog */}
      <Dialog
        open={createTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCreateTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{createTarget?.type === 'file' ? 'New File' : 'New Folder'}</DialogTitle>
            <DialogDescription>
              {createTarget?.parentDir ? (
                <>
                  Enter a name for the new {createTarget.type === 'file' ? 'file' : 'folder'} in{' '}
                  <strong>{createTarget.parentDir}</strong>
                </>
              ) : (
                <>Enter a name for the new {createTarget?.type === 'file' ? 'file' : 'folder'}</>
              )}
            </DialogDescription>
          </DialogHeader>
          <input
            type="text"
            value={createValue}
            onChange={(e) => setCreateValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void confirmCreate();
              }
            }}
            placeholder={createTarget?.type === 'file' ? 'filename.txt' : 'folder-name'}
            className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateTarget(null)}>
              Cancel
            </Button>
            <Button onClick={() => void confirmCreate()} disabled={!createValue.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </div>
  );
}
