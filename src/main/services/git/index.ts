import { gitBlameService } from './git-blame';
import { gitBranchService } from './git-branch';
import {
  gitBranchCleanupService,
  type GitBatchRunner,
  type WorktreeHead,
} from './git-branch-cleanup';
import { gitCommitService } from './git-commit';
import { gitDiffService } from './git-diff';
import { gitExec } from './git-exec';
import { gitHistoryService } from './git-history';
import { gitIdentityService } from './git-identity';
import { gitRepoService } from './git-repo';
import { gitWorktreeService } from './git-worktree';

import type { BlameHunk } from './git-blame';
import type { BranchInfo, GitBranchQuickStatus } from './git-branch';
import type { FileChange, WorktreeDiff, FileDiffContent } from './git-diff';
import type { GitProgressCallback, ManagedWorktree } from './git-exec';
import type { CommitDiff } from './git-history';
import type { RepoWebInfo } from './git-repo';
import type { CreatedWorktree, WorktreeInfo } from './git-worktree';
import type {
  CommitChangesResult,
  CommitDraftResult,
  CommitScope,
  CommitScopeResult,
} from '../../../shared/types';
import type { CommitGraph, CommitGraphQuery } from '../../../shared/types/commit-graph';
import type { GitIdentityStatus } from '../../../shared/types/git-identity';
import type { BranchDeletionResult, LeftoverBranches } from '../../../shared/types/project';

// Re-export all interfaces/types
export type { GitProgressCallback, ManagedWorktree } from './git-exec';
export type { CreatedWorktree, WorktreeInfo } from './git-worktree';
export type { FileChange, WorktreeDiff, FileDiffContent } from './git-diff';
export type { BranchInfo, GitBranchQuickStatus } from './git-branch';
export type { CommitInfo, CommitDiff } from './git-history';
export type { BlameHunk } from './git-blame';
export type { RepoWebInfo } from './git-repo';

class GitService {
  inspectCommitScope(worktreePath: string): Promise<CommitScopeResult> {
    return gitCommitService.inspectScope(worktreePath);
  }
  generateCommitDraft(worktreePath: string, scope?: CommitScope): Promise<CommitDraftResult> {
    return gitCommitService.generateDraft(worktreePath, scope);
  }
  commitChanges(
    worktreePath: string,
    input: { subject: string; body?: string | null; scope: CommitScope }
  ): Promise<CommitChangesResult> {
    return gitCommitService.commit(worktreePath, input);
  }
  // --- GitExec delegates ---
  registerTargetBranch(worktreePath: string, baseBranch?: string): void {
    return gitExec.registerTargetBranch(worktreePath, baseBranch);
  }
  setManagedWorktreeLookup(lookup: (path: string) => ManagedWorktree | undefined): void {
    return gitExec.setManagedWorktreeLookup(lookup);
  }
  getTargetBranch(worktreePath: string): Promise<string> {
    return gitExec.getTargetBranch(worktreePath);
  }
  getCurrentBranch(path: string): Promise<string> {
    return gitExec.getCurrentBranch(path);
  }
  getCheckedOutBranch(path: string): Promise<string | undefined> {
    return gitExec.getCheckedOutBranch(path);
  }
  getMainBranch(repoPath: string): Promise<string> {
    return gitExec.getMainBranch(repoPath);
  }
  hasUncommittedChanges(path: string): Promise<boolean> {
    return gitExec.hasUncommittedChanges(path);
  }
  isGitRepo(path: string): Promise<boolean> {
    return gitExec.isGitRepo(path);
  }
  getCommonGitDir(path: string): Promise<string> {
    return gitExec.getCommonGitDir(path);
  }
  getRepoRoot(path: string): Promise<string> {
    return gitExec.getRepoRoot(path);
  }
  resolvePublishedCommit(repoPath: string, revision: string): Promise<string> {
    return gitExec.resolvePublishedCommit(repoPath, revision);
  }
  invalidateBranchCache(path: string): void {
    gitExec.invalidateCache(`currentBranch:${path}`);
    gitExec.invalidateCache(`hasUncommittedChanges:${path}`);
  }
  hasRemote(repoPath: string, name: string): Promise<boolean> {
    return gitExec.hasRemote(repoPath, name);
  }
  hasRemoteTrackingBranch(worktreePath: string): Promise<boolean> {
    return gitExec.hasRemoteTrackingBranch(worktreePath);
  }
  getUnpushedCommits(worktreePath: string): Promise<number> {
    return gitExec.getUnpushedCommits(worktreePath);
  }
  getCommitsBehindRemote(worktreePath: string): Promise<number> {
    return gitExec.getCommitsBehindRemote(worktreePath);
  }
  getAheadBehind(
    repoPath: string,
    branch: string,
    baseBranch: string
  ): Promise<{ ahead: number; behind: number }> {
    return gitExec.getAheadBehind(repoPath, branch, baseBranch);
  }

  // --- GitWorktreeService delegates ---
  createWorktree(
    repoPath: string,
    branchName: string,
    worktreeDestination?: string,
    baseBranch?: string,
    options?: { fetchRemote?: boolean }
  ): Promise<CreatedWorktree> {
    return gitWorktreeService.createWorktree(
      repoPath,
      branchName,
      worktreeDestination,
      baseBranch,
      options
    );
  }
  deleteWorktree(
    repoPath: string,
    worktreePath: string,
    force?: boolean,
    options?: { deleteBranch?: boolean; branchName?: string }
  ): Promise<void> {
    return gitWorktreeService.deleteWorktree(repoPath, worktreePath, force, options);
  }
  listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    return gitWorktreeService.listWorktrees(repoPath);
  }

  // --- GitBranchCleanupService delegates ---
  listLeftoverBranches(
    repo: GitBatchRunner,
    targetBranch: string,
    keep: ReadonlySet<string>,
    options?: { skipBranchesOnOrigin?: boolean }
  ): Promise<LeftoverBranches> {
    return gitBranchCleanupService.listLeftoverBranches(repo, targetBranch, keep, options);
  }
  deleteLeftoverBranches(
    repo: GitBatchRunner,
    branches: ReadonlyArray<{ name: string; commit: string }>,
    keep: ReadonlySet<string>
  ): Promise<BranchDeletionResult> {
    return gitBranchCleanupService.deleteBranches(repo, branches, keep);
  }
  readWorktreeForCleanup(worktree: GitBatchRunner): Promise<WorktreeHead> {
    return gitBranchCleanupService.readWorktree(worktree);
  }
  findLandedCommits(
    repo: GitBatchRunner,
    targetBranch: string,
    commits: readonly string[]
  ): Promise<boolean[]> {
    return gitBranchCleanupService.findLandedCommits(repo, targetBranch, commits);
  }

  // --- GitDiffService delegates ---
  getChangedFiles(worktreePath: string): Promise<FileChange[]> {
    return gitDiffService.getChangedFiles(worktreePath);
  }
  getWorkingTreeDiff(worktreePath: string): Promise<WorktreeDiff> {
    return gitDiffService.getWorkingTreeDiff(worktreePath);
  }
  getWorkingTreeDiffAgainstBranch(
    worktreePath: string,
    branch: string,
    useMergeBase = false
  ): Promise<WorktreeDiff> {
    return gitDiffService.getWorkingTreeDiffAgainstBranch(worktreePath, branch, useMergeBase);
  }
  getFullFileDiff(
    worktreePath: string,
    filePath: string,
    staged?: boolean
  ): Promise<FileDiffContent> {
    return gitDiffService.getFullFileDiff(worktreePath, filePath, staged);
  }
  getFullFileDiffAgainstBranch(
    worktreePath: string,
    filePath: string,
    branch: string,
    useMergeBase = false
  ): Promise<FileDiffContent> {
    return gitDiffService.getFullFileDiffAgainstBranch(
      worktreePath,
      filePath,
      branch,
      useMergeBase
    );
  }
  getChangedFilesWithSummary(worktreePath: string): Promise<{
    files: FileChange[];
    summary: { additions: number; deletions: number; filesChanged: number };
  }> {
    return gitDiffService.getChangedFilesWithSummary(worktreePath);
  }
  getActivityFingerprint(worktreePath: string): Promise<string> {
    return gitDiffService.getActivityFingerprint(worktreePath);
  }

  // --- GitBranchService delegates ---
  createBranch(repoPath: string, branchName: string, startPoint?: string): Promise<void> {
    return gitBranchService.createBranch(repoPath, branchName, startPoint);
  }
  resolveStartRef(repoPath: string, branchName: string): Promise<string> {
    return gitBranchService.resolveStartRef(repoPath, branchName);
  }
  fastForwardBranchToRemoteIfSafe(repoPath: string, branchName: string): Promise<boolean> {
    return gitBranchService.fastForwardBranchToRemoteIfSafe(repoPath, branchName);
  }
  listBranches(repoPath: string, includeRemote?: boolean): Promise<BranchInfo[]> {
    return gitBranchService.listBranches(repoPath, includeRemote);
  }
  switchBranch(
    worktreePath: string,
    branchName: string
  ): Promise<{ success: boolean; message: string }> {
    return gitBranchService.switchBranch(worktreePath, branchName);
  }
  deleteBranch(
    worktreePath: string,
    branchName: string,
    force?: boolean
  ): Promise<{ success: boolean; message: string }> {
    return gitBranchService.deleteBranch(worktreePath, branchName, force);
  }
  deleteRemoteBranch(
    worktreePath: string,
    branchName: string
  ): Promise<{ success: boolean; message: string }> {
    return gitBranchService.deleteRemoteBranch(worktreePath, branchName);
  }
  mergeBranch(repoPath: string, branchName: string): Promise<void> {
    return gitBranchService.mergeBranch(repoPath, branchName);
  }
  mergeFrom(
    worktreePath: string,
    branchName: string,
    options?: { stash?: boolean }
  ): Promise<{ success: boolean; message: string }> {
    return gitBranchService.mergeFrom(worktreePath, branchName, options);
  }
  mergeToTargetBranch(worktreePath: string): Promise<{ success: boolean; message: string }> {
    return gitBranchService.mergeToTargetBranch(worktreePath);
  }
  mergeTargetBranchFromRemote(
    worktreePath: string,
    onProgress?: GitProgressCallback
  ): Promise<{ success: boolean; message: string }> {
    return gitBranchService.mergeTargetBranchFromRemote(worktreePath, onProgress);
  }
  rebaseOnTargetBranch(
    worktreePath: string,
    options?: { stash?: boolean }
  ): Promise<{ success: boolean; message: string }> {
    return gitBranchService.rebaseOnTargetBranch(worktreePath, options);
  }
  rebaseOnBranch(
    worktreePath: string,
    branchName: string,
    options?: { stash?: boolean }
  ): Promise<{ success: boolean; message: string }> {
    return gitBranchService.rebaseOnBranch(worktreePath, branchName, options);
  }
  abortRebase(worktreePath: string): Promise<{ success: boolean; message: string }> {
    return gitBranchService.abortRebase(worktreePath);
  }
  push(
    worktreePath: string,
    onProgress?: GitProgressCallback
  ): Promise<{ success: boolean; message: string }> {
    return gitBranchService.push(worktreePath, onProgress);
  }
  pushTargetBranch(
    worktreePath: string,
    onProgress?: GitProgressCallback
  ): Promise<{ success: boolean; message: string }> {
    return gitBranchService.pushTargetBranch(worktreePath, onProgress);
  }
  pull(
    worktreePath: string,
    onProgress?: GitProgressCallback
  ): Promise<{ success: boolean; message: string }> {
    return gitBranchService.pull(worktreePath, onProgress);
  }
  pullRebase(
    worktreePath: string,
    onProgress?: GitProgressCallback
  ): Promise<{ success: boolean; message: string }> {
    return gitBranchService.pullRebase(worktreePath, onProgress);
  }
  pullTargetBranch(
    worktreePath: string,
    onProgress?: GitProgressCallback
  ): Promise<{ success: boolean; message: string }> {
    return gitBranchService.pullTargetBranch(worktreePath, onProgress);
  }
  fetchFromRemote(
    repoPath: string,
    onProgress?: GitProgressCallback
  ): Promise<{ success: boolean; message: string }> {
    return gitBranchService.fetchFromRemote(repoPath, onProgress);
  }
  fetchAllBranches(repoPath: string, remoteName: string): Promise<void> {
    return gitBranchService.fetchAllBranches(repoPath, remoteName);
  }
  fetchOriginWithoutPrompts(
    repoPath: string,
    managed: boolean,
    timeoutMs: number,
    mark: number
  ): Promise<void> {
    return gitBranchService.fetchOriginWithoutPrompts(repoPath, managed, timeoutMs, mark);
  }
  stopBackgroundWork(repoPath: string): void {
    gitExec.stopBackgroundWork(repoPath);
  }
  backgroundMark(repoPath: string): number {
    return gitExec.backgroundMark(repoPath);
  }
  fetchOriginStartPoint(repoPath: string, branchName: string): Promise<string | undefined> {
    return gitBranchService.fetchOriginStartPoint(repoPath, branchName);
  }
  pushToRemote(repoPath: string, remoteName: string, branchName: string): Promise<void> {
    return gitBranchService.pushToRemote(repoPath, remoteName, branchName);
  }
  pushBranchesMissingFromOrigin(repoPath: string, branches: string[]): Promise<string[]> {
    return gitBranchService.pushBranchesMissingFromOrigin(repoPath, branches);
  }
  removeOriginWithoutBranches(repoPath: string): Promise<boolean> {
    return gitRepoService.removeOriginWithoutBranches(repoPath);
  }
  getCommitsBehindTargetBranch(worktreePath: string): Promise<number> {
    return gitBranchService.getCommitsBehindTargetBranch(worktreePath);
  }
  getCommitsAheadTargetBranch(worktreePath: string): Promise<number> {
    return gitBranchService.getCommitsAheadTargetBranch(worktreePath);
  }
  getTargetBranchRemoteStatus(worktreePath: string): Promise<{ ahead: number; behind: number }> {
    return gitBranchService.getTargetBranchRemoteStatus(worktreePath);
  }
  getBranchQuickStatus(worktreePath: string): Promise<GitBranchQuickStatus> {
    return gitBranchService.getBranchQuickStatus(worktreePath);
  }
  getBranchUrl(worktreePath: string): Promise<string | null> {
    return gitBranchService.getBranchUrl(worktreePath);
  }
  getCreatePrUrl(worktreePath: string): Promise<string | null> {
    return gitBranchService.getCreatePrUrl(worktreePath);
  }

  // --- GitBlameService delegates ---
  getBlame(worktreePath: string, filePath: string, commitHash?: string): Promise<BlameHunk[]> {
    return gitBlameService.getBlame(worktreePath, filePath, commitHash);
  }

  // --- GitHistoryService delegates ---
  getCommitGraph(worktreePath: string, query: CommitGraphQuery): Promise<CommitGraph> {
    return gitHistoryService.getCommitGraph(worktreePath, query);
  }
  getCommitDiff(worktreePath: string, commitHash: string): Promise<CommitDiff> {
    return gitHistoryService.getCommitDiff(worktreePath, commitHash);
  }
  getCommitFileDiff(
    worktreePath: string,
    commitHash: string,
    filePath: string
  ): Promise<FileDiffContent> {
    return gitHistoryService.getCommitFileDiff(worktreePath, commitHash, filePath);
  }

  // --- GitRepoService delegates ---
  cloneBare(sourcePath: string, destinationPath: string): Promise<void> {
    return gitRepoService.cloneBare(sourcePath, destinationPath);
  }
  cloneBareFromRemote(
    url: string,
    destinationPath: string,
    onProgress?: GitProgressCallback
  ): Promise<void> {
    return gitRepoService.cloneBareFromRemote(url, destinationPath, onProgress);
  }
  cloneFromRemote(
    url: string,
    destinationPath: string,
    onProgress?: GitProgressCallback
  ): Promise<void> {
    return gitRepoService.cloneFromRemote(url, destinationPath, onProgress);
  }
  initRepo(path: string): Promise<void> {
    return gitRepoService.initRepo(path);
  }
  initBareRepo(path: string): Promise<void> {
    return gitRepoService.initBareRepo(path);
  }
  addRemote(repoPath: string, name: string, url: string): Promise<void> {
    return gitRepoService.addRemote(repoPath, name, url);
  }
  setOriginRemote(repoPath: string, url: string): Promise<void> {
    return gitRepoService.setOriginRemote(repoPath, url);
  }
  removeRemote(repoPath: string, name: string): Promise<void> {
    return gitRepoService.removeRemote(repoPath, name);
  }
  isBareRepo(path: string): Promise<boolean> {
    return gitRepoService.isBareRepo(path);
  }
  getRepoName(path: string): Promise<string> {
    return gitRepoService.getRepoName(path);
  }
  getRemoteUrl(repoPath: string): Promise<string | null> {
    return gitRepoService.getRemoteUrl(repoPath);
  }
  getRemoteUrlByName(repoPath: string, remoteName: string): Promise<string | null> {
    return gitRepoService.getRemoteUrlByName(repoPath, remoteName);
  }
  getRepoWebInfo(repoPath: string): Promise<RepoWebInfo> {
    return gitRepoService.getRepoWebInfo(repoPath);
  }
  validateRemoteUrl(url: string): Promise<{ valid: boolean; error?: string }> {
    return gitRepoService.validateRemoteUrl(url);
  }
  getIdentityStatus(): Promise<GitIdentityStatus> {
    return gitIdentityService.getStatus();
  }
  setGlobalIdentity(userName: string, userEmail: string): Promise<void> {
    return gitIdentityService.setGlobal(userName, userEmail);
  }
  listFiles(
    dirPath: string,
    includeGitIgnored?: boolean
  ): Promise<{ files: string[]; gitIgnoredFiles: string[]; emptyDirs: string[] }> {
    return gitRepoService.listFiles(dirPath, includeGitIgnored);
  }
  listIgnoredDirectories(dirPath: string): Promise<string[]> {
    return gitRepoService.listIgnoredDirectories(dirPath);
  }
  readFileContent(dirPath: string, filePath: string): Promise<string> {
    return gitRepoService.readFileContent(dirPath, filePath);
  }
  readImageFileContent(
    dirPath: string,
    filePath: string
  ): Promise<{ data: string; mimeType: string }> {
    return gitRepoService.readImageFileContent(dirPath, filePath);
  }
  readMediaFileContent(
    dirPath: string,
    filePath: string
  ): Promise<{ data: string; mimeType: string; kind: 'audio' | 'video' }> {
    return gitRepoService.readMediaFileContent(dirPath, filePath);
  }
  getMediaFileMetadata(
    dirPath: string,
    filePath: string
  ): Promise<{ mimeType: string; kind: 'audio' | 'video'; size: number; mtimeMs: number }> {
    return gitRepoService.getMediaFileMetadata(dirPath, filePath);
  }
  fileExists(dirPath: string, filePath: string): Promise<boolean> {
    return gitRepoService.fileExists(dirPath, filePath);
  }
  getFileMetadata(dirPath: string, filePath: string): Promise<{ size: number; mtimeMs: number }> {
    return gitRepoService.getFileMetadata(dirPath, filePath);
  }
  copyFile(workingDir: string, src: string, dest: string): Promise<void> {
    return gitRepoService.copyFile(workingDir, src, dest);
  }
  copyDirectory(workingDir: string, src: string, dest: string): Promise<void> {
    return gitRepoService.copyDirectory(workingDir, src, dest);
  }
  importExternalFile(
    workingDir: string,
    sourcePath: string,
    preferredName?: string
  ): Promise<string> {
    return gitRepoService.importExternalFile(workingDir, sourcePath, preferredName);
  }
  deleteFile(worktreePath: string, filePath: string, status: string): Promise<void> {
    return gitRepoService.deleteFile(worktreePath, filePath, status);
  }
  renameFile(worktreePath: string, oldPath: string, newPath: string): void {
    return gitRepoService.renameFile(worktreePath, oldPath, newPath);
  }
  writeFile(worktreePath: string, filePath: string, content: string): Promise<void> {
    return gitRepoService.writeFile(worktreePath, filePath, content);
  }
  createDirectory(worktreePath: string, dirPath: string): void {
    return gitRepoService.createDirectory(worktreePath, dirPath);
  }
  restoreFile(
    worktreePath: string,
    filePath: string,
    status: string,
    oldPath?: string
  ): Promise<void> {
    return gitRepoService.restoreFile(worktreePath, filePath, status, oldPath);
  }
  discardAllChanges(worktreePath: string): Promise<{ success: boolean; message: string }> {
    return gitRepoService.discardAllChanges(worktreePath);
  }
}

export const gitService = new GitService();
