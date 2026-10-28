import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

import { createLogger } from '../../lib/logger';
import { removePath } from '../../lib/remove-path';

import { gitExec } from './git-exec';

const logger = createLogger('GitService');

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
}

export interface CreatedWorktree {
  path: string;
  /** Whether the branch was created along with the worktree, rather than already existing. */
  createdBranch: boolean;
}

export type BranchFastForward =
  | { status: 'fast-forwarded' }
  | { status: 'checked-out'; worktreePath: string };

function resolveWorktreePath(
  repoPath: string,
  branchName: string,
  worktreeDestination: string | undefined
): string {
  const safeBranchName = branchName.replace(/\//g, '-');
  const worktreePath = worktreeDestination || join(repoPath, '.worktrees', safeBranchName);
  if (existsSync(worktreePath)) {
    throw new Error(`Worktree already exists at ${worktreePath}`);
  }
  const parentDir = dirname(worktreePath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }
  return worktreePath;
}

async function localBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await gitExec.execGitAsync(repoPath, ['rev-parse', '--verify', `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

async function probeRemoteBranch(
  repoPath: string,
  branchName: string,
  fetchRemote: boolean
): Promise<boolean> {
  try {
    const hasOrigin = await gitExec.hasRemote(repoPath, 'origin');
    if (!hasOrigin) return false;

    let confirmed = false;
    try {
      await gitExec.execGitAsync(repoPath, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${branchName}`,
      ]);
      confirmed = true;
    } catch {
      // No local remote-tracking ref — branch is likely brand-new
    }

    if (fetchRemote && confirmed) {
      try {
        await gitExec.execGitWithProgress(
          repoPath,
          ['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`],
          undefined,
          { enableAskpass: true }
        );
      } catch {
        // Branch might have been deleted from remote — that's fine
      }
    }
    return confirmed;
  } catch {
    return false;
  }
}

async function fastForwardLocalToRemote(repoPath: string, branchName: string): Promise<void> {
  try {
    await gitExec.execGitAsync(repoPath, [
      'merge-base',
      '--is-ancestor',
      `refs/heads/${branchName}`,
      `refs/remotes/origin/${branchName}`,
    ]);
  } catch {
    return; // Not a fast-forward (local has diverged) — leave local branch as-is
  }
  try {
    await gitWorktreeService.fastForwardBranch(
      repoPath,
      branchName,
      `refs/remotes/origin/${branchName}`
    );
  } catch (updateError) {
    logger.warn('Failed to fast-forward local branch to remote', {
      branchName,
      error: (updateError as Error).message,
    });
  }
}

function isInvalidReferenceError(error: unknown): boolean {
  const message = (error as Error)?.message || String(error);
  return message.toLowerCase().includes('invalid reference');
}

async function repoHasAnyCommit(repoPath: string): Promise<boolean> {
  try {
    const commit = await gitExec.execGitAsync(repoPath, ['rev-list', '--all', '--max-count=1']);
    return commit.length > 0;
  } catch {
    return false;
  }
}

async function isCheckedOutUnbornBranch(repoPath: string, branchName: string): Promise<boolean> {
  try {
    const isBare = await gitExec.execGitAsync(repoPath, ['rev-parse', '--is-bare-repository']);
    if (isBare.trim() === 'true') return false;

    const currentBranch = await gitExec.execGitAsync(repoPath, ['symbolic-ref', '--short', 'HEAD']);
    return currentBranch.trim() === branchName;
  } catch {
    return false;
  }
}

async function runWorktreeAdd(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string | undefined,
  branchExists: boolean,
  confirmedRemoteBranch: boolean
): Promise<void> {
  if (branchExists) {
    if (confirmedRemoteBranch) await fastForwardLocalToRemote(repoPath, branchName);
    await gitExec.execGitAsync(repoPath, ['worktree', 'add', worktreePath, branchName]);
    return;
  }
  if (confirmedRemoteBranch) {
    await gitExec.execGitAsync(repoPath, [
      'worktree',
      'add',
      '-b',
      branchName,
      worktreePath,
      `origin/${branchName}`,
    ]);
    return;
  }
  if (!(await repoHasAnyCommit(repoPath))) {
    if (await isCheckedOutUnbornBranch(repoPath, branchName)) {
      throw new Error(
        `Cannot create worktree for branch "${branchName}" because this repository has no commits yet and that branch is already checked out. Create an initial commit or choose a different branch name, then try again.`
      );
    }
    await gitExec.execGitAsync(repoPath, ['worktree', 'add', '-b', branchName, worktreePath]);
    return;
  }
  const startPoint = baseBranch || (await gitExec.getMainBranch(repoPath));
  // Git would otherwise make the new branch track e.g. origin/main; upstream
  // tracking for the branch's own name is set afterwards.
  const trackArgs = /^(?:origin\/|refs\/remotes\/)/.test(startPoint) ? ['--no-track'] : [];
  await gitExec.execGitAsync(repoPath, [
    'worktree',
    'add',
    ...trackArgs,
    '-b',
    branchName,
    worktreePath,
    startPoint,
  ]);
}

async function writeUpstreamConfig(worktreePath: string, branchName: string): Promise<void> {
  let remoteConfigWritten = false;
  try {
    await gitExec.execGitAsync(worktreePath, ['config', `branch.${branchName}.remote`, 'origin']);
    remoteConfigWritten = true;
    await gitExec.execGitAsync(worktreePath, [
      'config',
      `branch.${branchName}.merge`,
      `refs/heads/${branchName}`,
    ]);
  } catch (error) {
    if (remoteConfigWritten) {
      try {
        await gitExec.execGitAsync(worktreePath, [
          'config',
          '--unset-all',
          `branch.${branchName}.remote`,
        ]);
      } catch {
        // Best-effort rollback; keep the original failure as the warning signal.
      }
    }
    throw error;
  }
}

async function setUpstreamTracking(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  confirmedRemoteBranch: boolean
): Promise<void> {
  // Use an exact ref lookup since short refs like "origin/main" may not resolve
  // in bare repos, and prefix-based ref queries can match nested branch names.
  // We set the config directly rather than using `git branch --set-upstream-to`,
  // which also requires ref resolution.
  try {
    let remoteBranchExists = confirmedRemoteBranch;
    if (!remoteBranchExists) {
      const hasOrigin = await gitExec.hasRemote(repoPath, 'origin');
      if (hasOrigin) {
        try {
          await gitExec.execGitAsync(repoPath, [
            'show-ref',
            '--verify',
            '--quiet',
            `refs/remotes/origin/${branchName}`,
          ]);
          remoteBranchExists = true;
        } catch {
          // Remote branch doesn't exist; leave tracking unset for local-only branches.
        }
      }
    }
    if (remoteBranchExists) {
      await writeUpstreamConfig(worktreePath, branchName);
    }
  } catch (error) {
    logger.warn('Failed to set upstream tracking', {
      branchName,
      error: (error as Error).message,
    });
  }
}

class GitWorktreeService {
  /**
   * Fast-forward a branch that no worktree has checked out to `toRef`, without a checkout.
   * Git updates the ref atomically and fails when the update is not a fast-forward, or
   * (Git 2.35+) when a worktree has the branch checked out; the check here covers older Git.
   */
  async fastForwardBranch(
    repoPath: string,
    branchName: string,
    toRef: string
  ): Promise<BranchFastForward> {
    for (const worktree of await this.listWorktrees(repoPath)) {
      if (worktree.branch === branchName) {
        return { status: 'checked-out', worktreePath: worktree.path };
      }
    }
    const commit = await gitExec.execGitAsync(repoPath, [
      'rev-parse',
      '--verify',
      `${toRef}^{commit}`,
    ]);
    // Moving a local branch must not replace the user's FETCH_HEAD or start maintenance.
    // Git before 2.29 has no --no-write-fetch-head, and there the fetch still writes it.
    const fetch = (extraArgs: string[]) =>
      gitExec.execGitAsync(repoPath, [
        '-c',
        'maintenance.auto=false',
        '-c',
        'gc.auto=0',
        'fetch',
        ...extraArgs,
        '--no-tags',
        '--no-prune',
        '--no-recurse-submodules',
        '.',
        `${commit}:refs/heads/${branchName}`,
      ]);
    try {
      await fetch(['--no-write-fetch-head']);
    } catch (error) {
      if (!(error as Error).message.includes('no-write-fetch-head')) throw error;
      await fetch([]);
    }
    return { status: 'fast-forwarded' };
  }

  async createWorktree(
    repoPath: string,
    branchName: string,
    worktreeDestination?: string,
    baseBranch?: string,
    options?: { fetchRemote?: boolean }
  ): Promise<CreatedWorktree> {
    const worktreePath = resolveWorktreePath(repoPath, branchName, worktreeDestination);
    const branchExists = await localBranchExists(repoPath, branchName);
    const confirmedRemoteBranch = await probeRemoteBranch(
      repoPath,
      branchName,
      options?.fetchRemote ?? false
    );

    await runWorktreeAdd(
      repoPath,
      worktreePath,
      branchName,
      baseBranch,
      branchExists,
      confirmedRemoteBranch
    ).catch(async (error) => {
      if (isInvalidReferenceError(error) && !(await repoHasAnyCommit(repoPath))) {
        throw new Error(
          `Cannot create branch "${branchName}" because this repository has no commits yet. Create an initial commit on the target branch, then try again.`
        );
      }
      throw error;
    });
    await setUpstreamTracking(repoPath, worktreePath, branchName, confirmedRemoteBranch);
    // `worktree add -b` fails if the branch appeared since the check, so this stays accurate.
    return { path: worktreePath, createdBranch: !branchExists };
  }

  async deleteWorktree(
    repoPath: string,
    worktreePath: string,
    force = false,
    options?: { deleteBranch?: boolean; branchName?: string }
  ): Promise<void> {
    // Check if worktree has uncommitted changes
    if (!force) {
      try {
        const status = await gitExec.execGitAsync(worktreePath, ['status', '--porcelain']);
        if (status) {
          throw new Error('Worktree has uncommitted changes. Use force to delete anyway.');
        }
      } catch (error) {
        if ((error as Error).message.includes('uncommitted')) {
          throw error;
        }
        // Worktree might not exist, continue with deletion
      }
    }

    // Try to remove the worktree via git
    let worktreeRemoved = false;
    try {
      const removeArgs = ['worktree', 'remove'];
      if (force) removeArgs.push('--force');
      removeArgs.push(worktreePath);
      await gitExec.execGitAsync(repoPath, removeArgs);
      worktreeRemoved = true;
    } catch (error) {
      // Log but don't fail - we'll still clean up the directory and allow workspace deletion
      logger.warn('Failed to remove worktree via git, will clean up directory manually', {
        worktreePath,
        error: (error as Error).message,
      });
    }

    // Clean up directory if it still exists. On Windows a folder can't be removed while a
    // process has it open or as its cwd, and the agents and git commands a terminal started
    // there can outlive its shell by a few seconds, so retry for about 5.5 s. Elsewhere those
    // errors don't clear by waiting.
    if (existsSync(worktreePath)) {
      try {
        await removePath(worktreePath, {
          recursive: true,
          force: true,
          ...(process.platform === 'win32' && { maxRetries: 10, retryDelay: 100 }),
        });
      } catch (error) {
        if (existsSync(worktreePath)) {
          throw error;
        }
        logger.warn('Worktree directory cleanup reported an error after path disappeared', {
          worktreePath,
          error: (error as Error).message,
        });
      }
    }

    // Prune worktree references if we couldn't remove it properly
    if (!worktreeRemoved) {
      try {
        await gitExec.execGitAsync(repoPath, ['worktree', 'prune']);
      } catch {
        // Ignore prune errors
      }
    }

    // Delete the local branch only if explicitly requested
    const { deleteBranch, branchName } = options || {};
    if (
      deleteBranch &&
      branchName &&
      branchName !== 'main' &&
      branchName !== 'master' &&
      branchName !== 'HEAD'
    ) {
      try {
        // Delete the local branch (use -D to force delete even if not fully merged)
        await gitExec.execGitAsync(repoPath, ['branch', '-D', branchName]);
        logger.info('Deleted local branch', { branchName });
      } catch (error) {
        // Log but don't fail - branch might already be deleted or in use elsewhere
        logger.warn('Failed to delete local branch', {
          branchName,
          error: (error as Error).message,
        });
      }
    }
  }

  async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const output = await gitExec.execGitAsync(repoPath, ['worktree', 'list', '--porcelain']);
    const worktrees: WorktreeInfo[] = [];

    const entries = output.split('\n\n').filter(Boolean);
    for (const entry of entries) {
      const lines = entry.split('\n');
      const worktree: Partial<WorktreeInfo> = {};

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          worktree.path = line.slice(9);
        } else if (line.startsWith('HEAD ')) {
          worktree.commit = line.slice(5);
        } else if (line.startsWith('branch ')) {
          worktree.branch = line.slice(7).replace('refs/heads/', '');
        }
      }

      if (worktree.path && worktree.branch) {
        worktrees.push(worktree as WorktreeInfo);
      }
    }

    return worktrees;
  }
}

export const gitWorktreeService = new GitWorktreeService();
