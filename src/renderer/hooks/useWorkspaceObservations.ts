import { useEffect } from 'react';

import { getGitTargetStatusScope } from '@/lib/git-target-status-scope';
import { useFileListStore } from '@/stores/file-list.store';
import { useGitStatusStore } from '@/stores/git-status.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useWorkspaceObservationStore } from '@/stores/workspace-observation.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isSshWorkspace } from '@/types';

import { toGitBranchQuickStatus } from '../../shared/lib/workspace-branch-status';

import type { WorkspaceObservationProjection } from '@/types';

function applyProjection(
  projection: WorkspaceObservationProjection,
  revisions: Map<string, number>
): void {
  if ((revisions.get(projection.workspaceId) ?? 0) >= projection.revision) return;
  const workspacesStore = useWorkspacesStore.getState();
  const workspace = workspacesStore.workspaces.find(({ id }) => id === projection.workspaceId);
  if (!workspace) return;
  revisions.set(projection.workspaceId, projection.revision);
  const project = workspace.projectId
    ? useProjectsStore.getState().projects.find(({ id }) => id === workspace.projectId)
    : undefined;
  const targetStatusScope = getGitTargetStatusScope(
    workspace,
    workspace.baseBranch || project?.baseBranch
  );
  const branchStatus = toGitBranchQuickStatus(
    projection.branch,
    workspace.backend?.kind === 'ssh' ? workspace.backend.defaultBranch : undefined
  );

  const fileListStore = useFileListStore.getState();
  // Each SSH projection that changes files comes with a worktree change, on which
  // useWorktreeWatcher marks stale only the diffs of the files the Remote Companion names.
  if (!isSshWorkspace(workspace)) {
    fileListStore.invalidateFileDiffs(workspace.workingDirectory, workspace.id);
  }
  fileListStore.invalidateBranchComparisonDiffs(workspace.workingDirectory, workspace.id);
  fileListStore.applyPushedFileStatus(
    workspace.workingDirectory,
    projection.workingTree,
    workspace.id
  );
  useGitStatusStore
    .getState()
    .applyPushedStatus(workspace.id, branchStatus, workspace.projectId, targetStatusScope);
  if (branchStatus.currentBranch && branchStatus.currentBranch !== workspace.branchName) {
    workspacesStore.updateWorkspace(workspace.id, { branchName: branchStatus.currentBranch });
  }
}

/** Keeps renderer caches converged with the revisioned main-process projection. */
export function useWorkspaceObservations(): void {
  useEffect(() => {
    const revisions = new Map<string, number>();
    let disposed = false;
    const unsubscribe = window.api.onWorkspaceObservation((projection) => {
      if (disposed) return;
      useWorkspaceObservationStore.getState().applyProjection(projection);
      applyProjection(projection, revisions);
    });
    const unsubscribeWorkspaces = useWorkspacesStore.subscribe(() => {
      for (const projection of useWorkspaceObservationStore.getState().projections.values()) {
        applyProjection(projection, revisions);
      }
    });
    void window.api
      .getWorkspaceObservations()
      .then((projections) => {
        if (disposed) return;
        for (const projection of projections) {
          useWorkspaceObservationStore.getState().applyProjection(projection);
          applyProjection(projection, revisions);
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeWorkspaces();
    };
  }, []);
}
