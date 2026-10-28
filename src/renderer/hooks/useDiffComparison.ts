import { useShallow } from 'zustand/react/shallow';

import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useGitStatusStore } from '@/stores/git-status.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { resolveWorkspaceTargetBranch } from '@/types';

/**
 * Which diff surface a comparison belongs to. The inline file tree, the inline
 * preview and its header share 'inline'; the full-screen diff keeps its own so
 * an explicit branch compare there doesn't leak into the workspace panel.
 */
export type DiffComparisonScope = 'file-viewer' | 'inline';

type FileViewerState = ReturnType<typeof useFileViewerStore.getState>;

/**
 * A merge-base comparison is "changes since the target branch", so it compares
 * against `targetBranch` (the workspace's current target) rather than the branch
 * stored when it was turned on. The stored one stands in until a target resolves.
 */
export function selectDiffComparison(
  state: FileViewerState,
  workspaceId: string,
  scope: DiffComparisonScope,
  targetBranch: string | undefined
) {
  const comparison =
    scope === 'file-viewer'
      ? state.fileViewerDiffComparisonByWorkspace[workspaceId]
      : state.inlineFileTreeByWorkspace[workspaceId];
  const comparisonBranch = comparison?.comparisonBranch ?? null;
  const useMergeBase = comparison?.useMergeBase ?? false;
  return {
    comparisonBranch:
      useMergeBase && comparisonBranch && targetBranch ? targetBranch : comparisonBranch,
    useMergeBase,
  };
}

/** The diff comparison for a workspace, read once outside React. */
export function getDiffComparison(workspaceId: string, scope: DiffComparisonScope) {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  const project = workspace?.projectId
    ? useProjectsStore.getState().projects.find((p) => p.id === workspace.projectId)
    : undefined;
  const targetBranch = resolveWorkspaceTargetBranch(
    workspace,
    project?.baseBranch,
    useGitStatusStore.getState().getStatus(workspaceId)?.status?.mainBranch
  );
  return selectDiffComparison(useFileViewerStore.getState(), workspaceId, scope, targetBranch);
}

/** The branch a workspace's diff compares against, or null for the working tree. */
export function useDiffComparison(workspaceId: string | null, scope: DiffComparisonScope) {
  // Only the fields the target comes from, so other workspace updates don't re-render callers.
  const workspace = useWorkspacesStore(
    useShallow((s) => {
      const found = workspaceId ? s.workspaces.find((w) => w.id === workspaceId) : undefined;
      return found
        ? { baseBranch: found.baseBranch, backend: found.backend, projectId: found.projectId }
        : undefined;
    })
  );
  const projectBaseBranch = useProjectsStore((s) =>
    workspace?.projectId
      ? s.projects.find((p) => p.id === workspace.projectId)?.baseBranch
      : undefined
  );
  const statusTargetBranch = useGitStatusStore((s) =>
    workspaceId ? s.getStatus(workspaceId)?.status?.mainBranch : undefined
  );
  const targetBranch = resolveWorkspaceTargetBranch(
    workspace,
    projectBaseBranch,
    statusTargetBranch
  );
  const comparisonBranch = useFileViewerStore((s) =>
    workspaceId ? selectDiffComparison(s, workspaceId, scope, targetBranch).comparisonBranch : null
  );
  const useMergeBase = useFileViewerStore((s) =>
    workspaceId ? selectDiffComparison(s, workspaceId, scope, targetBranch).useMergeBase : false
  );
  return { comparisonBranch, useMergeBase };
}
