import type {
  CommitChangesResult,
  CommitDraftResult,
  CommitScope,
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

export type WorkspaceGitResult = { success: boolean; message: string };
export type WorkspaceGitPushResult = WorkspaceGitResult & { errorCode?: 'rejected' };
export type WorkspaceGitMergeOptions = { stash?: boolean };
export type WorkspaceGitCommitInput = {
  subject: string;
  body?: string | null;
  scope: CommitScope;
};

export interface WorkspaceRepositoryAdapter {
  getBranchQuickStatus(workspace: Workspace): Promise<GitBranchQuickStatus>;
  listBranches(workspace: Workspace, includeRemote: boolean): Promise<BranchInfo[]>;
  getCommitGraph(workspace: Workspace, query: CommitGraphQuery): Promise<CommitGraph>;
  getCommitDiff(workspace: Workspace, commitHash: string): Promise<CommitDiff>;
  getCommitFileDiff(
    workspace: Workspace,
    commitHash: string,
    filePath: string
  ): Promise<FileDiffContent>;
  getWorkingTreeDiff(workspace: Workspace): Promise<WorktreeDiff>;
  getWorkingTreeDiffAgainstBranch(
    workspace: Workspace,
    branch: string,
    useMergeBase: boolean
  ): Promise<WorktreeDiff>;
  getFullFileDiff(
    workspace: Workspace,
    filePath: string,
    staged: boolean
  ): Promise<FileDiffContent>;
  getFullFileDiffAgainstBranch(
    workspace: Workspace,
    filePath: string,
    branch: string,
    useMergeBase: boolean
  ): Promise<FileDiffContent>;
  fetchFromRemote(workspace: Workspace): Promise<WorkspaceGitResult>;
  inspectCommitScope(workspace: Workspace): Promise<CommitScopeResult>;
  generateCommitDraft(workspace: Workspace): Promise<CommitDraftResult>;
  commitChanges(workspace: Workspace, input: WorkspaceGitCommitInput): Promise<CommitChangesResult>;
  createBranch(workspace: Workspace, branchName: string, startPoint?: string): Promise<void>;
  switchBranch(workspace: Workspace, branchName: string): Promise<WorkspaceGitResult>;
  mergeFrom(
    workspace: Workspace,
    branchName: string,
    options?: WorkspaceGitMergeOptions
  ): Promise<WorkspaceGitResult>;
  rebaseOnBranch(
    workspace: Workspace,
    branchName: string,
    options?: WorkspaceGitMergeOptions
  ): Promise<WorkspaceGitResult>;
  push(workspace: Workspace): Promise<WorkspaceGitPushResult>;
  pull(workspace: Workspace): Promise<WorkspaceGitResult>;
  pushTargetBranch(workspace: Workspace): Promise<WorkspaceGitPushResult>;
  pullTargetBranch(workspace: Workspace): Promise<WorkspaceGitResult>;
  mergeTargetBranchFromRemote(workspace: Workspace): Promise<WorkspaceGitResult>;
  mergeToTargetBranch(workspace: Workspace): Promise<WorkspaceGitResult>;
  restoreFile(
    workspace: Workspace,
    filePath: string,
    status: string,
    oldPath?: string
  ): Promise<void>;
  discardAllChanges(workspace: Workspace): Promise<WorkspaceGitResult>;
}
