import { projectRepoPath } from '../../shared/lib/project-repo-path';
import { toGitBranchQuickStatus } from '../../shared/lib/workspace-branch-status';
import { isSshWorkspace, resolveWorkspaceTargetBranch } from '../../shared/types/workspace';
import { createLogger } from '../lib/logger';

import { gitService } from './git.service';
import { managedRepoService } from './managed-repo.service';
import { projectService } from './project.service';
import { localWorkspaceRepositoryAdapter } from './workspace-git/local-repository.adapter';
import { sshWorkspaceRepositoryAdapter } from './workspace-git/ssh-repository.adapter';
import { workspaceStatusService } from './workspace-status.service';
import { workspaceService } from './workspace.service';

import type {
  BranchInfo,
  CommitDiff,
  FileDiffContent,
  GitBranchQuickStatus,
  GitProgressCallback,
  WorktreeDiff,
} from './git.service';
import type {
  WorkspaceGitCommitInput,
  WorkspaceGitMergeOptions,
  WorkspaceGitPushResult,
  WorkspaceGitResult,
  WorkspaceRepositoryAdapter,
} from './workspace-git/repository.adapter';
import type { CommitChangesResult, CommitDraftResult, CommitScopeResult } from '../../shared/types';
import type { CommitGraph, CommitGraphQuery } from '../../shared/types/commit-graph';
import type { Workspace } from '../../shared/types/workspace';

const logger = createLogger('WorkspaceGitService');

export type WorkspaceGitLocalSyncProgress = (workingDirectory: string) => void;

function getGitRemoteIdentity(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  const normalizePath = (path: string) => path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');

  try {
    const parsed = new URL(trimmed);
    return `${parsed.host.toLowerCase()}/${normalizePath(parsed.pathname)}`;
  } catch {
    const sshMatch = trimmed.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (sshMatch?.[1] && sshMatch[2]) {
      return `${sshMatch[1].toLowerCase()}/${normalizePath(sshMatch[2])}`;
    }
    return trimmed.replace(/[\\/]+$/g, '').replace(/\.git$/i, '');
  }
}

class WorkspaceGitService {
  async getBranchQuickStatus(
    workspaceId: string,
    projectId?: string
  ): Promise<GitBranchQuickStatus> {
    const workspace = this.getWorkspace(workspaceId);
    logger.debug('getting workspace branch status', { workspaceId });
    if (workspace.provisioning || workspace.provisionError) {
      return this.getProvisioningStatus(workspace);
    }
    if (workspace.backend?.kind === 'ssh') {
      const observed = this.getObservedSshBranchStatus(workspace);
      if (observed) return observed;
      return workspace.lastKnownGitStatus?.branch ?? this.getProvisioningStatus(workspace);
    }
    const status = await this.getAdapter(workspace).getBranchQuickStatus(workspace);
    await this.applyManagedRepoTargetStatus(status, projectId);
    return status;
  }

  async listBranches(workspaceId: string, includeRemote = false): Promise<BranchInfo[]> {
    const workspace = this.getWorkspace(workspaceId);
    logger.debug('listing workspace branches', { workspaceId, includeRemote });
    return this.getAdapter(workspace).listBranches(workspace, includeRemote);
  }

  getCommitGraph(workspaceId: string, query: CommitGraphQuery): Promise<CommitGraph> {
    const workspace = this.getWorkspace(workspaceId);
    return this.getAdapter(workspace).getCommitGraph(workspace, query);
  }

  getCommitDiff(workspaceId: string, commitHash: string): Promise<CommitDiff> {
    const workspace = this.getWorkspace(workspaceId);
    return this.getAdapter(workspace).getCommitDiff(workspace, commitHash);
  }

  getCommitFileDiff(
    workspaceId: string,
    commitHash: string,
    filePath: string
  ): Promise<FileDiffContent> {
    const workspace = this.getWorkspace(workspaceId);
    return this.getAdapter(workspace).getCommitFileDiff(workspace, commitHash, filePath);
  }

  getWorkingTreeDiff(workspaceId: string): Promise<WorktreeDiff> {
    const workspace = this.getWorkspace(workspaceId);
    return this.getAdapter(workspace).getWorkingTreeDiff(workspace);
  }

  getWorkingTreeDiffAgainstBranch(
    workspaceId: string,
    branch: string,
    useMergeBase = false
  ): Promise<WorktreeDiff> {
    const workspace = this.getWorkspace(workspaceId);
    return this.getAdapter(workspace).getWorkingTreeDiffAgainstBranch(
      workspace,
      branch,
      useMergeBase
    );
  }

  getFullFileDiff(workspaceId: string, filePath: string, staged = false): Promise<FileDiffContent> {
    const workspace = this.getWorkspace(workspaceId);
    return this.getAdapter(workspace).getFullFileDiff(workspace, filePath, staged);
  }

  getFullFileDiffAgainstBranch(
    workspaceId: string,
    filePath: string,
    branch: string,
    useMergeBase = false
  ): Promise<FileDiffContent> {
    const workspace = this.getWorkspace(workspaceId);
    return this.getAdapter(workspace).getFullFileDiffAgainstBranch(
      workspace,
      filePath,
      branch,
      useMergeBase
    );
  }

  async fetchFromRemote(workspaceId: string): Promise<WorkspaceGitResult> {
    const workspace = this.getWorkspace(workspaceId);
    const result = await this.getAdapter(workspace).fetchFromRemote(workspace);
    if (isSshWorkspace(workspace) || !workspace.projectId) return result;
    return this.withProjectTargetsFastForwarded(result, workspace.projectId);
  }

  /** Fetches a project's repository: a managed project's bare clone, or the project folder. */
  async fetchProject(projectId: string): Promise<WorkspaceGitResult> {
    const project = projectService.get(projectId);
    if (!project) return { success: false, message: 'Project not found' };
    const result =
      project.managed && project.managedRepoPath
        ? await managedRepoService.fetch(project.managedRepoPath)
        : await gitService.fetchFromRemote(project.repositoryPath);
    return this.withProjectTargetsFastForwarded(result, projectId);
  }

  /** Fetches the repository at `repoPath`: a project's folder or bare clone, or a workspace's. */
  async fetchPath(repoPath: string, onProgress?: GitProgressCallback): Promise<WorkspaceGitResult> {
    const result = await gitService.fetchFromRemote(repoPath, onProgress);
    if (!result.success) return result;
    const projectId =
      projectService.list().find((project) => projectRepoPath(project) === repoPath)?.id ??
      workspaceService
        .list()
        .find((workspace) => !isSshWorkspace(workspace) && workspace.workingDirectory === repoPath)
        ?.projectId;
    return projectId ? this.withProjectTargetsFastForwarded(result, projectId) : result;
  }

  /**
   * Fast-forwards the project's target branch, and each of its local workspaces', that a fetch
   * left strictly behind origin's, so their ↓N counts and the target branch agree without a
   * Pull. A branch checked out in a worktree, or with commits of its own, stays where it is.
   * `proceed` lets background work give way before each branch. Returns the branches moved.
   */
  async fastForwardProjectTargets(
    projectId: string,
    proceed: () => boolean = () => true
  ): Promise<string[]> {
    const project = projectService.get(projectId);
    if (!project || project.kind === 'directory') return [];
    const repoPath = projectRepoPath(project);
    // Without a target of their own or the project's, workspaces follow the default branch.
    const defaultBranch = await gitService.getTargetBranch(repoPath).catch((error: unknown) => {
      logger.debug('could not read default branch to fast-forward', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return '';
    });
    const targets = [
      project.baseBranch || defaultBranch,
      ...workspaceService
        .list()
        .filter((workspace) => workspace.projectId === projectId && !isSshWorkspace(workspace))
        .map(
          (workspace) =>
            resolveWorkspaceTargetBranch(workspace, project.baseBranch) || defaultBranch
        ),
    ];
    const moved: string[] = [];
    for (const branch of new Set(targets)) {
      if (!branch || !proceed()) continue;
      const fastForwarded = await gitService
        .fastForwardBranchToRemoteIfSafe(repoPath, branch)
        .catch((error: unknown) => {
          logger.debug('could not fast-forward target branch', {
            projectId,
            branch,
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        });
      if (fastForwarded) moved.push(branch);
    }
    return moved;
  }

  private async withProjectTargetsFastForwarded(
    result: WorkspaceGitResult,
    projectId: string
  ): Promise<WorkspaceGitResult> {
    if (!result.success) return result;
    const moved = await this.fastForwardProjectTargets(projectId);
    if (moved.length === 0) return result;
    return {
      ...result,
      message: `${result.message}. Local ${moved.join(', ')} caught up with origin`,
    };
  }

  inspectCommitScope(workspaceId: string): Promise<CommitScopeResult> {
    const workspace = this.getWorkspace(workspaceId);
    return this.getAdapter(workspace).inspectCommitScope(workspace);
  }

  generateCommitDraft(workspaceId: string): Promise<CommitDraftResult> {
    const workspace = this.getWorkspace(workspaceId);
    return this.getAdapter(workspace).generateCommitDraft(workspace);
  }

  commitChanges(workspaceId: string, input: WorkspaceGitCommitInput): Promise<CommitChangesResult> {
    return this.runMutation(workspaceId, (adapter, workspace) =>
      adapter.commitChanges(workspace, input)
    );
  }

  createBranch(workspaceId: string, branchName: string, startPoint?: string): Promise<void> {
    return this.runMutation(workspaceId, (adapter, workspace) =>
      adapter.createBranch(workspace, branchName, startPoint)
    );
  }

  async switchBranch(workspaceId: string, branchName: string): Promise<WorkspaceGitResult> {
    const workspace = this.getWorkspace(workspaceId);
    const adapter = this.getAdapter(workspace);
    const result = await this.runMutationWithWorkspace(workspace, () =>
      adapter.switchBranch(workspace, branchName)
    );
    if (workspace.backend?.kind === 'ssh' && result.success) {
      workspaceService.update(workspaceId, { branchName });
    }
    return result;
  }

  mergeFrom(
    workspaceId: string,
    branchName: string,
    options?: WorkspaceGitMergeOptions
  ): Promise<WorkspaceGitResult> {
    return this.runMutation(workspaceId, (adapter, workspace) =>
      adapter.mergeFrom(workspace, branchName, options)
    );
  }

  rebaseOnBranch(
    workspaceId: string,
    branchName: string,
    options?: WorkspaceGitMergeOptions
  ): Promise<WorkspaceGitResult> {
    return this.runMutation(workspaceId, (adapter, workspace) =>
      adapter.rebaseOnBranch(workspace, branchName, options)
    );
  }

  async push(
    workspaceId: string,
    onLocalProjectSync?: WorkspaceGitLocalSyncProgress
  ): Promise<WorkspaceGitPushResult> {
    const workspace = this.getWorkspace(workspaceId);
    const result = await this.getAdapter(workspace).push(workspace);
    return this.syncLocalProjectAfterSshPush(workspace, result, onLocalProjectSync);
  }

  pull(workspaceId: string): Promise<WorkspaceGitResult> {
    return this.runMutation(workspaceId, (adapter, workspace) => adapter.pull(workspace));
  }

  async pushTargetBranch(
    workspaceId: string,
    onLocalProjectSync?: WorkspaceGitLocalSyncProgress
  ): Promise<WorkspaceGitPushResult> {
    const workspace = this.getWorkspace(workspaceId);
    const result = await this.getAdapter(workspace).pushTargetBranch(workspace);
    return this.syncLocalProjectAfterSshPush(workspace, result, onLocalProjectSync);
  }

  pullTargetBranch(workspaceId: string): Promise<WorkspaceGitResult> {
    return this.runMutation(workspaceId, (adapter, workspace) =>
      adapter.pullTargetBranch(workspace)
    );
  }

  mergeTargetBranchFromRemote(workspaceId: string): Promise<WorkspaceGitResult> {
    return this.runMutation(workspaceId, (adapter, workspace) =>
      adapter.mergeTargetBranchFromRemote(workspace)
    );
  }

  mergeToTargetBranch(workspaceId: string): Promise<WorkspaceGitResult> {
    return this.runMutation(workspaceId, (adapter, workspace) =>
      adapter.mergeToTargetBranch(workspace)
    );
  }

  restoreFile(
    workspaceId: string,
    filePath: string,
    status: string,
    oldPath?: string
  ): Promise<void> {
    return this.runMutation(workspaceId, (adapter, workspace) =>
      adapter.restoreFile(workspace, filePath, status, oldPath)
    );
  }

  discardAllChanges(workspaceId: string): Promise<WorkspaceGitResult> {
    return this.runMutation(workspaceId, (adapter, workspace) =>
      adapter.discardAllChanges(workspace)
    );
  }

  private getWorkspace(workspaceId: string): Workspace {
    const workspace = workspaceService.get(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
    return workspace;
  }

  private getAdapter(workspace: Workspace): WorkspaceRepositoryAdapter {
    return workspace.backend?.kind === 'ssh'
      ? sshWorkspaceRepositoryAdapter
      : localWorkspaceRepositoryAdapter;
  }

  private runMutation<T>(
    workspaceId: string,
    operation: (adapter: WorkspaceRepositoryAdapter, workspace: Workspace) => Promise<T>
  ): Promise<T> {
    const workspace = this.getWorkspace(workspaceId);
    return this.runMutationWithWorkspace(workspace, () =>
      operation(this.getAdapter(workspace), workspace)
    );
  }

  private async runMutationWithWorkspace<T>(
    workspace: Workspace,
    operation: () => Promise<T>
  ): Promise<T> {
    if (workspace.backend?.kind !== 'ssh') return operation();
    try {
      return await operation();
    } finally {
      await workspaceStatusService.change({
        kind: 'repository-mutated',
        workspaceId: workspace.id,
      });
    }
  }

  private async syncLocalProjectAfterSshPush(
    workspace: Workspace,
    pushResult: WorkspaceGitPushResult,
    onLocalProjectSync?: WorkspaceGitLocalSyncProgress
  ): Promise<WorkspaceGitPushResult> {
    if (!pushResult.success || workspace.backend?.kind !== 'ssh' || !workspace.projectId) {
      return pushResult;
    }

    const project = projectService.get(workspace.projectId);
    const repoPath = project && projectRepoPath(project);
    if (!project || !repoPath) return pushResult;

    const localRemoteUrl = await gitService.getRemoteUrl(repoPath).catch(() => null);
    if (
      !localRemoteUrl ||
      getGitRemoteIdentity(localRemoteUrl) !== getGitRemoteIdentity(workspace.backend.gitUrl)
    ) {
      logger.info('skipping local Git sync after SSH push because remotes differ', {
        workspaceId: workspace.id,
        projectId: project.id,
      });
      return pushResult;
    }

    onLocalProjectSync?.(workspace.workingDirectory);
    try {
      const managed = Boolean(project.managed && project.managedRepoPath);
      const syncResult = managed
        ? await this.fetchProject(project.id)
        : // A user's own branches move only when they fetch.
          await gitService.fetchFromRemote(project.repositoryPath);
      if (!syncResult.success) {
        logger.warn('SSH push succeeded but local Git state could not be synced', {
          workspaceId: workspace.id,
          projectId: project.id,
          error: syncResult.message,
        });
      }
    } catch (error) {
      logger.warn('SSH push succeeded but local Git state could not be synced', {
        workspaceId: workspace.id,
        projectId: project.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return pushResult;
  }

  private getProvisioningStatus(workspace: Workspace): GitBranchQuickStatus {
    const targetBranch =
      workspace.baseBranch ||
      (workspace.backend?.kind === 'ssh' ? workspace.backend.baseBranch : undefined) ||
      'main';
    return {
      behindTargetBranch: 0,
      aheadTargetBranch: 0,
      mainBranch: targetBranch,
      defaultBranch:
        (workspace.backend?.kind === 'ssh' ? workspace.backend.defaultBranch : undefined) ||
        targetBranch,
      hasRemote: false,
      hasOriginRemote: false,
      unpushedCommits: 0,
      behindRemote: 0,
      currentBranch: workspace.branchName || '',
      targetBranchHasRemote: false,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    };
  }

  private getObservedSshBranchStatus(workspace: Workspace): GitBranchQuickStatus | undefined {
    const observation = workspaceStatusService.read(workspace.id);
    if (!observation) return undefined;
    return toGitBranchQuickStatus(
      observation.branch,
      workspace.backend?.kind === 'ssh' ? workspace.backend.defaultBranch : undefined
    );
  }

  private async applyManagedRepoTargetStatus(
    status: GitBranchQuickStatus,
    projectId?: string
  ): Promise<void> {
    if (!projectId) return;
    const project = projectService.get(projectId);
    if (!project?.managed || !project.managedRepoPath) return;
    try {
      const remoteStatus = await managedRepoService.getRemoteStatus(
        project.managedRepoPath,
        status.mainBranch
      );
      status.targetBranchHasRemote = remoteStatus.hasRemote;
      status.targetBranchAheadRemote = remoteStatus.ahead;
      status.targetBranchBehindRemote = remoteStatus.behind;
    } catch {
      // Keep the repository adapter's status when managed-repository refresh fails.
    }
  }
}

export const workspaceGitService = new WorkspaceGitService();
