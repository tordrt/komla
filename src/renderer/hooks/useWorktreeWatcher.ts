import { useEffect } from 'react';

import { getGitTargetStatusScope } from '@/lib/git-target-status-scope';
import { useFileListStore } from '@/stores/file-list.store';
import { useGitStatusStore } from '@/stores/git-status.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { useWorktreeEventsStore } from '@/stores/worktree-events.store';
import { isSshWorkspace, resolveWorkspaceTargetBranch } from '@/types';

import type { RemoteWorkingTreeChange } from '@/types';

/**
 * Refreshes a workspace's cached file list after a change, leaving out gitignored files on this
 * hot path. An SSH listing is a round trip, so that list is only marked stale, unless the Remote
 * Companion's fingerprint shows it lists the same files: a tree on screen re-lists it, and a
 * hidden one waits until it is shown.
 */
function refreshCachedFileList(
  workspaceId: string,
  workingDirectory: string,
  remoteChange: RemoteWorkingTreeChange | undefined,
  isRemoteWorkspace: boolean
): void {
  const fileListStore = useFileListStore.getState();
  if (!fileListStore.getFileList(workingDirectory)) return;
  if (isRemoteWorkspace) {
    fileListStore.markFileListStale(workingDirectory, remoteChange?.fileListHash);
    return;
  }
  fileListStore.fetchFileList(workingDirectory, false, workspaceId).catch(() => {});
}

/**
 * Hook that subscribes to worktree file change events and triggers git status updates.
 * Uses change type classification for targeted cache invalidation to reduce unnecessary IPC traffic.
 * The main process pushes pre-computed file status data with the notification when available,
 * eliminating the need for the renderer to make a separate IPC round-trip.
 * Should be called once in the app root to set up the global subscription.
 */
export function useWorktreeWatcher(): void {
  useEffect(() => {
    const unsubscribe = window.api.onWorktreeChanged(
      async (
        workspaceId,
        changeTypes,
        activityAt,
        pushedFileStatus,
        pushedGitStatus,
        remoteChange
      ) => {
        // Get workspace directly from store to avoid stale closure
        const workspacesStore = useWorkspacesStore.getState();
        const workspace = workspacesStore.workspaces.find((w) => w.id === workspaceId);
        if (!workspace?.workingDirectory) return;
        const isGitWorkspace = workspace.isWorktree;
        const isRemoteWorkspace = isSshWorkspace(workspace);
        const project = workspace.projectId
          ? useProjectsStore
              .getState()
              .projects.find((project) => project.id === workspace.projectId)
          : undefined;
        const targetStatusScope = getGitTargetStatusScope(
          workspace,
          resolveWorkspaceTargetBranch(workspace, project?.baseBranch)
        );
        useWorktreeEventsStore.getState().recordEvent(workspaceId);

        const fileListStore = useFileListStore.getState();
        const hasFileChange = changeTypes.includes('file');
        const hasGitHeadChange = changeTypes.includes('git-head');
        const hasGitBranchChange = changeTypes.includes('git-branch');

        // Main process is the source of truth for activity updates.
        if (activityAt !== undefined) {
          workspacesStore.updateWorkspace(workspaceId, { lastActivityAt: activityAt });
        }

        // File changes or git commit/branch changes need status/diff refresh.
        // git-branch is included because refs/heads/<branch> updates AFTER a commit completes,
        // so it serves as a reliable post-commit signal that the diff against HEAD has changed.
        const needsFileStatusRefresh = hasFileChange || hasGitHeadChange || hasGitBranchChange;
        if (needsFileStatusRefresh) {
          // Clear per-file diff content: only that of the changed files when the Remote
          // Companion names them.
          fileListStore.invalidateFileDiffs(
            workspace.workingDirectory,
            workspaceId,
            isRemoteWorkspace ? remoteChange?.changedPaths : undefined
          );
          // Clear branch comparison diffs (e.g. "diff against main") which are not updated
          // by applyPushedFileStatus (it only updates the base HEAD-vs-working-tree diff).
          fileListStore.invalidateBranchComparisonDiffs(workspace.workingDirectory, workspaceId);

          // Apply pushed file status data if available (avoids IPC round-trip)
          if (pushedFileStatus) {
            fileListStore.applyPushedFileStatus(
              workspace.workingDirectory,
              pushedFileStatus,
              workspaceId
            );
          } else if (!isRemoteWorkspace && (hasFileChange || hasGitBranchChange)) {
            // Fallback: fetch via IPC for file/branch changes (not pure HEAD changes)
            fileListStore.fetchFileStatuses(workspace.workingDirectory).catch(() => {});
          }

          // Re-fetch file list if previously cached (handles new/deleted files).
          refreshCachedFileList(
            workspaceId,
            workspace.workingDirectory,
            remoteChange,
            isRemoteWorkspace
          );
        }

        if (!isGitWorkspace) return;

        if (pushedGitStatus) {
          useGitStatusStore
            .getState()
            .applyPushedStatus(
              workspaceId,
              pushedGitStatus,
              workspace.projectId,
              targetStatusScope
            );
          if (
            pushedGitStatus.currentBranch &&
            pushedGitStatus.currentBranch !== workspace.branchName
          ) {
            useWorkspacesStore
              .getState()
              .updateWorkspace(workspaceId, { branchName: pushedGitStatus.currentBranch });
          }
          return;
        }

        // Branch state may have changed - full status refresh needed
        const needsBranchRefresh = hasGitHeadChange || hasGitBranchChange;
        if (needsBranchRefresh) {
          const { fetchStatus } = useGitStatusStore.getState();
          const status = await fetchStatus(
            workspaceId,
            workspace.workingDirectory,
            workspace.projectId,
            targetStatusScope
          );

          // Update workspace branch name if it changed
          if (status?.currentBranch && status.currentBranch !== workspace.branchName) {
            useWorkspacesStore
              .getState()
              .updateWorkspace(workspaceId, { branchName: status.currentBranch });
            void window.api.updateWorkspace(workspaceId, { branchName: status.currentBranch });
          }
        }
      }
    );

    return unsubscribe;
  }, []);
}
