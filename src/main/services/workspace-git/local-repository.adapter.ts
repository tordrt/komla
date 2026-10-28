import { assertSafeRelativePath } from '../../ipc/validation/path-safety';
import { gitService } from '../git.service';

import type {
  WorkspaceGitCommitInput,
  WorkspaceGitMergeOptions,
  WorkspaceGitPushResult,
  WorkspaceGitResult,
  WorkspaceRepositoryAdapter,
} from './repository.adapter';
import type {
  CommitChangesResult,
  CommitDraftResult,
  CommitScopeResult,
} from '../../../shared/types';
import type { CommitGraph, CommitGraphQuery } from '../../../shared/types/commit-graph';
import type { Workspace } from '../../../shared/types/workspace';
import type {
  BranchInfo,
  CommitDiff,
  FileDiffContent,
  GitBranchQuickStatus,
  WorktreeDiff,
} from '../git.service';

class LocalWorkspaceRepositoryAdapter implements WorkspaceRepositoryAdapter {
  getBranchQuickStatus(workspace: Workspace): Promise<GitBranchQuickStatus> {
    return gitService.getBranchQuickStatus(workspace.workingDirectory);
  }

  listBranches(workspace: Workspace, includeRemote: boolean): Promise<BranchInfo[]> {
    return gitService.listBranches(workspace.workingDirectory, includeRemote);
  }

  getCommitGraph(workspace: Workspace, query: CommitGraphQuery): Promise<CommitGraph> {
    if (query.path) assertSafeRelativePath(workspace.workingDirectory, query.path, 'path');
    return gitService.getCommitGraph(workspace.workingDirectory, query);
  }

  getCommitDiff(workspace: Workspace, commitHash: string): Promise<CommitDiff> {
    return gitService.getCommitDiff(workspace.workingDirectory, commitHash);
  }

  getCommitFileDiff(
    workspace: Workspace,
    commitHash: string,
    filePath: string
  ): Promise<FileDiffContent> {
    assertSafeRelativePath(workspace.workingDirectory, filePath, 'filePath');
    return gitService.getCommitFileDiff(workspace.workingDirectory, commitHash, filePath);
  }

  getWorkingTreeDiff(workspace: Workspace): Promise<WorktreeDiff> {
    return gitService.getWorkingTreeDiff(workspace.workingDirectory);
  }

  getWorkingTreeDiffAgainstBranch(
    workspace: Workspace,
    branch: string,
    useMergeBase: boolean
  ): Promise<WorktreeDiff> {
    return gitService.getWorkingTreeDiffAgainstBranch(
      workspace.workingDirectory,
      branch,
      useMergeBase
    );
  }

  getFullFileDiff(
    workspace: Workspace,
    filePath: string,
    staged: boolean
  ): Promise<FileDiffContent> {
    assertSafeRelativePath(workspace.workingDirectory, filePath, 'filePath');
    return gitService.getFullFileDiff(workspace.workingDirectory, filePath, staged);
  }

  getFullFileDiffAgainstBranch(
    workspace: Workspace,
    filePath: string,
    branch: string,
    useMergeBase: boolean
  ): Promise<FileDiffContent> {
    assertSafeRelativePath(workspace.workingDirectory, filePath, 'filePath');
    return gitService.getFullFileDiffAgainstBranch(
      workspace.workingDirectory,
      filePath,
      branch,
      useMergeBase
    );
  }

  fetchFromRemote(workspace: Workspace): Promise<WorkspaceGitResult> {
    return gitService.fetchFromRemote(workspace.workingDirectory);
  }

  inspectCommitScope(workspace: Workspace): Promise<CommitScopeResult> {
    return gitService.inspectCommitScope(workspace.workingDirectory);
  }

  generateCommitDraft(workspace: Workspace): Promise<CommitDraftResult> {
    return gitService.generateCommitDraft(workspace.workingDirectory);
  }

  commitChanges(
    workspace: Workspace,
    input: WorkspaceGitCommitInput
  ): Promise<CommitChangesResult> {
    return gitService.commitChanges(workspace.workingDirectory, input);
  }

  async createBranch(workspace: Workspace, branchName: string, startPoint?: string): Promise<void> {
    const start =
      startPoint && (await gitService.resolveStartRef(workspace.workingDirectory, startPoint));
    return gitService.createBranch(workspace.workingDirectory, branchName, start || undefined);
  }

  switchBranch(workspace: Workspace, branchName: string): Promise<WorkspaceGitResult> {
    return gitService.switchBranch(workspace.workingDirectory, branchName);
  }

  mergeFrom(
    workspace: Workspace,
    branchName: string,
    options?: WorkspaceGitMergeOptions
  ): Promise<WorkspaceGitResult> {
    return gitService.mergeFrom(workspace.workingDirectory, branchName, options);
  }

  rebaseOnBranch(
    workspace: Workspace,
    branchName: string,
    options?: WorkspaceGitMergeOptions
  ): Promise<WorkspaceGitResult> {
    return gitService.rebaseOnBranch(workspace.workingDirectory, branchName, options);
  }

  push(workspace: Workspace): Promise<WorkspaceGitPushResult> {
    return gitService.push(workspace.workingDirectory);
  }

  pull(workspace: Workspace): Promise<WorkspaceGitResult> {
    return gitService.pull(workspace.workingDirectory);
  }

  pushTargetBranch(workspace: Workspace): Promise<WorkspaceGitPushResult> {
    return gitService.pushTargetBranch(workspace.workingDirectory);
  }

  pullTargetBranch(workspace: Workspace): Promise<WorkspaceGitResult> {
    return gitService.pullTargetBranch(workspace.workingDirectory);
  }

  mergeTargetBranchFromRemote(workspace: Workspace): Promise<WorkspaceGitResult> {
    return gitService.mergeTargetBranchFromRemote(workspace.workingDirectory);
  }

  mergeToTargetBranch(workspace: Workspace): Promise<WorkspaceGitResult> {
    return gitService.mergeToTargetBranch(workspace.workingDirectory);
  }

  restoreFile(
    workspace: Workspace,
    filePath: string,
    status: string,
    oldPath?: string
  ): Promise<void> {
    assertSafeRelativePath(workspace.workingDirectory, filePath, 'filePath');
    if (oldPath) {
      assertSafeRelativePath(workspace.workingDirectory, oldPath, 'oldPath');
    }
    return gitService.restoreFile(workspace.workingDirectory, filePath, status, oldPath);
  }

  discardAllChanges(workspace: Workspace): Promise<WorkspaceGitResult> {
    return gitService.discardAllChanges(workspace.workingDirectory);
  }
}

export const localWorkspaceRepositoryAdapter = new LocalWorkspaceRepositoryAdapter();
