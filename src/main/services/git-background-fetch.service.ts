import { projectRepoPath } from '../../shared/lib/project-repo-path';
import { isMonitored } from '../../shared/lib/terminal-execution-state';
import { isSshWorkspace, type Workspace } from '../../shared/types/workspace';
import { createLogger } from '../lib/logger';
import { samePathKey } from '../lib/same-path';
import { needsSshPrompt } from '../lib/ssh-client';

import { configService } from './config.service';
import { RECENT_ORIGIN_FETCH_MS } from './git/git-branch';
import { gitService } from './git.service';
import { projectService } from './project.service';
import { remoteWorkspaceObservationService } from './remote-workspace-observation.service';
import { isSshConnectionFailure, sshHostStatusService } from './ssh-host-status.service';
import { sshWorkspaceService } from './ssh-workspace.service';
import { sshWorkspaceGit } from './workspace-git/ssh-git';
import { workspaceGitService } from './workspace-git.service';
import { workspaceStatusService } from './workspace-status.service';
import { workspaceService } from './workspace.service';

import type { Project } from '../../shared/types/project';

const logger = createLogger('GitBackgroundFetch');

/**
 * How long a repository's fetch stays fresh enough to skip: half as long as a fetch lets new
 * workspaces start without fetching, so the fetch the New Workspace dialog asks for as it opens
 * still counts once the prompt is typed.
 */
export const BACKGROUND_FETCH_INTERVAL_MS = RECENT_ORIGIN_FETCH_MS / 2;
/**
 * How often a repository's fetch brings every branch of origin, so lists of origin's branches
 * and pruning catch up. The fetches between bring just the branches Komla uses.
 */
export const EVERY_BRANCH_FETCH_INTERVAL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;

const sshCloneKey = (hostId: string, repoPath: string): string => `ssh:${hostId}:${repoPath}`;

/** A claimed fetch: whether it brings every branch, and how to give it back unfinished. */
type FetchClaim = { everyBranch: boolean; release: () => void };

// Git's rules for a branch name (`git check-ref-format --branch`), so a target typed with a
// space, or a base like `HEAD~1`, can't make the whole fetch fail.
function isBranchName(name: string): boolean {
  return (
    !/\p{Cc}|[\s~^:?*[\\]|\.\.|@\{|\/\/|^[-./]|[./]$|\/\.|\.lock(?:\/|$)/u.test(name) &&
    name !== '@'
  );
}

function branchName(name: string | undefined): string | undefined {
  const branch = name
    ?.trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/origin\//, '')
    .replace(/^origin\//, '');
  return branch && branch !== 'HEAD' && isBranchName(branch) ? branch : undefined;
}

/**
 * The branches of origin a repository's workspaces use: the targets, `main` and `master`, and
 * each workspace's branch and target.
 */
export function branchesInUse(
  targets: ReadonlyArray<string | undefined>,
  workspaces: readonly Workspace[]
): string[] {
  const names = [
    ...targets,
    'main',
    'master',
    ...workspaces.flatMap((workspace) => [
      workspace.branchName,
      workspace.baseBranch,
      ...(isSshWorkspace(workspace)
        ? [workspace.backend.baseBranch, workspace.backend.defaultBranch]
        : []),
    ]),
  ].map(branchName);
  return [...new Set(names.filter((name): name is string => !!name))].sort();
}

function restore(times: Map<string, number>, key: string, at: number | undefined): void {
  if (at === undefined) times.delete(key);
  else times.set(key, at);
}

/**
 * Fetches origin for the projects that have workspaces, so their commits behind (↓N) counts
 * include what was pushed elsewhere, and a new workspace can start from a recent copy of its
 * target branch without fetching first. A fetch brings just the branches Komla uses, and every
 * branch once an hour, so a large repository isn't fetched whole every few minutes. SSH hosts fetch their own clones, and only once Komla has
 * reached them. Git and ssh never prompt: a remote that needs a password or passphrase is
 * skipped, even one whose passphrase Komla remembers. An SSH agent that confirms each use still
 * asks.
 */
class GitBackgroundFetchService {
  private lastFetchAt = new Map<string, number>();
  private lastEveryBranchFetchAt = new Map<string, number>();
  // The fetch running in each repository or host clone; another waits for it rather than racing
  // it for the same refs, then fetches only what that one didn't.
  private fetching = new Map<string, Promise<boolean>>();
  private running: Promise<void> | null = null;
  private pending: { local: boolean; ssh: boolean } = { local: false, ssh: false };

  /**
   * Fetches each repository not fetched in the last few minutes: local ones one at a time,
   * alongside SSH ones one at a time.
   */
  fetchStale(): Promise<void> {
    return this.request({ local: true, ssh: true });
  }

  /**
   * Fetches one project's local repository, and its clone on `hostId` when given, unless they
   * were fetched in the last few minutes, so a workspace about to be created in it starts from a
   * recent copy of its target branch. With `everyBranch`, the local repository fetches every
   * branch, so a list of origin's branches is current. Settles once both are done, with whether
   * the local repository fetched.
   */
  async fetchProject(
    projectId: string,
    hostId: string | null = null,
    everyBranch = false
  ): Promise<boolean> {
    if (configService.get().gitBackgroundFetch === false) return false;
    const project = projectService.get(projectId);
    if (!project || project.kind === 'directory') return false;
    const [fetched] = await Promise.all([
      this.fetchLocalProject(project, everyBranch),
      hostId !== null && this.fetchProjectOnHost(project, hostId),
    ]);
    return fetched;
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

  // `fetch` hears whether the fetch it waited for fetched.
  private async oneAtATime(
    key: string,
    fetch: (waitedForFetch: boolean) => Promise<boolean>
  ): Promise<boolean> {
    const running = this.fetching.get(key);
    const next = (running ?? Promise.resolve(false)).then(fetch, () => fetch(false));
    this.fetching.set(key, next);
    try {
      return await next;
    } finally {
      if (this.fetching.get(key) === next) this.fetching.delete(key);
    }
  }

  private claim(key: string, everyBranchAsked = false): FetchClaim | undefined {
    const now = Date.now();
    const lastFetchAt = this.lastFetchAt.get(key);
    const lastEveryBranchAt = this.lastEveryBranchFetchAt.get(key);
    const since = (at: number | undefined) => (at === undefined ? Infinity : now - at);
    if (since(everyBranchAsked ? lastEveryBranchAt : lastFetchAt) < BACKGROUND_FETCH_INTERVAL_MS) {
      return undefined;
    }
    const everyBranch =
      everyBranchAsked || since(lastEveryBranchAt) >= EVERY_BRANCH_FETCH_INTERVAL_MS;
    this.lastFetchAt.set(key, now);
    if (everyBranch) this.lastEveryBranchFetchAt.set(key, now);
    return {
      everyBranch,
      release: () => {
        restore(this.lastFetchAt, key, lastFetchAt);
        if (everyBranch) restore(this.lastEveryBranchFetchAt, key, lastEveryBranchAt);
      },
    };
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
      await this.fetchLocalProject(project);
    }
  }

  private fetchLocalProject(project: Project, everyBranchAsked = false): Promise<boolean> {
    const repoPath = projectRepoPath(project);
    const key = samePathKey(repoPath);
    const managed = Boolean(project.managed && project.managedRepoPath);
    // Taken as it's asked for, so a workspace created while this waits behind another fetch,
    // or while it runs, stops it.
    const mark = gitService.backgroundMark(repoPath);
    return this.oneAtATime(key, async (waitedForFetch) => {
      if (gitService.backgroundMark(repoPath) !== mark) return false;
      const claim = this.claim(key, everyBranchAsked);
      // The fetch this waited for may have just brought what it asks for.
      if (!claim) return waitedForFetch;
      try {
        if (!(await gitService.hasRemote(repoPath, 'origin'))) return false;
        const branches = claim.everyBranch ? undefined : await this.localBranchesInUse(repoPath);
        await gitService.fetchOriginWithoutPrompts(
          repoPath,
          managed,
          FETCH_TIMEOUT_MS,
          mark,
          branches
        );
      } catch (error) {
        // A fetch a workspace creation stopped didn't finish, so the next request tries again.
        if (gitService.backgroundMark(repoPath) !== mark) claim.release();
        logger.debug('Background fetch skipped', {
          projectId: project.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      // Only in Komla's own clone: a user's branches move when they ask. A workspace creation
      // stops background work; leave its start point alone.
      if (managed) {
        await workspaceGitService
          .fastForwardProjectTargets(project.id, () => gitService.backgroundMark(repoPath) === mark)
          .catch((error: unknown) => {
            logger.debug('Fast-forwarding targets after a background fetch failed', {
              projectId: project.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      return true;
    });
  }

  // Every project in the repository counts: two projects can share one. One without a target
  // follows the repository's main branch.
  private async localBranchesInUse(repoPath: string): Promise<string[]> {
    const key = samePathKey(repoPath);
    const projects = projectService
      .list()
      .filter(
        (project) => project.kind !== 'directory' && samePathKey(projectRepoPath(project)) === key
      );
    const projectIds = new Set(projects.map((project) => project.id));
    const targets: Array<string | undefined> = projects.map((project) => project.baseBranch);
    if (projects.some((project) => !project.baseBranch?.trim())) {
      targets.push(await gitService.getMainBranch(repoPath).catch(() => undefined));
    }
    return branchesInUse(
      targets,
      workspaceService
        .list()
        .filter(
          (workspace) =>
            !isSshWorkspace(workspace) &&
            workspace.projectId !== null &&
            projectIds.has(workspace.projectId)
        )
    );
  }

  // The clone a new workspace clones into, once Komla knows the host's base path. Neither looking
  // it up nor the fetch connects or prompts; creation fetches what it still needs.
  private async fetchProjectOnHost(project: Project, hostId: string): Promise<void> {
    if (sshHostStatusService.get(hostId)?.state !== 'connected') return;
    try {
      const basePath = sshWorkspaceService.knownWorkspaceBasePath(hostId);
      if (basePath === undefined) return;
      const repoPath = sshWorkspaceService.managedRepoPath(basePath, project.name);
      await this.fetchSshClone(
        hostId,
        repoPath,
        workspaceService
          .list()
          .filter(
            (workspace) =>
              isSshWorkspace(workspace) &&
              workspace.backend.hostId === hostId &&
              workspace.backend.remoteRepoPath === repoPath
          ),
        project
      );
    } catch (error) {
      logger.debug('Background fetch skipped', {
        projectId: project.id,
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
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
      const key = sshCloneKey(hostId, remoteRepoPath);
      const clone = clones.get(key) ?? { hostId, repoPath: remoteRepoPath, workspaces: [] };
      clone.workspaces.push(workspace);
      clones.set(key, clone);
    }
    for (const { hostId, repoPath, workspaces } of clones.values()) {
      await this.fetchSshClone(hostId, repoPath, workspaces);
    }
  }

  // `project` is the one a new workspace is about to start in, which may have none there yet.
  private fetchSshClone(
    hostId: string,
    repoPath: string,
    workspaces: Workspace[],
    project?: Project
  ): Promise<boolean> {
    const key = sshCloneKey(hostId, repoPath);
    return this.oneAtATime(key, async (waitedForFetch) => {
      const claim = this.claim(key);
      if (!claim) return waitedForFetch;
      const targets = [
        project?.baseBranch,
        ...workspaces.map((workspace) =>
          workspace.projectId ? projectService.get(workspace.projectId)?.baseBranch : undefined
        ),
      ];
      try {
        const moved = await sshWorkspaceGit.fetchOriginWithoutPrompts(
          hostId,
          repoPath,
          FETCH_TIMEOUT_MS,
          claim.everyBranch ? undefined : branchesInUse(targets, workspaces)
        );
        if (moved) await this.refreshAfterFetch(hostId, workspaces);
        return true;
      } catch (error) {
        // A host that dropped mid-fetch fetches again as soon as it answers.
        if (isSshConnectionFailure(error) && !needsSshPrompt(error)) claim.release();
        logger.debug('Background fetch skipped', {
          hostId,
          repoPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    });
  }

  private async refreshAfterFetch(hostId: string, workspaces: Workspace[]): Promise<void> {
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
  }
}

export const gitBackgroundFetchService = new GitBackgroundFetchService();
