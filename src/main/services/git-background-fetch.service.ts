import { projectRepoPath } from '../../shared/lib/project-repo-path';
import { isMonitored } from '../../shared/lib/terminal-execution-state';
import { isSshWorkspace, type Workspace } from '../../shared/types/workspace';
import { createLogger } from '../lib/logger';
import { needsSshPrompt } from '../lib/ssh-client';

import { configService } from './config.service';
import { gitService } from './git.service';
import { projectService } from './project.service';
import { remoteWorkspaceObservationService } from './remote-workspace-observation.service';
import { isSshConnectionFailure, sshHostStatusService } from './ssh-host-status.service';
import { sshWorkspaceGit } from './workspace-git/ssh-git';
import { workspaceStatusService } from './workspace-status.service';
import { workspaceService } from './workspace.service';

const logger = createLogger('GitBackgroundFetch');

/** How long a repository's fetch stays fresh enough to skip. */
export const BACKGROUND_FETCH_INTERVAL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Fetches origin for the projects that have workspaces, so their commits behind (↓N) counts
 * include what was pushed elsewhere. SSH hosts fetch their own clones, and only once Komla has
 * reached them. Git and ssh never prompt: a remote that needs a password or passphrase is
 * skipped, even one whose passphrase Komla remembers. An SSH agent that confirms each use still
 * asks.
 */
class GitBackgroundFetchService {
  private lastFetchAt = new Map<string, number>();
  private running: Promise<void> | null = null;
  private pending: { local: boolean; ssh: boolean } = { local: false, ssh: false };

  /**
   * Fetches each repository not fetched in the last few minutes: local ones one at a time,
   * alongside SSH ones one at a time.
   */
  fetchStale(): Promise<void> {
    return this.request({ local: true, ssh: true });
  }

  /** Fetches just the SSH clones, for a host that just answered. */
  fetchStaleOnSshHosts(): Promise<void> {
    return this.request({ local: false, ssh: true });
  }

  // A request during a run runs once more afterwards, so a host that answers mid-run is fetched.
  private request(scope: { local: boolean; ssh: boolean }): Promise<void> {
    if (configService.get().gitBackgroundFetch === false) return Promise.resolve();
    this.pending = { local: this.pending.local || scope.local, ssh: this.pending.ssh || scope.ssh };
    this.running ??= (async () => {
      while (this.pending.local || this.pending.ssh) {
        const { local, ssh } = this.pending;
        this.pending = { local: false, ssh: false };
        await Promise.all([local && this.fetchLocal(), ssh && this.fetchSsh()]);
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private claim(key: string): boolean {
    const lastFetchAt = this.lastFetchAt.get(key);
    if (lastFetchAt !== undefined && Date.now() - lastFetchAt < BACKGROUND_FETCH_INTERVAL_MS) {
      return false;
    }
    this.lastFetchAt.set(key, Date.now());
    return true;
  }

  private async fetchLocal(): Promise<void> {
    const projectIds = new Set(
      workspaceService
        .list()
        .filter((workspace) => !isSshWorkspace(workspace))
        .map((workspace) => workspace.projectId)
    );
    for (const project of projectService.list()) {
      if (project.kind === 'directory' || !projectIds.has(project.id)) continue;
      const repoPath = projectRepoPath(project);
      if (!this.claim(repoPath)) continue;
      // Creating a workspace stops this fetch, also in the checks before it.
      const mark = gitService.backgroundMark(repoPath);
      try {
        if (!(await gitService.hasRemote(repoPath, 'origin'))) continue;
        await gitService.fetchOriginWithoutPrompts(
          repoPath,
          Boolean(project.managed && project.managedRepoPath),
          FETCH_TIMEOUT_MS,
          mark
        );
      } catch (error) {
        logger.debug('Background fetch skipped', {
          projectId: project.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async fetchSsh(): Promise<void> {
    const gitProjectIds = new Set<string | null>(
      projectService
        .list()
        .filter((project) => project.kind !== 'directory')
        .map((project) => project.id)
    );
    // Workspaces on a host share its clone, so each clone is fetched once.
    const clones = new Map<string, { hostId: string; repoPath: string; workspaces: Workspace[] }>();
    for (const workspace of workspaceService.list()) {
      if (!isSshWorkspace(workspace) || !gitProjectIds.has(workspace.projectId)) continue;
      const { hostId, remoteRepoPath } = workspace.backend;
      if (sshHostStatusService.get(hostId)?.state !== 'connected') continue;
      const key = `ssh:${hostId}:${remoteRepoPath}`;
      const clone = clones.get(key) ?? { hostId, repoPath: remoteRepoPath, workspaces: [] };
      clone.workspaces.push(workspace);
      clones.set(key, clone);
    }
    for (const [key, { hostId, repoPath, workspaces }] of clones) {
      if (!this.claim(key)) continue;
      try {
        if (
          !(await sshWorkspaceGit.fetchOriginWithoutPrompts(hostId, repoPath, FETCH_TIMEOUT_MS))
        ) {
          continue;
        }
        // A running Remote Companion reports the workspaces it watches when their refs move.
        const watched = !!remoteWorkspaceObservationService.companionForHost(hostId);
        await Promise.all(
          workspaces
            .filter(
              (workspace) =>
                !(watched && isMonitored(workspace)) && !workspaceService.isDeleting(workspace.id)
            )
            .map((workspace) =>
              workspaceStatusService
                .change({ kind: 'refresh-requested', workspaceId: workspace.id, reason: 'fetched' })
                .catch((error: unknown) => {
                  logger.debug('Status refresh after background fetch failed', {
                    workspaceId: workspace.id,
                    error: error instanceof Error ? error.message : String(error),
                  });
                })
            )
        );
      } catch (error) {
        // A host that dropped mid-fetch fetches again as soon as it answers.
        if (isSshConnectionFailure(error) && !needsSshPrompt(error)) this.lastFetchAt.delete(key);
        logger.debug('Background fetch skipped', {
          hostId,
          repoPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export const gitBackgroundFetchService = new GitBackgroundFetchService();
