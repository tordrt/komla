import type { WorkspaceGitStatusSnapshot } from '../types/workspace';
import type { BranchStatus } from '../types/workspace-observation';

export function toGitBranchQuickStatus(
  branch: BranchStatus,
  fallbackDefaultBranch?: string
): WorkspaceGitStatusSnapshot['branch'] {
  return {
    currentBranch: branch.currentBranch,
    mainBranch: branch.targetBranch,
    defaultBranch: branch.defaultBranch || fallbackDefaultBranch || branch.targetBranch,
    ...(branch.remoteDefaultBranch ? { remoteDefaultBranch: branch.remoteDefaultBranch } : {}),
    aheadTargetBranch: branch.aheadTargetBranch,
    behindTargetBranch: branch.behindTargetBranch,
    hasRemote: branch.hasRemote,
    hasOriginRemote: branch.hasOriginRemote,
    unpushedCommits: branch.unpushedCommits,
    behindRemote: branch.behindRemote,
    targetBranchHasRemote: branch.targetBranchHasRemote,
    targetBranchAheadRemote: branch.targetBranchAheadRemote,
    targetBranchBehindRemote: branch.targetBranchBehindRemote,
    rebaseInProgress: branch.rebaseInProgress,
  };
}

// Commits that aren't on the target branch survive deleting the branch only if
// they were pushed.
export function countUnpushedBranchCommits(
  status: { hasRemote: boolean; unpushedCommits: number; aheadTargetBranch: number } | undefined
): number {
  if (!status) return 0;
  const unpushed = status.hasRemote ? status.unpushedCommits : status.aheadTargetBranch;
  return Math.min(unpushed, status.aheadTargetBranch);
}
