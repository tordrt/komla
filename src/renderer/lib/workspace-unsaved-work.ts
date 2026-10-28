import { countUnpushedBranchCommits } from '../../shared/lib/workspace-branch-status';

import type { Workspace } from '@/types';

/** Work that deleting a workspace would lose. */
export interface UnsavedWork {
  uncommittedFiles: number;
  /** Lost only when the branch is deleted too. */
  unpushedCommits: number;
}

// Each check runs git twice, so a big group is checked a few workspaces at a time.
const CHECKS_AT_ONCE = 4;

/** Asks git what deleting the workspace would lose, or null when that can't be told. */
export async function getUnsavedWork(workspace: Workspace): Promise<UnsavedWork | null> {
  // Deleting a workspace that isn't a worktree leaves its directory alone.
  if (!workspace.isWorktree) return { uncommittedFiles: 0, unpushedCommits: 0 };
  try {
    const [diff, status] = await Promise.all([
      window.api.getWorkspaceDiff(workspace.id),
      window.api.getWorkspaceGitBranchStatus(workspace.id, workspace.projectId ?? undefined),
    ]);
    return {
      uncommittedFiles: diff.files.length,
      unpushedCommits: countUnpushedBranchCommits(status),
    };
  } catch {
    // E.g. its SSH host is offline.
    return null;
  }
}

/** {@link getUnsavedWork} for each workspace, by workspace ID. */
export async function getUnsavedWorkByWorkspace(
  workspaces: Workspace[]
): Promise<Map<string, UnsavedWork | null>> {
  const results = new Map<string, UnsavedWork | null>();
  const queue = [...workspaces];
  const checkNext = async () => {
    for (let workspace = queue.shift(); workspace; workspace = queue.shift()) {
      results.set(workspace.id, await getUnsavedWork(workspace));
    }
  };
  await Promise.all(Array.from({ length: CHECKS_AT_ONCE }, checkNext));
  return results;
}
