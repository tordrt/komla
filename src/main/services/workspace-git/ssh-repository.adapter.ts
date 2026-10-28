import { sshWorkspaceDiff } from './ssh-diff';
import { sshWorkspaceGit } from './ssh-git';

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
import type { SshWorkspaceBackend, Workspace } from '../../../shared/types/workspace';
import type {
  BranchInfo,
  CommitDiff,
  FileDiffContent,
  GitBranchQuickStatus,
  WorktreeDiff,
} from '../git.service';

function getSshBackend(workspace: Workspace): SshWorkspaceBackend {
  if (workspace.backend?.kind !== 'ssh') {
    throw new Error(`Workspace ${workspace.id} is not an SSH workspace`);
  }
  return workspace.backend;
}

function getTargetBranch(workspace: Workspace, backend: SshWorkspaceBackend): string {
  return workspace.baseBranch || backend.baseBranch || 'main';
}

class SshWorkspaceRepositoryAdapter implements WorkspaceRepositoryAdapter {
  getBranchQuickStatus(workspace: Workspace): Promise<GitBranchQuickStatus> {
    const backend = getSshBackend(workspace);
    return sshWorkspaceGit.getBranchQuickStatus(backend, getTargetBranch(workspace, backend));
  }

  listBranches(workspace: Workspace, includeRemote: boolean): Promise<BranchInfo[]> {
    return sshWorkspaceGit.listBranches(getSshBackend(workspace), includeRemote);
  }

  getCommitGraph(workspace: Workspace, query: CommitGraphQuery): Promise<CommitGraph> {
    return sshWorkspaceGit.getCommitGraph(getSshBackend(workspace), query);
  }

  getCommitDiff(workspace: Workspace, commitHash: string): Promise<CommitDiff> {
    return sshWorkspaceDiff.getCommitDiff(workspace, commitHash);
  }

  getCommitFileDiff(
    workspace: Workspace,
    commitHash: string,
    filePath: string
  ): Promise<FileDiffContent> {
    return sshWorkspaceDiff.getCommitFileDiff(workspace, commitHash, filePath);
  }

  getWorkingTreeDiff(workspace: Workspace): Promise<WorktreeDiff> {
    return sshWorkspaceDiff.getWorkingTreeDiff(workspace);
  }

  getWorkingTreeDiffAgainstBranch(
    workspace: Workspace,
    branch: string,
    useMergeBase: boolean
  ): Promise<WorktreeDiff> {
    return sshWorkspaceDiff.getWorkingTreeDiffAgainstBranch(workspace, branch, useMergeBase);
  }

  getFullFileDiff(
    workspace: Workspace,
    filePath: string,
    staged: boolean
  ): Promise<FileDiffContent> {
    return sshWorkspaceDiff.getFullFileDiff(workspace, filePath, staged);
  }

  getFullFileDiffAgainstBranch(
    workspace: Workspace,
    filePath: string,
    branch: string,
    useMergeBase: boolean
  ): Promise<FileDiffContent> {
    return sshWorkspaceDiff.getFullFileDiffAgainstBranch(workspace, filePath, branch, useMergeBase);
  }

  fetchFromRemote(workspace: Workspace): Promise<WorkspaceGitResult> {
    return sshWorkspaceGit.fetchFromRemote(getSshBackend(workspace));
  }

  inspectCommitScope(workspace: Workspace): Promise<CommitScopeResult> {
    return sshWorkspaceGit.inspectCommitScope(getSshBackend(workspace));
  }

  generateCommitDraft(workspace: Workspace): Promise<CommitDraftResult> {
    return sshWorkspaceGit.generateCommitDraft(getSshBackend(workspace));
  }

  commitChanges(
    workspace: Workspace,
    input: WorkspaceGitCommitInput
  ): Promise<CommitChangesResult> {
    return sshWorkspaceGit.commitChanges(getSshBackend(workspace), input);
  }

  createBranch(workspace: Workspace, branchName: string, startPoint?: string): Promise<void> {
    return sshWorkspaceGit.createBranch(getSshBackend(workspace), branchName, startPoint);
  }

  switchBranch(workspace: Workspace, branchName: string): Promise<WorkspaceGitResult> {
    return sshWorkspaceGit.switchBranch(getSshBackend(workspace), branchName);
  }

  mergeFrom(
    workspace: Workspace,
    branchName: string,
    options?: WorkspaceGitMergeOptions
  ): Promise<WorkspaceGitResult> {
    const backend = getSshBackend(workspace);
    return sshWorkspaceGit.mergeFrom(backend, branchName, {
      ...options,
      targetBranch: getTargetBranch(workspace, backend),
    });
  }

  rebaseOnBranch(
    workspace: Workspace,
    branchName: string,
    options?: WorkspaceGitMergeOptions
  ): Promise<WorkspaceGitResult> {
    const backend = getSshBackend(workspace);
    return sshWorkspaceGit.rebaseOnBranch(backend, branchName, {
      ...options,
      targetBranch: getTargetBranch(workspace, backend),
    });
  }

  push(workspace: Workspace): Promise<WorkspaceGitPushResult> {
    return sshWorkspaceGit.push(getSshBackend(workspace));
  }

  pull(workspace: Workspace): Promise<WorkspaceGitResult> {
    return sshWorkspaceGit.pull(getSshBackend(workspace));
  }

  pushTargetBranch(workspace: Workspace): Promise<WorkspaceGitPushResult> {
    return sshWorkspaceGit.pushTargetBranch(getSshBackend(workspace));
  }

  pullTargetBranch(workspace: Workspace): Promise<WorkspaceGitResult> {
    return sshWorkspaceGit.pullTargetBranch(getSshBackend(workspace));
  }

  mergeTargetBranchFromRemote(workspace: Workspace): Promise<WorkspaceGitResult> {
    return sshWorkspaceGit.mergeTargetBranchFromRemote(getSshBackend(workspace));
  }

  mergeToTargetBranch(workspace: Workspace): Promise<WorkspaceGitResult> {
    return sshWorkspaceGit.mergeToTargetBranch(getSshBackend(workspace));
  }

  restoreFile(
    workspace: Workspace,
    filePath: string,
    status: string,
    oldPath?: string
  ): Promise<void> {
    return sshWorkspaceGit.restoreFile(getSshBackend(workspace), filePath, status, oldPath);
  }

  discardAllChanges(workspace: Workspace): Promise<WorkspaceGitResult> {
    return sshWorkspaceGit.discardAllChanges(getSshBackend(workspace));
  }
}

export const sshWorkspaceRepositoryAdapter = new SshWorkspaceRepositoryAdapter();
