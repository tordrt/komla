import { mkdtemp, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { UNCOMMITTED_CHANGES_PREFIX } from '../../../shared/constants/git';
import { createLogger } from '../../lib/logger';

import {
  gitExec,
  activeConflictMessage,
  extractGitError,
  GitProgressCallback,
  NO_PROMPT_CONFIG_KEYS,
} from './git-exec';
import { gitWorktreeService } from './git-worktree';

import type {
  GitSavedChangesRecovery,
  GitSyncOutcome,
  GitSyncResult,
} from '../../../shared/types/git-sync';

const logger = createLogger('GitBranch');

/** How long a fetch of origin lets new worktrees start from its copy without fetching again. */
export const RECENT_ORIGIN_FETCH_MS = 10 * 60_000;

/** Stands for every one of origin's branches among the branches a fetch brought. */
const EVERY_BRANCH = '*';

/**
 * Refspecs that fetch just these branches of origin. Each is a pattern, `<branch>*`, so a branch
 * origin doesn't have, or no longer has, is no error and `--prune` removes only its copy; the
 * pattern also brings any branch whose name starts with it.
 */
export function originBranchRefspecs(branches: readonly string[]): string[] {
  return branches.map((branch) => `+refs/heads/${branch}*:refs/remotes/origin/${branch}*`);
}

/**
 * Origin's copy of a branch as a worktree's start point: available, missing as of the last
 * fetch, or behind the local branch, which has commits origin's copy lacks.
 */
export type OriginStartPoint =
  | { status: 'available'; ref: string }
  | { status: 'missing' }
  | { status: 'behind-local' };

// `git stash create` builds a stash commit for tracked changes without touching
// the shared refs/stash reflog — critical in bare-repo worktree setups where all
// worktrees share a single stash reflog. The returned SHA is private; we apply
// it directly. `reset --hard HEAD` then cleans tracked files so the op can
// proceed. Untracked files are left alone (they don't affect merge/rebase and
// survive `reset --hard`, so they don't need to be stashed).
async function createStashAndReset(worktreePath: string): Promise<string | undefined> {
  const stashSha = (await gitExec.execGitAsync(worktreePath, ['stash', 'create'])).trim();
  if (!stashSha) return undefined;
  await gitExec.execGitAsync(worktreePath, ['reset', '--hard', 'HEAD']);
  return stashSha;
}

async function safeExec(worktreePath: string, args: string[]): Promise<boolean> {
  try {
    await gitExec.execGitAsync(worktreePath, args);
    return true;
  } catch {
    return false;
  }
}

type StashRestoreResult = 'applied' | 'stored' | 'store-failed';
type OperationState = 'active' | 'inactive' | 'unknown';
type ConflictInspection = { status: 'ok'; files: string[] } | { status: 'error'; error: unknown };
/** Where a local branch stands against its fetched origin ref after a fast-forward attempt. */
type RemoteBranchSync =
  | 'no-remote' // origin has no such branch
  | 'no-local' // only origin has the branch
  | 'current' // the local branch is not strictly behind origin's
  | 'fast-forwarded' // the local branch now matches origin's
  | 'blocked'; // the local branch is strictly behind but could not be moved safely

async function storeStashForRecovery(
  worktreePath: string,
  stashSha: string,
  storeMessage: string
): Promise<boolean> {
  return safeExec(worktreePath, ['stash', 'store', '-m', storeMessage, stashSha]);
}

async function applyStashOrStore(
  worktreePath: string,
  stashSha: string,
  storeMessage: string
): Promise<StashRestoreResult> {
  try {
    await gitExec.execGitAsync(worktreePath, ['stash', 'apply', stashSha]);
    return 'applied';
  } catch {
    const stored = await storeStashForRecovery(worktreePath, stashSha, storeMessage);
    return stored ? 'stored' : 'store-failed';
  }
}

const UNMERGED_STATUS_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function parseConflictedFiles(status: string): string[] {
  return status
    .split('\n')
    .filter((line) => UNMERGED_STATUS_CODES.has(line.slice(0, 2)))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

async function inspectConflicts(worktreePath: string): Promise<ConflictInspection> {
  try {
    const status = await gitExec.execGitAsync(worktreePath, ['status', '--porcelain']);
    return { status: 'ok', files: parseConflictedFiles(status) };
  } catch (error) {
    return { status: 'error', error };
  }
}

async function statGitPath(worktreePath: string, gitPath: string): Promise<OperationState> {
  try {
    await stat(path.isAbsolute(gitPath) ? gitPath : path.resolve(worktreePath, gitPath));
    return 'active';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'inactive' : 'unknown';
  }
}

/** Resolves all the paths with one `rev-parse`, since branch status checks run often. */
async function getPathStates(
  worktreePath: string,
  gitPathNames: string[]
): Promise<OperationState[]> {
  let gitPaths: string[];
  try {
    const output = await gitExec.execGitAsync(worktreePath, [
      'rev-parse',
      ...gitPathNames.flatMap((name) => ['--git-path', name]),
    ]);
    gitPaths = output.split(/\r?\n/);
  } catch {
    return gitPathNames.map(() => 'unknown');
  }
  if (gitPaths.length !== gitPathNames.length) return gitPathNames.map(() => 'unknown');

  return Promise.all(gitPaths.map((gitPath) => statGitPath(worktreePath, gitPath)));
}

async function getOperationState(
  worktreePath: string,
  operation: 'merge' | 'rebase'
): Promise<OperationState> {
  if (operation === 'merge') {
    const [mergeHeadState] = await getPathStates(worktreePath, ['MERGE_HEAD']);
    return mergeHeadState;
  }

  const [mergeBackendState, applyBackendState, amState] = await getPathStates(worktreePath, [
    'rebase-merge',
    'rebase-apply',
    // `git am` also keeps its session in rebase-apply, marked by this file.
    'rebase-apply/applying',
  ]);
  if (mergeBackendState === 'active') return 'active';
  if (applyBackendState === 'active' && amState === 'inactive') return 'active';
  if (mergeBackendState === 'unknown' || applyBackendState === 'unknown') return 'unknown';
  if (applyBackendState === 'active' && amState === 'unknown') return 'unknown';
  return 'inactive';
}

function restoredAfterAbortMessage(operation: string): string {
  return `${operation} failed and was aborted. The branch and saved local changes were restored.`;
}

function hiddenWorktreeConflictMessage(operation: string): string {
  return `${operation} encountered conflicts outside the active workspace and was aborted.`;
}

function unmergedConflictMessage(operation: string, branch: string, files: string[]): string {
  return `${operation} would conflict in ${files.join(', ')}. ${branch} was left unchanged; check it out to merge and resolve the conflicts.`;
}

function abortFailedMessage(operation: string, worktreePath: string, error: unknown): string {
  return `${operation} encountered conflicts in ${worktreePath} and could not be aborted: ${extractGitError(error, 'Git abort failed')}. The conflicted operation is still active there. Inspect that worktree and resolve or abort the operation.`;
}

function stashRecoveryMessage(
  completedOperation: string,
  stashSha: string,
  stored: boolean
): string {
  if (!stored) {
    return `${completedOperation}, but your saved local changes could not be restored cleanly, and Git could not save a recovery copy in git stash. The temporary recovery commit is ${stashSha}. Preserve and restore that commit before Git prunes it.`;
  }
  return `${completedOperation}, but your saved local changes could not be restored cleanly. Resolve the current conflicts before continuing; a recovery copy was saved in git stash.`;
}

function abortFailedWithStashMessage(operation: string, stashSha: string, stored: boolean): string {
  const recovery = stored
    ? 'Your saved local changes were not reapplied; a recovery copy was saved in git stash.'
    : `Git also could not save a recovery copy in git stash. The temporary recovery commit is ${stashSha}; preserve it before Git prunes it.`;
  return `${operation} encountered conflicts and could not be aborted. The conflicted operation is still active. ${recovery} Inspect the workspace, resolve or abort the operation, and restore the saved changes.`;
}

function abortStateUnknownWithStashMessage(
  operation: string,
  abortOperation: 'merge' | 'rebase',
  stashSha: string,
  stored: boolean
): string {
  const recovery = stored
    ? 'Your saved local changes were not reapplied; a recovery copy was saved in git stash.'
    : `Git also could not save a recovery copy in git stash. The temporary recovery commit is ${stashSha}; preserve it before Git prunes it.`;
  return `${operation} could not be aborted, and Komla could not verify whether the ${abortOperation} is still active. ${recovery} Inspect the workspace, resolve or abort any active operation, and restore the saved changes.`;
}

function unverifiedOperationMessage(
  operation: string,
  worktreePath: string,
  operationError: unknown,
  inspectionError: unknown
): string {
  const failure = extractGitError(operationError, `${operation} failed`);
  const inspectionFailure = extractGitError(inspectionError, 'Git status failed');
  return `${failure}. Komla could not verify whether Git left an operation active in ${worktreePath}: ${inspectionFailure}. Inspect the workspace before continuing.`;
}

/** A sync result, which succeeded only if the operation finished with nothing left to recover. */
function syncResult(outcome: GitSyncOutcome, message: string): GitSyncResult {
  return { success: outcome.kind === 'completed', message, outcome };
}

function savedChangesRecovery(stashSha: string, stored: boolean): GitSavedChangesRecovery {
  return { status: stored ? 'stored' : 'store-failed', stashSha };
}

/** What differs between the merge and the rebase that bring another branch into a workspace. */
const SYNC_OPERATIONS = {
  merge: {
    name: 'Merge',
    blockedAction: 'merging',
    storeMessage: 'komla-auto-stash-before-merge',
    completion: 'complete the merge',
    upToDateOutput: 'Already up to date',
    pausedLabel: () => 'Merge',
    completed: (branch: string) => `Merged ${branch}`,
  },
  rebase: {
    name: 'Rebase',
    blockedAction: 'rebasing',
    storeMessage: 'komla-auto-stash-before-rebase',
    completion: 'continue the rebase',
    upToDateOutput: 'is up to date',
    pausedLabel: (branch: string) => `Rebase onto ${branch}`,
    completed: (branch: string) => `Rebased on ${branch}`,
  },
} as const;

type SyncOperation = keyof typeof SYNC_OPERATIONS;

/**
 * Aborts a merge or rebase that failed after Komla saved the workspace's changes, and puts
 * them back unless the operation is, or may be, still active.
 */
async function recoverStashAfterFailedOperation(
  worktreePath: string,
  stashSha: string,
  abortOperation: SyncOperation,
  operationError: unknown
): Promise<GitSyncResult> {
  const { name: operation, storeMessage } = SYNC_OPERATIONS[abortOperation];
  try {
    await gitExec.execGitAsync(worktreePath, [abortOperation, '--abort']);
  } catch {
    const operationState = await getOperationState(worktreePath, abortOperation);
    gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);

    if (operationState === 'inactive') {
      const stashResult = await applyStashOrStore(worktreePath, stashSha, storeMessage);
      const failure = extractGitError(operationError, `${operation} failed`);
      if (stashResult === 'applied') {
        return syncResult(
          { kind: 'failed' },
          `${failure}. Your saved local changes were restored.`
        );
      }
      const stored = stashResult === 'stored';
      return syncResult(
        { kind: 'failed', recovery: savedChangesRecovery(stashSha, stored) },
        stashRecoveryMessage(`${failure}. The ${abortOperation} did not start`, stashSha, stored)
      );
    }

    const stored = await storeStashForRecovery(worktreePath, stashSha, storeMessage);
    return syncResult(
      {
        kind: 'abort-failed',
        operationState,
        recovery: savedChangesRecovery(stashSha, stored),
      },
      operationState === 'active'
        ? abortFailedWithStashMessage(operation, stashSha, stored)
        : abortStateUnknownWithStashMessage(operation, abortOperation, stashSha, stored)
    );
  }

  const stashResult = await applyStashOrStore(worktreePath, stashSha, storeMessage);
  gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);
  if (stashResult === 'applied') {
    return syncResult({ kind: 'aborted' }, restoredAfterAbortMessage(operation));
  }
  const stored = stashResult === 'stored';
  return syncResult(
    { kind: 'aborted', recovery: savedChangesRecovery(stashSha, stored) },
    stashRecoveryMessage(`${operation} was aborted`, stashSha, stored)
  );
}

/**
 * How a merge, rebase or pull that failed with no saved changes left the workspace: with
 * conflicts active for the user to resolve, in a state Komla could not inspect, or with nothing
 * active. `operation` is what a pause would be completed as, and `label` names it in messages.
 */
async function inspectFailedOperation(
  worktreePath: string,
  operation: SyncOperation,
  label: string,
  operationError: unknown,
  fallback: string
): Promise<GitSyncResult> {
  const inspection = await inspectConflicts(worktreePath);
  if (inspection.status === 'error') {
    gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);
    return syncResult(
      { kind: 'unverified' },
      unverifiedOperationMessage(label, worktreePath, operationError, inspection.error)
    );
  }
  if (inspection.files.length > 0) {
    // A paused rebase leaves HEAD detached.
    if (operation === 'rebase') gitExec.invalidateCache(`currentBranch:${worktreePath}`);
    gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);
    return syncResult(
      { kind: 'conflicts', files: inspection.files },
      activeConflictMessage(label, inspection.files, SYNC_OPERATIONS[operation].completion)
    );
  }
  return syncResult({ kind: 'failed' }, extractGitError(operationError, fallback));
}

export interface BranchInfo {
  name: string;
  isRemoteOnly: boolean;
  /** A remote branch's ref with its remote's name, such as `upstream/main`. */
  remoteRef?: string;
}

export interface GitBranchQuickStatus {
  behindTargetBranch: number;
  aheadTargetBranch: number;
  mainBranch: string;
  defaultBranch: string;
  /** The branch origin/HEAD names, when the repository records one. */
  remoteDefaultBranch?: string;
  hasRemote: boolean;
  hasOriginRemote: boolean;
  unpushedCommits: number;
  behindRemote: number;
  currentBranch: string;
  targetBranchHasRemote: boolean;
  targetBranchAheadRemote: number;
  targetBranchBehindRemote: number;
  /** Git stopped mid-rebase (usually on conflicts) and is waiting to continue or abort. */
  rebaseInProgress?: boolean;
}

class GitBranchService {
  // Request coalescing: if an operation is already in-flight for a path, reuse its promise
  private inFlightBranchStatus = new Map<string, Promise<GitBranchQuickStatus>>();
  private inFlightSafeFastForwards = new Map<string, Promise<RemoteBranchSync>>();
  // When each branch, or EVERY_BRANCH, was last fetched from origin, per repository.
  private originFetchedAt = new Map<string, Map<string, number>>();

  /**
   * Create a new local branch from a starting point (defaults to HEAD), without tracking it
   */
  async createBranch(repoPath: string, branchName: string, startPoint?: string): Promise<void> {
    const args = startPoint
      ? ['branch', '--no-track', '--', branchName, startPoint]
      : ['branch', '--', branchName];
    await gitExec.execGitAsync(repoPath, args);
  }

  /**
   * Fast-forward a local branch to its already-fetched origin ref when doing so
   * cannot discard commits or overwrite a dirty checked-out worktree.
   */
  async fastForwardBranchToRemoteIfSafe(repoPath: string, branchName: string): Promise<boolean> {
    return (await this.syncBranchWithRemote(repoPath, branchName)) === 'fast-forwarded';
  }

  /**
   * Like fastForwardBranchToRemoteIfSafe, but reports where the branch stands against
   * origin's when it was not moved.
   */
  syncBranchWithRemote(repoPath: string, branchName: string): Promise<RemoteBranchSync> {
    const key = `${repoPath}\0${branchName}`;
    const existing = this.inFlightSafeFastForwards.get(key);
    if (existing) return existing;

    const operation = this.runSafeBranchFastForward(repoPath, branchName).finally(() => {
      if (this.inFlightSafeFastForwards.get(key) === operation) {
        this.inFlightSafeFastForwards.delete(key);
      }
    });
    this.inFlightSafeFastForwards.set(key, operation);
    return operation;
  }

  private async runSafeBranchFastForward(
    repoPath: string,
    branchName: string
  ): Promise<RemoteBranchSync> {
    const localRef = `refs/heads/${branchName}`;
    const remoteRef = `refs/remotes/origin/${branchName}`;
    const readCommit = (ref: string) =>
      gitExec.execGitAsync(repoPath, ['rev-parse', '--verify', ref]).then(
        (commit) => commit.trim(),
        () => ''
      );
    const [localCommit, remoteCommit] = await Promise.all([
      readCommit(localRef),
      readCommit(remoteRef),
    ]);
    if (!remoteCommit) return 'no-remote';
    if (!localCommit) return 'no-local';
    const { ahead, behind } = await gitExec.getAheadBehind(repoPath, localCommit, remoteCommit);
    if (ahead !== 0 || behind === 0) return 'current';

    try {
      const result = await gitWorktreeService.fastForwardBranch(repoPath, branchName, remoteCommit);
      return result.status === 'fast-forwarded' ? 'fast-forwarded' : 'blocked';
    } catch (error) {
      logger.warn('Skipped automatic target branch fast-forward', {
        branchName,
        error: (error as Error).message,
      });
      return 'blocked';
    }
  }

  /**
   * The ref to rebase onto or merge from for `branchName`. Like the behind count, the
   * target branch resolves to its fetched ref when the local one is missing, or is
   * strictly behind it and cannot be fast-forwarded safely.
   */
  private async resolveUpdateRef(worktreePath: string, branchName: string): Promise<string> {
    if (branchName !== (await gitExec.getTargetBranch(worktreePath))) return branchName;
    return this.resolveStartRef(worktreePath, branchName);
  }

  /**
   * `branchName`, or its fetched ref when the local branch is missing, or is strictly behind it
   * and cannot be fast-forwarded safely.
   */
  async resolveStartRef(repoPath: string, branchName: string): Promise<string> {
    const sync = await this.syncBranchWithRemote(repoPath, branchName);
    return sync === 'no-local' || sync === 'blocked' ? `origin/${branchName}` : branchName;
  }

  async listBranches(repoPath: string, includeRemote = false): Promise<BranchInfo[]> {
    try {
      // List all local branches, sorted by most recent commit
      const localOutput = await gitExec.execGitAsync(repoPath, [
        'branch',
        '--sort=-committerdate',
        '--format=%(refname:short)',
      ]);
      const localBranches = localOutput.split('\n').filter(Boolean);
      const localBranchInfos: BranchInfo[] = localBranches.map((name) => ({
        name,
        isRemoteOnly: false,
      }));

      if (!includeRemote) {
        return localBranchInfos;
      }

      // Also list remote branches
      try {
        const remoteOutput = await gitExec.execGitAsync(repoPath, [
          'branch',
          '-r',
          '--sort=-committerdate',
          '--format=%(refname:short)',
        ]);
        const remoteBranchInfos: BranchInfo[] = remoteOutput
          .split('\n')
          .filter(Boolean)
          // Filter out entries without a slash (e.g., "origin" from HEAD symbolic ref)
          .filter((b) => b.includes('/'))
          // Strip remote prefix (e.g., "origin/main" -> "main")
          .map((remoteRef) => ({
            name: remoteRef.replace(/^[^/]+\//, ''),
            isRemoteOnly: true,
            remoteRef,
          }))
          // Filter out HEAD pointer (show all remote branches including ones that exist locally)
          .filter((branch) => branch.name !== 'HEAD');

        // Return local branches first, then remote-only branches
        return [...localBranchInfos, ...remoteBranchInfos];
      } catch {
        // If remote listing fails, just return local branches
        return localBranchInfos;
      }
    } catch {
      return [];
    }
  }

  async switchBranch(
    worktreePath: string,
    branchName: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Check for uncommitted changes first
      const hasChanges = await gitExec.hasUncommittedChanges(worktreePath);
      if (hasChanges) {
        return { success: false, message: `${UNCOMMITTED_CHANGES_PREFIX} switching branches` };
      }

      // Check if already on the target branch
      const currentBranch = await gitExec.getCurrentBranch(worktreePath);
      if (currentBranch === branchName) {
        return { success: true, message: `Already on branch ${branchName}` };
      }

      // Try git switch first (modern Git 2.23+), fall back to checkout
      try {
        await gitExec.execGitAsync(worktreePath, ['switch', branchName]);
      } catch {
        // Fall back to git checkout for older Git versions
        await gitExec.execGitAsync(worktreePath, ['checkout', branchName]);
      }

      // Invalidate caches after branch switch
      gitExec.invalidateCache(`currentBranch:${worktreePath}`);
      gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);

      return { success: true, message: `Switched to branch ${branchName}` };
    } catch (error) {
      return { success: false, message: extractGitError(error, 'Switch failed') };
    }
  }

  async deleteBranch(
    worktreePath: string,
    branchName: string,
    force = false
  ): Promise<{ success: boolean; message: string; errorCode?: 'not-fully-merged' }> {
    try {
      // Don't allow deleting main/master
      if (branchName === 'main' || branchName === 'master') {
        return { success: false, message: 'Cannot delete main or master branch' };
      }

      // Check if we're currently on this branch
      const currentBranch = await gitExec.getCurrentBranch(worktreePath);
      if (currentBranch === branchName) {
        return { success: false, message: 'Cannot delete the branch you are currently on' };
      }

      // Use -d for safe delete (checks if merged) or -D for force delete
      const flag = force ? '-D' : '-d';
      await gitExec.execGitAsync(worktreePath, ['branch', flag, branchName]);

      return { success: true, message: `Deleted branch ${branchName}` };
    } catch (error) {
      const errMsg = extractGitError(error, 'Delete failed');
      // Check if the error is about unmerged changes
      if (errMsg.includes('not fully merged')) {
        return {
          success: false,
          message: `Branch ${branchName} is not fully merged. Use force delete if you're sure.`,
          errorCode: 'not-fully-merged',
        };
      }
      return { success: false, message: errMsg };
    }
  }

  async deleteRemoteBranch(
    worktreePath: string,
    branchName: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Don't allow deleting main/master
      if (branchName === 'main' || branchName === 'master') {
        return { success: false, message: 'Cannot delete main or master branch' };
      }

      // Delete from origin
      await gitExec.execGitWithProgress(
        worktreePath,
        ['push', 'origin', '--delete', branchName],
        undefined,
        { enableAskpass: true }
      );

      return { success: true, message: `Deleted remote branch ${branchName}` };
    } catch (error) {
      return { success: false, message: extractGitError(error, 'Failed to delete remote branch') };
    }
  }

  async mergeBranch(repoPath: string, branchName: string): Promise<void> {
    // First, check if we're on the target branch
    const currentBranch = await gitExec.getCurrentBranch(repoPath);
    const mainBranch = await gitExec.getTargetBranch(repoPath);

    if (currentBranch !== mainBranch) {
      throw new Error(`Must be on ${mainBranch} branch to merge. Currently on ${currentBranch}`);
    }

    try {
      await gitExec.execGitAsync(repoPath, ['merge', branchName]);
    } catch (error) {
      // Check for merge conflicts
      const inspection = await inspectConflicts(repoPath);
      if (inspection.status === 'error') {
        gitExec.invalidateCache(`hasUncommittedChanges:${repoPath}`);
        throw new Error(unverifiedOperationMessage('Merge', repoPath, error, inspection.error));
      }
      if (inspection.files.length > 0) {
        gitExec.invalidateCache(`hasUncommittedChanges:${repoPath}`);
        throw new Error(activeConflictMessage('Merge', inspection.files, 'complete the merge'));
      }
      throw error;
    }
  }

  /**
   * Merges `branchName` into the workspace's branch, or rebases the workspace's branch onto it,
   * and reports how that ended. With `stash`, uncommitted changes are saved first and put back
   * after, and a failed operation is aborted; with nothing saved, its conflicts stay active for
   * the user to resolve. `resolveBranch` runs once uncommitted changes are known not to block.
   */
  private async updateFromBranch(
    worktreePath: string,
    operation: SyncOperation,
    options: { stash?: boolean } | undefined,
    resolveBranch: () => Promise<string | GitSyncResult>
  ): Promise<GitSyncResult> {
    const spec = SYNC_OPERATIONS[operation];
    try {
      const hasChanges = await gitExec.hasUncommittedChanges(worktreePath);
      const shouldStash = !!(options?.stash && hasChanges);

      if (hasChanges && !shouldStash) {
        return syncResult(
          { kind: 'uncommitted-changes' },
          `${UNCOMMITTED_CHANGES_PREFIX} ${spec.blockedAction}`
        );
      }

      const branchName = await resolveBranch();
      if (typeof branchName !== 'string') return branchName;

      const updateRef = await this.resolveUpdateRef(worktreePath, branchName);
      const stashSha = shouldStash ? await createStashAndReset(worktreePath) : undefined;

      let output: string;
      try {
        output = await gitExec.execGitAsync(worktreePath, [operation, updateRef]);
      } catch (error) {
        return stashSha
          ? await recoverStashAfterFailedOperation(worktreePath, stashSha, operation, error)
          : await inspectFailedOperation(
              worktreePath,
              operation,
              spec.pausedLabel(branchName),
              error,
              `${spec.name} failed`
            );
      }

      gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);

      if (stashSha) {
        const stashResult = await applyStashOrStore(worktreePath, stashSha, spec.storeMessage);
        gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);
        if (stashResult !== 'applied') {
          const stored = stashResult === 'stored';
          return syncResult(
            { kind: 'completed-unrestored', recovery: savedChangesRecovery(stashSha, stored) },
            stashRecoveryMessage(spec.completed(branchName), stashSha, stored)
          );
        }
      }

      return output.includes(spec.upToDateOutput)
        ? syncResult({ kind: 'completed', upToDate: true }, 'Already up to date')
        : syncResult(
            { kind: 'completed', upToDate: false },
            `${spec.completed(branchName)} successfully`
          );
    } catch (error) {
      return syncResult({ kind: 'failed' }, extractGitError(error, `${spec.name} failed`));
    }
  }

  mergeFrom(
    worktreePath: string,
    branchName: string,
    options?: { stash?: boolean }
  ): Promise<GitSyncResult> {
    return this.updateFromBranch(worktreePath, 'merge', options, async () => branchName);
  }

  async mergeToTargetBranch(worktreePath: string): Promise<{ success: boolean; message: string }> {
    try {
      const mainBranch = await gitExec.getTargetBranch(worktreePath);
      const currentBranch = await gitExec.getCurrentBranch(worktreePath);

      if (currentBranch === mainBranch) {
        return { success: false, message: 'Already on the main branch' };
      }

      // A paused rebase leaves HEAD on a partly rebased commit that must not reach the target.
      if ((await getOperationState(worktreePath, 'rebase')) === 'active') {
        return {
          success: false,
          message: `Finish or abort the rebase in progress before fast-forwarding ${mainBranch}`,
        };
      }

      const sourceRef =
        currentBranch === 'HEAD'
          ? await gitExec.execGitAsync(worktreePath, ['rev-parse', 'HEAD'])
          : currentBranch;
      const sourceLabel = currentBranch === 'HEAD' ? 'detached HEAD' : currentBranch;

      const targetWorktreePath = await this.findCheckedOutTargetWorktree(worktreePath, mainBranch);
      const syncResult = await this.syncTargetBranchForMerge(
        worktreePath,
        mainBranch,
        targetWorktreePath
      );
      if (!syncResult.success) {
        return syncResult;
      }

      // Verify branch is not behind target branch
      const behind = await this.getCommitsBehindTargetBranch(worktreePath);
      if (behind > 0) {
        return {
          success: false,
          message: `Branch is ${behind} commit${behind > 1 ? 's' : ''} behind ${mainBranch} — update your branch from ${mainBranch} first`,
        };
      }

      const ahead = await this.getCommitsAheadTargetBranch(worktreePath);
      if (ahead === 0) {
        return { success: true, message: `${mainBranch} is already up to date` };
      }

      // If target is checked out in another worktree, run merge there directly
      if (targetWorktreePath) {
        const cleanCheck = await this.ensureWorktreeIsClean(targetWorktreePath, mainBranch);
        if (!cleanCheck.success) return cleanCheck;
        return this.mergeInWorktree(targetWorktreePath, mainBranch, sourceRef, sourceLabel);
      }

      return this.fastForwardWithoutCheckout(worktreePath, mainBranch, sourceRef, sourceLabel);
    } catch (error) {
      return { success: false, message: extractGitError(error, 'Fast-forward failed') };
    }
  }

  /**
   * Fast-forward a target branch no worktree has checked out, so the user's workspace never
   * switches branches. If a worktree checks it out meanwhile, the merge runs there instead.
   */
  private async fastForwardWithoutCheckout(
    worktreePath: string,
    targetBranch: string,
    sourceRef: string,
    sourceLabel: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      const result = await gitWorktreeService.fastForwardBranch(
        worktreePath,
        targetBranch,
        sourceRef
      );
      if (result.status === 'checked-out') {
        const cleanCheck = await this.ensureWorktreeIsClean(result.worktreePath, targetBranch);
        if (!cleanCheck.success) return cleanCheck;
        return this.mergeInWorktree(result.worktreePath, targetBranch, sourceRef, sourceLabel);
      }
      return { success: true, message: `Fast-forwarded ${targetBranch} to ${sourceLabel}` };
    } catch (error) {
      return { success: false, message: extractGitError(error, 'Fast-forward merge failed') };
    }
  }

  /**
   * Merge `otherRef` into a branch no worktree has checked out, without a checkout:
   * `merge-tree` builds the merge commit, which then fast-forwards the branch. Git before 2.38
   * has no `merge-tree --write-tree`, so there the merge runs in a temporary detached worktree.
   */
  private async mergeWithoutCheckout(
    repoPath: string,
    branchName: string,
    otherRef: string,
    message: string
  ): Promise<{ status: 'merged' } | { status: 'conflicts'; files: string[] }> {
    const [ours, theirs] = await Promise.all(
      [`refs/heads/${branchName}`, otherRef].map((ref) =>
        gitExec.execGitAsync(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`])
      )
    );
    let tree: string | undefined;
    try {
      tree = await gitExec.execGitWithProgress(repoPath, [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '--no-messages',
        ours,
        theirs,
      ]);
    } catch (error) {
      // A conflicted merge exits 1 with the tree and the conflicted paths, which this
      // runner reports as the error message; older Git fails with its usage instead.
      const [conflictTree, ...files] = String((error as Error).message).split('\n');
      if (/^[0-9a-f]{40,64}$/.test(conflictTree)) {
        return { status: 'conflicts', files: files.filter(Boolean) };
      }
    }
    const merged = tree
      ? await gitExec.execGitAsync(repoPath, [
          'commit-tree',
          tree,
          '-p',
          ours,
          '-p',
          theirs,
          '-m',
          message,
        ])
      : await this.mergeInTemporaryWorktree(repoPath, ours, theirs, message);
    if (typeof merged !== 'string') return merged;
    const result = await gitWorktreeService.fastForwardBranch(repoPath, branchName, merged);
    if (result.status === 'checked-out') {
      throw new Error(`${branchName} was checked out at ${result.worktreePath} during the merge`);
    }
    return { status: 'merged' };
  }

  private async mergeInTemporaryWorktree(
    repoPath: string,
    ours: string,
    theirs: string,
    message: string
  ): Promise<string | { status: 'conflicts'; files: string[] }> {
    const tempPath = await mkdtemp(path.join(tmpdir(), 'komla-merge-'));
    try {
      await gitExec.execGitAsync(repoPath, ['worktree', 'add', '--detach', tempPath, ours]);
      try {
        await gitExec.execGitAsync(tempPath, ['merge', '--no-edit', '-m', message, theirs]);
      } catch (error) {
        const inspection = await inspectConflicts(tempPath);
        if (inspection.status === 'ok' && inspection.files.length > 0) {
          return { status: 'conflicts', files: inspection.files };
        }
        throw error;
      }
      return await gitExec.execGitAsync(tempPath, ['rev-parse', 'HEAD']);
    } finally {
      await gitWorktreeService.deleteWorktree(repoPath, tempPath, true).catch((error) => {
        logger.warn('Could not remove temporary merge worktree', {
          tempPath,
          error: (error as Error).message,
        });
      });
    }
  }

  /**
   * Fast-forward merge a branch into a target branch that is already checked out
   * in another worktree. Runs the merge command directly in that worktree.
   */
  private async mergeInWorktree(
    targetWorktreePath: string,
    targetBranch: string,
    sourceRef: string,
    sourceLabel: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      await gitExec.execGitAsync(targetWorktreePath, ['merge', '--ff-only', sourceRef]);
      return { success: true, message: `Fast-forwarded ${targetBranch} to ${sourceLabel}` };
    } catch (error) {
      return { success: false, message: extractGitError(error, 'Fast-forward merge failed') };
    }
  }

  /**
   * Ensure the target branch is current with origin before merging into it.
   * If the target branch has no remote tracking ref, merge proceeds with local state.
   */
  private async syncTargetBranchForMerge(
    worktreePath: string,
    targetBranch: string,
    targetWorktreePath: string | null
  ): Promise<{ success: boolean; message: string }> {
    // Full ref names, so a local branch or tag named origin/<target> isn't read as origin's.
    const localRef = `refs/heads/${targetBranch}`;
    const remoteRef = `refs/remotes/origin/${targetBranch}`;
    const refExists = (ref: string) =>
      gitExec.execGitAsync(worktreePath, ['rev-parse', '--verify', ref]).then(
        () => true,
        () => false
      );
    if (!(await refExists(remoteRef))) {
      return { success: true, message: '' };
    }

    try {
      await gitExec.execGitWithProgress(
        worktreePath,
        ['fetch', 'origin', targetBranch],
        undefined,
        { enableAskpass: true }
      );
    } catch (error) {
      // Fetch failed (SSH, network, etc.) — proceed with local state so the
      // merge isn't blocked by transient connectivity issues.
      logger.warn('Could not fetch before merge, proceeding with local state', error);
    }

    // A target only origin has (e.g. a release branch never checked out) starts from origin's copy.
    if (!(await refExists(localRef))) {
      try {
        await this.createBranch(worktreePath, targetBranch, remoteRef);
        return { success: true, message: '' };
      } catch (error) {
        // Something else may have created it meanwhile; then compare it as usual.
        if (!(await refExists(localRef))) {
          return {
            success: false,
            message: extractGitError(error, `Failed to create ${targetBranch} from origin`),
          };
        }
      }
    }

    let behind: number;
    let localAhead: number;
    try {
      const output = await gitExec.execGitAsync(worktreePath, [
        'rev-list',
        '--left-right',
        '--count',
        `${remoteRef}...${localRef}`,
      ]);
      const parts = output.split('\t');
      behind = parseInt(parts[0], 10) || 0;
      localAhead = parseInt(parts[1], 10) || 0;
    } catch (error) {
      return {
        success: false,
        message: extractGitError(
          error,
          `Failed to check if ${targetBranch} is behind origin/${targetBranch}`
        ),
      };
    }
    if (behind === 0) {
      return { success: true, message: '' };
    }
    if (localAhead > 0) {
      return {
        success: false,
        message: `${targetBranch} has diverged from origin/${targetBranch} — pull target branch first`,
      };
    }

    let mergeWorktreePath = targetWorktreePath;
    try {
      if (!mergeWorktreePath) {
        const result = await gitWorktreeService.fastForwardBranch(
          worktreePath,
          targetBranch,
          `refs/remotes/origin/${targetBranch}`
        );
        if (result.status === 'fast-forwarded') return { success: true, message: '' };
        mergeWorktreePath = result.worktreePath;
      }

      const cleanCheck = await this.ensureWorktreeIsClean(mergeWorktreePath, targetBranch);
      if (!cleanCheck.success) return cleanCheck;
      await gitExec.execGitAsync(mergeWorktreePath, [
        'merge',
        '--ff-only',
        `origin/${targetBranch}`,
      ]);
      return { success: true, message: '' };
    } catch (error) {
      return {
        success: false,
        message: extractGitError(error, `Failed to fast-forward ${targetBranch}`),
      };
    }
  }

  /**
   * Merge origin/target-branch into a target branch that is already checked out
   * in another worktree. Runs the merge command directly in that worktree.
   */
  private async mergeRemoteInWorktree(
    worktreePath: string,
    targetBranch: string
  ): Promise<{ success: boolean; message: string }> {
    let targetWorktreePath: string | null = null;
    try {
      targetWorktreePath = await this.findCheckedOutTargetWorktree(worktreePath, targetBranch);
      if (!targetWorktreePath) {
        return { success: false, message: `Could not find worktree for ${targetBranch}` };
      }

      const cleanCheck = await this.ensureWorktreeIsClean(targetWorktreePath, targetBranch);
      if (!cleanCheck.success) return cleanCheck;

      const output = await gitExec.execGitAsync(targetWorktreePath, [
        'merge',
        `origin/${targetBranch}`,
      ]);

      if (output.includes('Already up to date')) {
        return { success: true, message: 'Already up to date' };
      }
      return { success: true, message: `Merged origin/${targetBranch} into ${targetBranch}` };
    } catch (error) {
      if (targetWorktreePath) {
        const inspection = await inspectConflicts(targetWorktreePath);
        if (inspection.status === 'error') {
          gitExec.invalidateCache(`hasUncommittedChanges:${targetWorktreePath}`);
          return {
            success: false,
            message: unverifiedOperationMessage(
              `Updating ${targetBranch}`,
              targetWorktreePath,
              error,
              inspection.error
            ),
          };
        }
        if (inspection.files.length > 0) {
          try {
            await gitExec.execGitAsync(targetWorktreePath, ['merge', '--abort']);
          } catch (abortError) {
            gitExec.invalidateCache(`hasUncommittedChanges:${targetWorktreePath}`);
            return {
              success: false,
              message: abortFailedMessage(
                `Updating ${targetBranch}`,
                targetWorktreePath,
                abortError
              ),
            };
          }
          return {
            success: false,
            message: hiddenWorktreeConflictMessage(`Updating ${targetBranch}`),
          };
        }
      }
      return {
        success: false,
        message: extractGitError(error, `Failed to merge origin/${targetBranch}`),
      };
    }
  }

  /**
   * Returns the worktree where the target branch is currently checked out, if any.
   * Prefer the current worktree when it already has the target branch checked out.
   */
  private async findCheckedOutTargetWorktree(
    worktreePath: string,
    targetBranch: string
  ): Promise<string | null> {
    const currentBranch = await gitExec.getCurrentBranch(worktreePath);
    if (currentBranch === targetBranch) {
      return worktreePath;
    }

    const worktrees = await gitWorktreeService.listWorktrees(worktreePath);
    const targetWorktree = worktrees.find((wt) => wt.branch === targetBranch);
    return targetWorktree?.path ?? null;
  }

  private async ensureWorktreeIsClean(
    worktreePath: string,
    targetBranch: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      const hasChanges = await gitExec.hasUncommittedChanges(worktreePath);
      if (hasChanges) {
        return {
          success: false,
          message: `Cannot update ${targetBranch}: uncommitted changes in ${worktreePath}`,
        };
      }
      return { success: true, message: '' };
    } catch (error) {
      return {
        success: false,
        message: extractGitError(
          error,
          `Cannot verify worktree state for ${targetBranch} at ${worktreePath}`
        ),
      };
    }
  }

  /**
   * Merge origin/target-branch into local target branch (handles diverged branches)
   * This is used when local target branch and remote target branch have diverged and a fast-forward is not possible.
   * Creates a merge commit if necessary. The workspace stays on its own branch: the merge runs
   * where the target branch is checked out, or without a checkout when no worktree has it.
   */
  async mergeTargetBranchFromRemote(
    worktreePath: string,
    _onProgress?: GitProgressCallback
  ): Promise<{ success: boolean; message: string }> {
    const mainBranch = await gitExec.getTargetBranch(worktreePath);
    let targetWorktreePath: string | null;
    try {
      targetWorktreePath = await this.findCheckedOutTargetWorktree(worktreePath, mainBranch);
    } catch (error) {
      return {
        success: false,
        message: extractGitError(error, `Failed to find where ${mainBranch} is checked out`),
      };
    }
    if (!targetWorktreePath) return this.mergeRemoteWithoutCheckout(worktreePath, mainBranch);
    if (targetWorktreePath !== worktreePath) {
      return this.mergeRemoteInWorktree(worktreePath, mainBranch);
    }

    try {
      const output = await gitExec.execGitAsync(worktreePath, ['merge', `origin/${mainBranch}`]);
      if (output.includes('Already up to date')) {
        return { success: true, message: 'Already up to date' };
      }
      return { success: true, message: `Merged origin/${mainBranch} into ${mainBranch}` };
    } catch (error) {
      const inspection = await inspectConflicts(worktreePath);
      if (inspection.status === 'error') {
        gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);
        return {
          success: false,
          message: unverifiedOperationMessage(
            `Updating ${mainBranch}`,
            worktreePath,
            error,
            inspection.error
          ),
        };
      }
      if (inspection.files.length > 0) {
        gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);
        return {
          success: false,
          message: activeConflictMessage(
            `Merge origin/${mainBranch} into ${mainBranch}`,
            inspection.files,
            'complete the merge'
          ),
        };
      }
      return { success: false, message: extractGitError(error, 'Merge failed') };
    }
  }

  /** Merge origin/target-branch into a target branch that no worktree has checked out. */
  private async mergeRemoteWithoutCheckout(
    worktreePath: string,
    targetBranch: string
  ): Promise<{ success: boolean; message: string }> {
    const localRef = `refs/heads/${targetBranch}`;
    const remoteRef = `refs/remotes/origin/${targetBranch}`;
    const isAncestor = (ancestor: string, descendant: string) =>
      safeExec(worktreePath, ['merge-base', '--is-ancestor', ancestor, descendant]);
    if (await isAncestor(remoteRef, localRef)) {
      return { success: true, message: 'Already up to date' };
    }
    if (await isAncestor(localRef, remoteRef)) {
      return this.fastForwardWithoutCheckout(
        worktreePath,
        targetBranch,
        remoteRef,
        `origin/${targetBranch}`
      );
    }

    try {
      const result = await this.mergeWithoutCheckout(
        worktreePath,
        targetBranch,
        remoteRef,
        `Merge remote-tracking branch 'origin/${targetBranch}'`
      );
      if (result.status === 'conflicts') {
        return {
          success: false,
          message: unmergedConflictMessage(
            `Merging origin/${targetBranch} into ${targetBranch}`,
            targetBranch,
            result.files
          ),
        };
      }
      return { success: true, message: `Merged origin/${targetBranch} into ${targetBranch}` };
    } catch (error) {
      return {
        success: false,
        message: extractGitError(error, `Failed to merge origin/${targetBranch}`),
      };
    }
  }

  rebaseOnTargetBranch(
    worktreePath: string,
    options?: { stash?: boolean }
  ): Promise<GitSyncResult> {
    return this.updateFromBranch(worktreePath, 'rebase', options, () =>
      gitExec.getTargetBranch(worktreePath)
    );
  }

  rebaseOnBranch(
    worktreePath: string,
    branchName: string,
    options?: { stash?: boolean }
  ): Promise<GitSyncResult> {
    return this.updateFromBranch(worktreePath, 'rebase', options, async () => {
      const currentBranch = await gitExec.getCurrentBranch(worktreePath);
      return currentBranch === branchName
        ? syncResult({ kind: 'failed' }, 'Cannot rebase onto the current branch')
        : branchName;
    });
  }

  async abortRebase(worktreePath: string): Promise<{ success: boolean; message: string }> {
    try {
      await gitExec.execGitAsync(worktreePath, ['rebase', '--abort']);
    } catch (error) {
      return { success: false, message: extractGitError(error, 'Could not abort the rebase') };
    } finally {
      gitExec.invalidateCache(`currentBranch:${worktreePath}`);
      gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);
    }
    const branch = await gitExec.getCurrentBranch(worktreePath).catch(() => '');
    return {
      success: true,
      message:
        branch && branch !== 'HEAD' ? `Rebase aborted. ${branch} was restored.` : 'Rebase aborted.',
    };
  }

  async push(
    worktreePath: string,
    onProgress?: GitProgressCallback
  ): Promise<{ success: boolean; message: string; errorCode?: 'rejected' }> {
    try {
      const branch = await gitExec.getCurrentBranch(worktreePath);
      const hasRemote = await gitExec.hasRemoteTrackingBranch(worktreePath);

      // Check if there's anything to push
      const unpushed = hasRemote ? await gitExec.getUnpushedCommits(worktreePath) : -1;

      // Detect divergence (e.g. after rebase) and use --force-with-lease
      const behindRemote = hasRemote ? await gitExec.getCommitsBehindRemote(worktreePath) : 0;
      const pushArgs = ['push', '-u', 'origin', branch, '--progress'];
      if (behindRemote > 0 && unpushed > 0) {
        pushArgs.push('--force-with-lease');
      }

      await gitExec.execGitWithProgress(worktreePath, pushArgs, onProgress, {
        enableAskpass: true,
      });

      if (!hasRemote) {
        return { success: true, message: `Published ${branch} to origin` };
      } else if (unpushed === 0) {
        return { success: true, message: 'Already up to date' };
      } else {
        return {
          success: true,
          message: `Pushed ${unpushed} commit${unpushed !== 1 ? 's' : ''} to origin`,
        };
      }
    } catch (error) {
      const errMsg = extractGitError(error, 'Push failed');
      if (
        errMsg.includes('non-fast-forward') ||
        errMsg.includes('fetch first') ||
        errMsg.includes('[rejected]')
      ) {
        return { success: false, message: 'Remote has new commits', errorCode: 'rejected' };
      }
      return { success: false, message: errMsg };
    }
  }

  /**
   * Push the target branch to remote (can be called from any worktree)
   */
  async pushTargetBranch(
    worktreePath: string,
    onProgress?: GitProgressCallback
  ): Promise<{ success: boolean; message: string; errorCode?: 'rejected' }> {
    let mainBranch = 'main';
    try {
      mainBranch = await gitExec.getTargetBranch(worktreePath);
      const originUrl = await this.getResolvedOriginUrl(worktreePath);
      const gitDir = await this.resolveCommonGitDir(worktreePath);
      const gitArgs = (args: string[]) => [
        '--git-dir',
        gitDir,
        ...(originUrl ? ['-c', `remote.origin.url=${originUrl}`] : []),
        ...args,
      ];
      let hasRemote = true;

      // Check if origin/<target> exists so we can distinguish push vs publish.
      try {
        await gitExec.execGitAsync(
          gitDir,
          gitArgs(['rev-parse', '--verify', `origin/${mainBranch}`])
        );
      } catch {
        hasRemote = false;
      }

      const ahead = hasRemote ? await this.getAheadFromGitDir(gitDir, mainBranch) : 0;

      await gitExec.execGitWithProgress(
        gitDir,
        gitArgs(
          hasRemote
            ? ['push', 'origin', mainBranch, '--progress']
            : ['push', '-u', 'origin', mainBranch, '--progress']
        ),
        onProgress,
        { enableAskpass: true }
      );

      if (!hasRemote) {
        return { success: true, message: `Published ${mainBranch} to origin` };
      }
      if (ahead === 0) {
        return { success: true, message: `${mainBranch} is already up to date` };
      }
      return {
        success: true,
        message: `Pushed ${ahead} commit${ahead !== 1 ? 's' : ''} to ${mainBranch}`,
      };
    } catch (error) {
      const errMsg = extractGitError(error, `Failed to push ${mainBranch}`);
      if (
        errMsg.includes('non-fast-forward') ||
        errMsg.includes('fetch first') ||
        errMsg.includes('[rejected]')
      ) {
        return {
          success: false,
          message: `Remote has new commits on ${mainBranch}`,
          errorCode: 'rejected',
        };
      }
      return { success: false, message: errMsg };
    }
  }

  private async resolveCommonGitDir(worktreePath: string): Promise<string> {
    const output = await gitExec.execGitAsync(worktreePath, ['rev-parse', '--git-common-dir']);
    const gitDir = output.trim();
    return path.isAbsolute(gitDir) ? gitDir : path.resolve(worktreePath, gitDir);
  }

  private async getResolvedOriginUrl(worktreePath: string): Promise<string | undefined> {
    const originUrl = (
      await gitExec.execGitAsync(worktreePath, ['ls-remote', '--get-url', 'origin']).catch(() => '')
    ).trim();
    if (!originUrl || !this.isRelativeLocalRemoteUrl(originUrl)) {
      return originUrl || undefined;
    }
    return path.resolve(worktreePath, originUrl);
  }

  private isRelativeLocalRemoteUrl(remoteUrl: string): boolean {
    return (
      !path.isAbsolute(remoteUrl) &&
      !remoteUrl.startsWith('file:') &&
      !/^[a-z][a-z0-9+.-]*:\/\//i.test(remoteUrl) &&
      !/^[^/\\]+@[^/\\]+:.+/.test(remoteUrl)
    );
  }

  private async getAheadFromGitDir(gitDir: string, branch: string): Promise<number> {
    try {
      const output = await gitExec.execGitAsync(gitDir, [
        '--git-dir',
        gitDir,
        'rev-list',
        '--left-right',
        '--count',
        `origin/${branch}...${branch}`,
      ]);
      const [, ahead] = output.split('\t').map((n) => parseInt(n, 10) || 0);
      return ahead ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Arguments naming what `git pull` pulls from: none when the branch has upstream config, so
   * git follows it, or `origin <branch>` when only the remote ref exists, as in worktrees of a
   * bare clone. Null when the branch has neither.
   */
  private async resolvePullSource(worktreePath: string, branch: string): Promise<string[] | null> {
    try {
      // A plain pull needs the merge ref; git takes the remote from config or defaults to origin.
      await gitExec.execGitAsync(worktreePath, ['config', '--get', `branch.${branch}.merge`]);
      return [];
    } catch {
      try {
        await gitExec.execGitAsync(worktreePath, [
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/remotes/origin/${branch}`,
        ]);
        return ['origin', branch];
      } catch {
        return null;
      }
    }
  }

  async pull(worktreePath: string, onProgress?: GitProgressCallback): Promise<GitSyncResult> {
    try {
      // Check for uncommitted changes first
      const hasChanges = await gitExec.hasUncommittedChanges(worktreePath);
      if (hasChanges) {
        return syncResult({ kind: 'uncommitted-changes' }, `${UNCOMMITTED_CHANGES_PREFIX} pulling`);
      }

      // Read HEAD live: the cached branch can be stale after a checkout in a terminal.
      const branch = await gitExec.getCheckedOutBranch(worktreePath);
      if (!branch) {
        return syncResult({ kind: 'failed' }, 'No branch is checked out to pull');
      }
      const source = await this.resolvePullSource(worktreePath, branch);
      if (!source) {
        return syncResult({ kind: 'failed' }, 'No remote tracking branch configured');
      }

      const output = await gitExec.execGitWithProgress(
        worktreePath,
        ['pull', '--no-rebase', ...source, '--progress'],
        onProgress,
        { enableAskpass: true }
      );

      // Invalidate caches after pull
      gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);

      // Check if already up to date
      if (output.includes('Already up to date')) {
        return syncResult({ kind: 'completed', upToDate: true }, 'Already up to date');
      }

      return syncResult({ kind: 'completed', upToDate: false }, 'Pulled changes successfully');
    } catch (error) {
      return inspectFailedOperation(worktreePath, 'merge', 'Pull', error, 'Pull failed');
    }
  }

  async pullRebase(worktreePath: string, onProgress?: GitProgressCallback): Promise<GitSyncResult> {
    try {
      const hasChanges = await gitExec.hasUncommittedChanges(worktreePath);
      if (hasChanges) {
        return syncResult({ kind: 'uncommitted-changes' }, `${UNCOMMITTED_CHANGES_PREFIX} pulling`);
      }

      const currentBranch = await gitExec.getCurrentBranch(worktreePath);
      const targetBranch = await gitExec.getTargetBranch(worktreePath);
      if (currentBranch === targetBranch) {
        return syncResult(
          { kind: 'failed' },
          `Pull (rebase) is not allowed on ${targetBranch}; use the main pull flow instead`
        );
      }

      const hasRemote = await gitExec.hasRemoteTrackingBranch(worktreePath);
      if (!hasRemote) {
        return syncResult({ kind: 'failed' }, 'No remote tracking branch configured');
      }

      let pullArgs = ['pull', '--rebase', '--progress'];
      try {
        await gitExec.execGitAsync(worktreePath, [
          'rev-parse',
          '--abbrev-ref',
          `${currentBranch}@{upstream}`,
        ]);
      } catch {
        // Some worktrees have an origin ref without upstream config. Fall back to
        // an explicit remote/branch pull so recovery still works.
        try {
          await gitExec.execGitAsync(worktreePath, [
            'rev-parse',
            '--verify',
            `origin/${currentBranch}`,
          ]);
          pullArgs = ['pull', '--rebase', 'origin', currentBranch, '--progress'];
        } catch {
          return syncResult({ kind: 'failed' }, 'No upstream tracking branch configured');
        }
      }

      const output = await gitExec.execGitWithProgress(worktreePath, pullArgs, onProgress, {
        enableAskpass: true,
      });

      gitExec.invalidateCache(`hasUncommittedChanges:${worktreePath}`);

      if (output.includes('Already up to date') || output.includes('is up to date')) {
        return syncResult({ kind: 'completed', upToDate: true }, 'Already up to date');
      }

      return syncResult({ kind: 'completed', upToDate: false }, 'Rebased on remote changes');
    } catch (error) {
      const result = await inspectFailedOperation(
        worktreePath,
        'rebase',
        'Pull with rebase',
        error,
        'Pull with rebase failed'
      );
      if (result.outcome.kind === 'failed') {
        // Clean up non-conflict failures if Git left rebase metadata behind.
        try {
          await gitExec.execGitAsync(worktreePath, ['rebase', '--abort']);
        } catch {
          // Ignore if no rebase in progress
        }
      }
      return result;
    }
  }

  /**
   * Pull (fast-forward) the target branch from remote (can be called from any worktree)
   */
  async pullTargetBranch(
    worktreePath: string,
    onProgress?: GitProgressCallback
  ): Promise<{ success: boolean; message: string }> {
    try {
      const mainBranch = await gitExec.getTargetBranch(worktreePath);

      // Check if origin/main exists
      try {
        await gitExec.execGitAsync(worktreePath, ['rev-parse', '--verify', `origin/${mainBranch}`]);
      } catch {
        return { success: false, message: `No remote tracking branch for ${mainBranch}` };
      }

      // Fetch latest remote state before checking how far behind we are
      await gitExec.execGitWithProgress(
        worktreePath,
        ['fetch', 'origin', mainBranch, '--progress'],
        onProgress,
        { enableAskpass: true }
      );

      // Check how many commits to pull
      const { behind } = await gitExec.getAheadBehind(
        worktreePath,
        mainBranch,
        `origin/${mainBranch}`
      );

      if (behind === 0) {
        return { success: true, message: `${mainBranch} is already up to date` };
      }

      const checkedOutTargetWorktree = await this.findCheckedOutTargetWorktree(
        worktreePath,
        mainBranch
      );

      // Fast-forward main branch using the already-fetched origin ref
      // (avoids a second SSH round-trip that would re-prompt for credentials)
      try {
        // Check if fast-forward is possible (local main must be ancestor of origin/main)
        await gitExec.execGitAsync(worktreePath, [
          'merge-base',
          '--is-ancestor',
          mainBranch,
          `origin/${mainBranch}`,
        ]);
      } catch {
        // Non-fast-forward: local main has diverged (e.g. after merging a branch).
        // Fall back to a real merge so push recovery can succeed.
        if (checkedOutTargetWorktree) {
          const cleanCheck = await this.ensureWorktreeIsClean(checkedOutTargetWorktree, mainBranch);
          if (!cleanCheck.success) return cleanCheck;
        }
        return this.mergeTargetBranchFromRemote(worktreePath);
      }

      let mergeWorktreePath = checkedOutTargetWorktree;
      if (!mergeWorktreePath) {
        const result = await gitWorktreeService.fastForwardBranch(
          worktreePath,
          mainBranch,
          `refs/remotes/origin/${mainBranch}`
        );
        if (result.status === 'checked-out') mergeWorktreePath = result.worktreePath;
      }
      if (mergeWorktreePath) {
        const cleanCheck = await this.ensureWorktreeIsClean(mergeWorktreePath, mainBranch);
        if (!cleanCheck.success) return cleanCheck;

        await gitExec.execGitAsync(mergeWorktreePath, [
          'merge',
          '--ff-only',
          `origin/${mainBranch}`,
        ]);
      }

      return {
        success: true,
        message: `Pulled ${behind} commit${behind !== 1 ? 's' : ''} to ${mainBranch}`,
      };
    } catch (error) {
      const mainBranch = await gitExec.getTargetBranch(worktreePath).catch(() => 'main');
      const errMsg = extractGitError(error, `Failed to pull ${mainBranch}`);
      return { success: false, message: errMsg };
    }
  }

  async fetchFromRemote(
    repoPath: string,
    onProgress?: GitProgressCallback
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Get remote refs before fetch to compare
      const refsBefore = await this.getRemoteRefs(repoPath);

      await gitExec.execGitWithProgress(repoPath, ['fetch', '--all', '--progress'], onProgress, {
        enableAskpass: true,
      });

      // Get remote refs after fetch
      const refsAfter = await this.getRemoteRefs(repoPath);

      // Invalidate branch-related caches after fetch
      gitExec.invalidateCache(`currentBranch:${repoPath}`);
      gitExec.invalidateCache(`mainBranch:${repoPath}`);
      gitExec.invalidateCache(`remoteDefaultBranch:${repoPath}`);
      gitExec.invalidateCache(`hasUncommittedChanges:${repoPath}`);

      // Count updated refs
      let updatedRefs = 0;
      let newCommits = 0;
      for (const [ref, sha] of refsAfter) {
        const oldSha = refsBefore.get(ref);
        if (oldSha !== sha) {
          updatedRefs++;
          // Count commits between old and new (if old exists)
          if (oldSha) {
            try {
              const count = await gitExec.execGitAsync(repoPath, [
                'rev-list',
                '--count',
                `${oldSha}..${sha}`,
              ]);
              newCommits += parseInt(count, 10) || 0;
            } catch {
              // Ignore count errors
            }
          }
        }
      }

      if (updatedRefs === 0) {
        return { success: true, message: 'Already up to date' };
      }

      const commitText =
        newCommits > 0 ? `${newCommits} new commit${newCommits !== 1 ? 's' : ''}` : '';
      const refText = `${updatedRefs} ref${updatedRefs !== 1 ? 's' : ''} updated`;
      const message = commitText ? `${commitText} (${refText})` : refText;

      return { success: true, message };
    } catch (error) {
      return { success: false, message: extractGitError(error, 'Fetch failed') };
    }
  }

  /**
   * Fetch all branches from a remote into a bare repo
   * Updates remote tracking refs (refs/remotes/origin/*) for branch publishing detection
   * Does NOT overwrite local branches (refs/heads/*) to preserve worktree branches
   * Supports SSH passphrase prompting via native dialog
   */
  async fetchAllBranches(repoPath: string, remoteName: string): Promise<void> {
    // Fetch into remote tracking refs so worktrees can detect published branches
    // We intentionally do NOT update refs/heads/* because that would delete local
    // branches created for worktrees that haven't been pushed to the remote yet
    await gitExec.execGitWithProgress(
      repoPath,
      ['fetch', remoteName, `+refs/heads/*:refs/remotes/${remoteName}/*`, '--prune'],
      undefined,
      { enableAskpass: true }
    );
  }

  /**
   * Fetch origin without asking for anything, for refreshes nobody asked for: a remote that
   * needs a password, passphrase or new host key fails instead. With `branches`, just those
   * branches, in a clone that fetches every branch; otherwise a managed bare clone fetches every
   * branch into refs/remotes/origin like fetchAllBranches, and a user's clone uses its own fetch
   * settings. Only Komla's own clones
   * prune. Gives up after `timeoutMs`, or when stopBackgroundWork stops it; `mark` is the
   * backgroundMark taken when the caller's work began.
   */
  async fetchOriginWithoutPrompts(
    repoPath: string,
    managed: boolean,
    timeoutMs: number,
    mark: number,
    branches?: readonly string[]
  ): Promise<void> {
    const [config, tracksEveryBranch] = await Promise.all([
      gitExec
        .execGitAsync(repoPath, ['config', '-z', '--get-regexp', NO_PROMPT_CONFIG_KEYS])
        .catch(() => ''),
      // Komla's own clones name the branches to fetch; a user's fetch follows its refspec.
      managed || this.fetchTracksEveryOriginBranch(repoPath),
    ]);
    // Naming branches in a clone whose refspec leaves some out would add copies it excludes.
    const named = tracksEveryBranch ? branches : undefined;
    const prune = managed ? ['--prune'] : [];
    const args = named
      ? ['fetch', 'origin', ...originBranchRefspecs(named), ...prune]
      : managed
        ? ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*', ...prune]
        : ['fetch', 'origin'];
    await gitExec.execGitWithProgress(repoPath, args, undefined, {
      noPrompts: { config },
      timeoutMs,
      background: mark,
    });
    // A fetch that leaves branches untracked can't vouch for their remote-tracking refs.
    if (tracksEveryBranch) this.recordOriginFetch(repoPath, named ?? [EVERY_BRANCH]);
    gitExec.invalidateCache(`mainBranch:${repoPath}`);
    gitExec.invalidateCache(`remoteDefaultBranch:${repoPath}`);
  }

  private recordOriginFetch(repoPath: string, branches: readonly string[]): void {
    const key = path.resolve(repoPath);
    const fetched = this.originFetchedAt.get(key) ?? new Map<string, number>();
    const now = Date.now();
    for (const branch of branches) fetched.set(branch, now);
    this.originFetchedAt.set(key, fetched);
  }

  private async fetchTracksEveryOriginBranch(repoPath: string): Promise<boolean> {
    const refspecs = await gitExec
      .execGitAsync(repoPath, ['config', '--get-all', 'remote.origin.fetch'])
      .catch(() => '');
    return refspecs
      .split('\n')
      .some(
        (refspec) => refspec.trim().replace(/^\+/, '') === 'refs/heads/*:refs/remotes/origin/*'
      );
  }

  /** Whether the repository fetched `branch` from origin in the last few minutes. */
  fetchedOriginRecently(repoPath: string, branch: string): boolean {
    const fetched = this.originFetchedAt.get(path.resolve(repoPath));
    const fetchedAt = Math.max(fetched?.get(branch) ?? 0, fetched?.get(EVERY_BRANCH) ?? 0);
    return Date.now() - fetchedAt < RECENT_ORIGIN_FETCH_MS;
  }

  /**
   * Fetch one branch from origin, then return it as a start point the way
   * originStartPoint does. Undefined also when the fetch fails.
   */
  async fetchOriginStartPoint(repoPath: string, branchName: string): Promise<string | undefined> {
    if (!(await gitExec.hasRemote(repoPath, 'origin'))) return undefined;
    try {
      await gitExec.execGitWithProgress(
        repoPath,
        ['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`],
        undefined,
        { enableAskpass: true }
      );
    } catch (error) {
      logger.warn('Could not fetch start point from origin', {
        branchName,
        error: (error as Error).message,
      });
      return undefined;
    }
    // So the next workspace started from it soon after doesn't fetch it again.
    this.recordOriginFetch(repoPath, [branchName]);
    const startPoint = await this.originStartPoint(repoPath, branchName);
    return startPoint.status === 'available' ? startPoint.ref : undefined;
  }

  /**
   * The commit origin has for `revision`, so an SSH host can start from it. Origin's copy is used
   * as it is when it was fetched in the last few minutes and has every commit of the local
   * branch; otherwise origin is fetched first, since the branch may have just been pushed.
   */
  async resolvePublishedCommit(repoPath: string, revision: string): Promise<string> {
    const branch = revision.replace(/^refs\/remotes\/origin\//, '').replace(/^origin\//, '');
    if (branch !== 'HEAD' && this.fetchedOriginRecently(repoPath, branch)) {
      const recent = await this.originStartPoint(repoPath, branch);
      if (recent.status === 'available') {
        const commit = await gitExec
          .execGitAsync(repoPath, ['rev-parse', '--verify', `refs/remotes/${recent.ref}^{commit}`])
          .catch(() => null);
        if (commit) return commit;
      }
    }
    return gitExec.resolvePublishedCommit(repoPath, revision);
  }

  /**
   * Origin's copy of a branch as of the last fetch, as a start point for a new worktree:
   * `origin/<branch>` when that remote-tracking ref exists and contains every local commit on
   * the branch. Callers otherwise keep their local start point. Doesn't fetch.
   */
  async originStartPoint(repoPath: string, branchName: string): Promise<OriginStartPoint> {
    const remoteRef = `refs/remotes/origin/${branchName}`;
    const localRef = `refs/heads/${branchName}`;
    const succeeds = (args: string[]) =>
      gitExec.execGitAsync(repoPath, args).then(
        () => true,
        () => false
      );
    const [hasRemoteBranch, hasLocalBranch] = await Promise.all(
      [remoteRef, localRef].map((ref) =>
        succeeds(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      )
    );
    if (!hasRemoteBranch) return { status: 'missing' };
    const originHasLocalCommits =
      !hasLocalBranch || (await succeeds(['merge-base', '--is-ancestor', localRef, remoteRef]));
    return originHasLocalCommits
      ? { status: 'available', ref: `origin/${branchName}` }
      : { status: 'behind-local' };
  }

  /**
   * Push a branch to a remote
   * Supports SSH passphrase prompting via native dialog
   */
  async pushToRemote(repoPath: string, remoteName: string, branchName: string): Promise<void> {
    await gitExec.execGitWithProgress(repoPath, ['push', '-u', remoteName, branchName], undefined, {
      enableAskpass: true,
    });
  }

  /**
   * Push each local branch that origin doesn't have yet, so a newly added remote can be cloned
   * from. Branches origin already has are left alone; names that aren't local branches are skipped.
   */
  async pushBranchesMissingFromOrigin(repoPath: string, branches: string[]): Promise<string[]> {
    await gitExec.execGitWithProgress(
      repoPath,
      ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*', '--prune'],
      undefined,
      { enableAskpass: true }
    );
    const hasRef = (ref: string) =>
      gitExec.execGitAsync(repoPath, ['show-ref', '--verify', '--quiet', ref]).then(
        () => true,
        () => false
      );
    const pushed: string[] = [];
    for (const branch of new Set(branches)) {
      if (!(await hasRef(`refs/heads/${branch}`))) continue;
      if (await hasRef(`refs/remotes/origin/${branch}`)) continue;
      await gitExec.execGitWithProgress(
        repoPath,
        ['push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`],
        undefined,
        { enableAskpass: true }
      );
      pushed.push(branch);
    }
    return pushed;
  }

  async getCommitsBehindTargetBranch(worktreePath: string): Promise<number> {
    try {
      const mainBranch = await gitExec.getTargetBranch(worktreePath);
      const currentBranch = await gitExec.getCurrentBranch(worktreePath);

      // If we're on main, we're not behind
      if (currentBranch === mainBranch) {
        return 0;
      }

      // Count commits that are in local main but not in the current branch
      const output = await gitExec.execGitAsync(worktreePath, [
        'rev-list',
        '--count',
        `${currentBranch}..${mainBranch}`,
      ]);
      return parseInt(output, 10) || 0;
    } catch {
      return 0;
    }
  }

  async getCommitsAheadTargetBranch(worktreePath: string): Promise<number> {
    try {
      const mainBranch = await gitExec.getTargetBranch(worktreePath);
      const currentBranch = await gitExec.getCurrentBranch(worktreePath);

      // If we're on main, we're not ahead
      if (currentBranch === mainBranch) {
        return 0;
      }

      // Count commits in current branch that aren't in main
      const output = await gitExec.execGitAsync(worktreePath, [
        'rev-list',
        '--count',
        `${mainBranch}..${currentBranch}`,
      ]);
      return parseInt(output, 10) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get how many commits the target branch is ahead/behind its remote tracking branch
   */
  async getTargetBranchRemoteStatus(
    worktreePath: string
  ): Promise<{ hasRemote: boolean; ahead: number; behind: number }> {
    try {
      const mainBranch = await gitExec.getTargetBranch(worktreePath);

      // Check if origin/main exists
      try {
        await gitExec.execGitAsync(worktreePath, ['rev-parse', '--verify', `origin/${mainBranch}`]);
      } catch {
        return { hasRemote: false, ahead: 0, behind: 0 };
      }

      const { ahead, behind } = await gitExec.getAheadBehind(
        worktreePath,
        mainBranch,
        `origin/${mainBranch}`
      );
      return { hasRemote: true, ahead, behind };
    } catch {
      return { hasRemote: false, ahead: 0, behind: 0 };
    }
  }

  async getBranchQuickStatus(worktreePath: string): Promise<GitBranchQuickStatus> {
    // Request coalescing: return in-flight promise if one exists
    const existing = this.inFlightBranchStatus.get(worktreePath);
    if (existing) return existing;

    const promise = this._getBranchQuickStatus(worktreePath);
    this.inFlightBranchStatus.set(worktreePath, promise);
    try {
      return await promise;
    } finally {
      this.inFlightBranchStatus.delete(worktreePath);
    }
  }

  /**
   * Reading another local branch here means adding it to `localBranchesReadByBranchStatus`, or
   * the worktree watcher won't refresh this status when that branch moves.
   */
  private async _getBranchQuickStatus(worktreePath: string): Promise<GitBranchQuickStatus> {
    // Step 1: Resolve branch names (usually cached at 30s TTL) and whether a rebase is paused
    const [
      currentBranch,
      targetBranch,
      defaultBranch,
      remoteDefaultBranch,
      hasOriginRemote,
      rebaseState,
    ] = await Promise.all([
      gitExec.getCurrentBranch(worktreePath).catch(() => ''),
      gitExec.getTargetBranch(worktreePath).catch(() => 'main'),
      gitExec.getMainBranch(worktreePath).catch(() => 'main'),
      gitExec.getRemoteDefaultBranch(worktreePath).catch(() => null),
      gitExec.hasRemote(worktreePath, 'origin').catch(() => false),
      getOperationState(worktreePath, 'rebase'),
    ]);

    // Resolve target branch to a valid git ref — if the local branch doesn't exist
    // (e.g. remote-only branch selected as target), fall back to origin/<branch>
    let targetRef = targetBranch;
    try {
      await gitExec.execGitAsync(worktreePath, ['rev-parse', '--verify', targetBranch]);
    } catch {
      try {
        await gitExec.execGitAsync(worktreePath, [
          'rev-parse',
          '--verify',
          `origin/${targetBranch}`,
        ]);
        targetRef = `origin/${targetBranch}`;
      } catch {
        // Neither local nor remote ref exists — keep as-is, downstream catches will handle
      }
    }

    // Resolve remote status before comparing the workspace so a fetched target that is a
    // strict fast-forward of the local target becomes the effective comparison point.
    const [remoteCounts, mainRemoteStatus] = await Promise.all([
      // Ahead/behind remote in one call (replaces hasRemoteTrackingBranch + getUnpushedCommits + getCommitsBehindRemote)
      this.getRemoteCounts(worktreePath, currentBranch),
      this.getTargetBranchRemoteStatusResolved(worktreePath, targetBranch, targetRef).catch(() => ({
        hasRemote: false,
        ahead: 0,
        behind: 0,
      })),
    ]);
    const targetComparisonRef =
      mainRemoteStatus.hasRemote && mainRemoteStatus.ahead === 0 && mainRemoteStatus.behind > 0
        ? `origin/${targetBranch}`
        : targetRef;
    const mainCounts =
      currentBranch && currentBranch !== targetBranch
        ? await gitExec
            .getAheadBehind(worktreePath, currentBranch, targetComparisonRef)
            .catch(() => ({ ahead: 0, behind: 0 }))
        : { ahead: 0, behind: 0 };

    return {
      behindTargetBranch: mainCounts.behind,
      aheadTargetBranch: mainCounts.ahead,
      mainBranch: targetBranch,
      defaultBranch,
      ...(remoteDefaultBranch ? { remoteDefaultBranch } : {}),
      hasRemote: remoteCounts.hasRemote,
      hasOriginRemote,
      unpushedCommits: remoteCounts.unpushed,
      behindRemote: remoteCounts.behind,
      currentBranch,
      targetBranchHasRemote: mainRemoteStatus.hasRemote,
      targetBranchAheadRemote: mainRemoteStatus.ahead,
      targetBranchBehindRemote: mainRemoteStatus.behind,
      rebaseInProgress: rebaseState === 'active',
    };
  }

  /**
   * Combines hasRemoteTrackingBranch + getUnpushedCommits + getCommitsBehindRemote
   * into at most 2 git subprocess calls (upstream resolution + single ahead/behind count).
   */
  private async getRemoteCounts(
    worktreePath: string,
    currentBranch: string
  ): Promise<{ hasRemote: boolean; unpushed: number; behind: number }> {
    if (!currentBranch) return { hasRemote: false, unpushed: 0, behind: 0 };

    // Try to resolve upstream tracking branch
    let upstream: string;
    try {
      upstream = await gitExec.execGitAsync(worktreePath, [
        'rev-parse',
        '--abbrev-ref',
        `${currentBranch}@{upstream}`,
      ]);
    } catch {
      // No configured upstream - check if origin/branch ref exists as fallback
      try {
        await gitExec.execGitAsync(worktreePath, [
          'rev-parse',
          '--verify',
          `origin/${currentBranch}`,
        ]);
        // origin/<branch> exists but no tracking ref — still compute ahead/behind
        upstream = `origin/${currentBranch}`;
      } catch {
        return { hasRemote: false, unpushed: 0, behind: 0 };
      }
    }

    if (!upstream) return { hasRemote: false, unpushed: 0, behind: 0 };

    // Single rev-list call for both ahead and behind remote
    const { ahead, behind } = await gitExec.getAheadBehind(worktreePath, currentBranch, upstream);
    return { hasRemote: true, unpushed: ahead, behind };
  }

  /**
   * Like getTargetBranchRemoteStatus but takes pre-resolved targetBranch to avoid redundant lookups.
   */
  private async getTargetBranchRemoteStatusResolved(
    worktreePath: string,
    targetBranch: string,
    targetRef?: string
  ): Promise<{ hasRemote: boolean; ahead: number; behind: number }> {
    const remoteRef = `origin/${targetBranch}`;
    try {
      await gitExec.execGitAsync(worktreePath, ['rev-parse', '--verify', remoteRef]);
    } catch {
      return { hasRemote: false, ahead: 0, behind: 0 };
    }
    // Use the resolved ref (which may already be origin/<branch> for remote-only branches)
    const localRef = targetRef ?? targetBranch;
    // If the local ref IS the remote ref, there's nothing to compare
    if (localRef === remoteRef) {
      return { hasRemote: true, ahead: 0, behind: 0 };
    }
    const { ahead, behind } = await gitExec.getAheadBehind(worktreePath, localRef, remoteRef);
    return { hasRemote: true, ahead, behind };
  }

  async getBranchUrl(worktreePath: string): Promise<string | null> {
    // Import gitRepoService lazily to avoid circular dependency
    const { gitRepoService } = await import('./git-repo');
    const { provider, webUrl } = await gitRepoService.getRepoWebInfo(worktreePath);
    if (!webUrl) return null;

    const branch = await gitExec.getCurrentBranch(worktreePath);
    const encodedBranch = encodeURIComponent(branch);

    switch (provider) {
      case 'github':
        return `${webUrl}/tree/${encodedBranch}`;
      case 'gitlab':
        return `${webUrl}/-/tree/${encodedBranch}`;
      case 'bitbucket':
        return `${webUrl}/src/${encodedBranch}`;
      case 'azure-devops':
        return `${webUrl}?version=${encodeURIComponent(`GB${branch}`)}`;
      default:
        // Generic fallback - try GitHub-style
        return `${webUrl}/tree/${encodedBranch}`;
    }
  }

  async getCreatePrUrl(worktreePath: string): Promise<string | null> {
    // Import gitRepoService lazily to avoid circular dependency
    const { gitRepoService } = await import('./git-repo');
    const { provider, webUrl } = await gitRepoService.getRepoWebInfo(worktreePath);
    if (!webUrl) return null;

    const branch = await gitExec.getCurrentBranch(worktreePath);
    const mainBranch = await gitExec.getTargetBranch(worktreePath);
    const encodedBranch = encodeURIComponent(branch);
    const encodedMain = encodeURIComponent(mainBranch);

    switch (provider) {
      case 'github':
        return `${webUrl}/compare/${encodedMain}...${encodedBranch}?expand=1`;
      case 'gitlab':
        return `${webUrl}/-/merge_requests/new?merge_request[source_branch]=${encodedBranch}&merge_request[target_branch]=${encodedMain}`;
      case 'bitbucket':
        return `${webUrl}/pull-requests/new?source=${encodedBranch}&dest=${encodedMain}`;
      case 'azure-devops':
        return `${webUrl}/pullrequestcreate?sourceRef=${encodeURIComponent(`GB${branch}`)}&targetRef=${encodeURIComponent(`GB${mainBranch}`)}`;
      default:
        // Generic fallback - try GitHub-style
        return `${webUrl}/compare/${encodedMain}...${encodedBranch}?expand=1`;
    }
  }

  private async getRemoteRefs(repoPath: string): Promise<Map<string, string>> {
    const refs = new Map<string, string>();
    try {
      const output = await gitExec.execGitAsync(repoPath, [
        'for-each-ref',
        '--format=%(refname) %(objectname) %(symref)',
        'refs/remotes/',
      ]);
      for (const line of output.split('\n')) {
        const match = line.match(/^([^ ]+) ([a-f0-9]+)(?: (.*))?$/);
        // A symbolic ref such as origin/HEAD repeats the branch it points at.
        if (match && !match[3]) {
          refs.set(match[1], match[2]);
        }
      }
    } catch {
      // Ignore errors
    }
    return refs;
  }
}

export const gitBranchService = new GitBranchService();
