import { resolveWorkspaceTargetBranch, type Workspace } from '../types';

export function getGitTargetStatusScope(
  workspace: Workspace | undefined,
  targetBranch?: string
): string | undefined {
  if (workspace?.backend?.kind !== 'ssh') return undefined;
  const target = targetBranch || resolveWorkspaceTargetBranch(workspace);
  if (!target) return undefined;
  return JSON.stringify([
    'ssh',
    workspace.backend.hostId,
    workspace.backend.remoteRepoPath,
    target,
  ]);
}
