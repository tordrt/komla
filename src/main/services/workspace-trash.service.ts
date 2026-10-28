import { IPC } from '../../shared/constants/ipc-channels';
import { projectRepoPath } from '../../shared/lib/project-repo-path';
import { countUnpushedBranchCommits } from '../../shared/lib/workspace-branch-status';
import { isSshWorkspace, TRASH_RETENTION_MS, type Workspace } from '../../shared/types';
import { createLogger } from '../lib/logger';

import { gitExec } from './git/git-exec';
import { localMirrorService } from './local-mirror.service';
import { projectService } from './project.service';
import { windowService } from './window.service';
import { workspaceService } from './workspace.service';

const logger = createLogger('WorkspaceTrash');

// Startup has enough to do; the Trash waits a minute.
const FIRST_CHECK_DELAY_MS = 60_000;
// A workspace whose time ran out while the computer slept, or whose host was offline, goes at
// the next check.
const CHECK_INTERVAL_MS = 60 * 60_000;

export interface WorkspaceTrashDependencies {
  workspaces: () => Iterable<Workspace>;
  /** Deletes the workspace for good; rejects when it couldn't, to try again at the next check. */
  deleteForGood: (workspace: Workspace) => Promise<void>;
  /** Removes local copies whose workspace is gone or in the Trash, until `stopped`. */
  removeLeftoverLocalCopies: (stopped: () => boolean) => Promise<void>;
  now: () => number;
}

/**
 * Deletes workspaces for good once their time in the Trash is up, and removes local copies a
 * workspace left behind.
 */
export class WorkspaceTrash {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private checking: Promise<void> | undefined;
  // Counts stops, so a check or tick under way can tell it was stopped.
  private stops = 0;

  constructor(private readonly dependencies: WorkspaceTrashDependencies) {}

  start(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), FIRST_CHECK_DELAY_MS);
    this.timer.unref?.();
  }

  /** Stops checking. Resolves once a check under way finishes the deletion or removal it is on. */
  stop(): Promise<void> {
    this.stops += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.checking ?? Promise.resolve();
  }

  /** Deletes each workspace whose time in the Trash is up, one at a time, then leftover copies. */
  check(): Promise<void> {
    this.checking ??= this.empty().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private tick(): void {
    const stops = this.stops;
    void this.check().finally(() => {
      if (this.stops !== stops) return;
      this.timer = setTimeout(() => this.tick(), CHECK_INTERVAL_MS);
      this.timer.unref?.();
    });
  }

  private async empty(): Promise<void> {
    const stops = this.stops;
    await this.deleteExpired(stops);
    if (this.stops !== stops) return;
    try {
      await this.dependencies.removeLeftoverLocalCopies(() => this.stops !== stops);
    } catch (error) {
      logger.warn('Could not remove leftover local copies', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async deleteExpired(stops: number): Promise<void> {
    const expired = [...this.dependencies.workspaces()].filter(
      (workspace) =>
        workspace.status === 'trashed' &&
        workspace.trashedAt !== undefined &&
        workspace.trashedAt + TRASH_RETENTION_MS <= this.dependencies.now()
    );
    for (const workspace of expired) {
      if (this.stops !== stops) return;
      try {
        await this.dependencies.deleteForGood(workspace);
      } catch (error) {
        logger.warn('Could not delete a workspace whose time in the Trash is up', {
          workspaceId: workspace.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/**
 * Whether deleting the workspace's branch would lose no commits: another branch or a remote has
 * every one of them. Anything git can't answer keeps the branch. An SSH host isn't watched while
 * its workspace is in the Trash, so the last status it reported stands in.
 */
async function branchHoldsNoUnpushedWork(workspace: Workspace): Promise<boolean> {
  if (isSshWorkspace(workspace)) {
    const status = workspace.lastKnownGitStatus?.branch;
    return status !== undefined && countUnpushedBranchCommits(status) === 0;
  }
  const project = workspace.projectId ? projectService.get(workspace.projectId) : undefined;
  if (!project || !workspace.branchName) return false;
  // Asked of the repository, not the worktree, which may be gone.
  const count = await gitExec
    .execGitAsync(projectRepoPath(project), [
      'rev-list',
      '--count',
      `refs/heads/${workspace.branchName}`,
      '--not',
      `--exclude=${workspace.branchName}`,
      '--branches',
      '--remotes',
    ])
    .catch(() => undefined);
  return count === '0';
}

export const workspaceTrash = new WorkspaceTrash({
  workspaces: () => workspaceService.list(),
  deleteForGood: async (workspace) => {
    // It may have been restored, or deleted, while an earlier one was being deleted.
    if (workspaceService.get(workspace.id)?.status !== 'trashed') return;
    // A branch with commits found nowhere else stays for the branch cleanup to offer.
    const deleteBranch = await branchHoldsNoUnpushedWork(workspace);
    if (workspaceService.get(workspace.id)?.status !== 'trashed') return;
    await workspaceService.delete(workspace.id, true, deleteBranch);
    logger.info('Deleted a workspace whose time in the Trash was up', {
      workspaceId: workspace.id,
      deleteBranch,
    });
    windowService.broadcastToAll(IPC.WORKSPACES_CHANGED);
  },
  removeLeftoverLocalCopies: (stopped) =>
    localMirrorService.removeLeftovers(
      (workspaceId) => workspaceService.get(workspaceId)?.status === 'active',
      stopped
    ),
  now: () => Date.now(),
});
