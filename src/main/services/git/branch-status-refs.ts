/**
 * The local branches a worktree's Branch Status reads (`GitBranchService.getBranchQuickStatus`):
 * the branch it has checked out and the local branch that one tracks, if it tracks one, its
 * target branch, and the repository's default branch. The worktree watcher refreshes a worktree
 * when one of them moves, so a status that starts reading another local branch adds it here.
 * Remote branches aren't listed: the watcher refreshes every worktree when one moves.
 */
export function localBranchesReadByBranchStatus(worktree: {
  checkedOutBranch: string | undefined;
  /** The checked-out branch's upstream as a full ref, if it has one. */
  upstream: string | undefined;
  targetBranch: string;
  defaultBranch: string;
}): string[] {
  const branches = [worktree.targetBranch, worktree.defaultBranch];
  if (worktree.checkedOutBranch) branches.push(worktree.checkedOutBranch);
  if (worktree.upstream?.startsWith('refs/heads/')) {
    branches.push(worktree.upstream.slice('refs/heads/'.length));
  }
  return branches;
}
