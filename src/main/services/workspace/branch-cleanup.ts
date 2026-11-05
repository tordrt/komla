import { realpath } from 'fs/promises';

import { projectRepoPath } from '../../../shared/lib/project-repo-path';
import {
  getBranchesInUse,
  hasWorkspaceFiles,
  isSshWorkspace,
  resolveWorkspaceTargetBranch,
  toLocalBranchName,
} from '../../../shared/types/workspace';
import { createLogger } from '../../lib/logger';
import {
  CHECK_CONCURRENCY,
  localGitBatchRunner,
  mapWithConcurrency,
  type GitBatchRunner,
  type WorktreeHead,
} from '../git/git-branch-cleanup';
import { gitService } from '../git.service';
import { projectService } from '../project.service';
import { sshWorkspaceService } from '../ssh-workspace.service';
import { sshWorkspaceGit } from '../workspace-git/ssh-git';

import { workspaceStore } from './store';

import type { WorkspaceCleanupStatus } from '../../../shared/types';

const logger = createLogger('WorkspaceService');

/**
 * A git project's clone on this computer, or on an SSH host where it has workspaces, its
 * target branch, and the branches leftover-branch cleanup leaves alone. A managed clone and
 * a host's clone are bare, with a local copy of every branch on origin.
 */
export async function getBranchCleanupScope(projectId: string, hostId: string | null = null) {
  const project = projectService.get(projectId);
  if (!project) throw new Error('Project not found');
  if (project.kind === 'directory') throw new Error('Directory projects have no branches');
  const workspaces = workspaceStore.getWorkspacesByProjectId(projectId);
  if (hostId) {
    const backend = workspaces
      .filter(isSshWorkspace)
      .map((workspace) => workspace.backend)
      .find((candidate) => candidate.hostId === hostId);
    if (!backend) throw new Error('The project has no workspaces on this host');
    // Empty: the host clone's HEAD, which is origin's default branch.
    const targetBranch = toLocalBranchName(project.baseBranch ?? '');
    // Another project can share the clone when it has the same name and origin.
    const sharing = [...workspaceStore.workspaces.values()].filter(
      (workspace) =>
        isSshWorkspace(workspace) &&
        workspace.backend.hostId === hostId &&
        workspace.backend.remoteRepoPath === backend.remoteRepoPath
    );
    return {
      repo: sshWorkspaceGit.gitBatchRunner(hostId, backend.remoteRepoPath),
      targetBranch,
      keep: getBranchesInUse(targetBranch ? [targetBranch] : [], [...workspaces, ...sharing]),
      skipBranchesOnOrigin: true,
    };
  }
  const repoPath = projectRepoPath(project);
  const mainBranch = await gitService.getMainBranch(repoPath);
  const targetBranch = toLocalBranchName(project.baseBranch ?? '') || mainBranch;
  return {
    repo: localGitBatchRunner(repoPath),
    targetBranch,
    keep: getBranchesInUse([mainBranch, targetBranch], workspaces),
    skipBranchesOnOrigin: project.managed,
  };
}

/**
 * How each of the project's worktree workspaces on this computer, or on one SSH host when
 * hostId is set, stands against its target branch. Each worktree's HEAD and uncommitted files
 * are read in the worktree itself, on its SSH host for an SSH workspace; whether HEAD landed is
 * then checked once per repository and target branch, in the project's repository the worktree
 * belongs to. Workspaces in the Trash, or whose files aren't ready, are left out.
 */
export async function checkWorkspacesForCleanup(
  projectId: string,
  hostId: string | null = null
): Promise<WorkspaceCleanupStatus[]> {
  const project = projectService.get(projectId);
  if (!project) throw new Error('Project not found');
  if (project.kind === 'directory') return [];
  const workspaces = workspaceStore.getWorkspacesByProjectId(projectId).filter(
    (workspace) =>
      workspace.status === 'active' &&
      workspace.isWorktree &&
      hasWorkspaceFiles(workspace) &&
      // Each location is checked on its own, so a host that can't be reached holds up only its
      // own workspaces, not this computer's or another host's.
      (isSshWorkspace(workspace) ? workspace.backend.hostId : null) === hostId
  );
  const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const once = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
    const loaded = cache.get(key) ?? load();
    cache.set(key, loaded);
    return loaded;
  };
  const gitDirOf = (path: string) => gitService.getCommonGitDir(path).then((dir) => realpath(dir));
  // Where a local worktree may come from, as managedWorktree() allows.
  const localRepos = [...new Set([project.managedRepoPath, project.repositoryPath])].filter(
    (repoPath): repoPath is string => !!repoPath
  );
  const repoGitDirs = new Map<string, Promise<string | null>>();
  const mainBranches = new Map<string, Promise<string>>();
  /** The project repository whose Git directory the worktree shares, if any. */
  const localRepoOf = async (worktreePath: string) => {
    const gitDir = await gitDirOf(worktreePath);
    for (const repoPath of localRepos) {
      const repoGitDir = await once(repoGitDirs, repoPath, () =>
        gitDirOf(repoPath).catch(() => null)
      );
      if (repoGitDir === gitDir) return repoPath;
    }
    throw new Error("The workspace isn't a worktree of the project's repository");
  };

  const statuses = new Map<string, WorkspaceCleanupStatus>();
  const groups = new Map<
    string,
    { repo: GitBatchRunner; targetBranch: string; heads: Array<WorktreeHead & { id: string }> }
  >();
  await mapWithConcurrency(workspaces, CHECK_CONCURRENCY, async (workspace) => {
    const ssh = isSshWorkspace(workspace) ? workspace.backend : null;
    const branch = toLocalBranchName(
      resolveWorkspaceTargetBranch(workspace, project.baseBranch) ?? ''
    );
    let targetBranch = branch || toLocalBranchName(ssh?.defaultBranch ?? '') || 'main';
    try {
      const head = await gitService.readWorktreeForCleanup(
        ssh
          ? sshWorkspaceGit.gitBatchRunner(ssh.hostId, ssh.remoteDirectory)
          : localGitBatchRunner(workspace.workingDirectory)
      );
      let repo: GitBatchRunner;
      if (ssh) {
        repo = sshWorkspaceGit.gitBatchRunner(ssh.hostId, ssh.remoteRepoPath);
      } else {
        const repoPath = await localRepoOf(workspace.workingDirectory);
        if (!branch) {
          targetBranch = await once(mainBranches, repoPath, () =>
            gitService.getMainBranch(repoPath).catch(() => 'main')
          );
        }
        repo = localGitBatchRunner(repoPath);
      }
      const key = `${repo.label}\0${targetBranch}`;
      const group = groups.get(key) ?? { repo, targetBranch, heads: [] };
      group.heads.push({ id: workspace.id, ...head });
      groups.set(key, group);
    } catch (error) {
      logger.warn('Could not read workspace for cleanup', { workspaceId: workspace.id, error });
      const status = { targetBranch, ok: false as const, error: failure(error) };
      statuses.set(workspace.id, { workspaceId: workspace.id, ...status });
    }
  });

  // The worktrees of one repository share its history, so its target is read once for all.
  await mapWithConcurrency([...groups.values()], CHECK_CONCURRENCY, async (group) => {
    const { repo, targetBranch, heads } = group;
    try {
      const commits = heads.map(({ commit }) => commit);
      const landed = await gitService.findLandedCommits(repo, targetBranch, commits);
      heads.forEach(({ id, uncommittedChanges }, index) =>
        statuses.set(id, {
          workspaceId: id,
          targetBranch,
          ok: true,
          landed: landed[index],
          uncommittedChanges,
        })
      );
    } catch (error) {
      logger.warn('Could not check workspaces for cleanup', { repo: repo.label, error });
      for (const { id } of heads) {
        statuses.set(id, { workspaceId: id, targetBranch, ok: false, error: failure(error) });
      }
    }
  });
  return workspaces.flatMap((workspace) => statuses.get(workspace.id) ?? []);
}

/**
 * Branches in the SSH host's clone of the project with commits origin doesn't have, most
 * recent first. The bare clone copied every origin branch into refs/heads when it was
 * made and never updates those copies, so only a branch whose tip is new counts.
 */
export async function listHostBranches(projectId: string, hostId: string): Promise<string[]> {
  const project = projectService.get(projectId);
  if (!project || project.kind === 'directory') return [];
  // The clone a new workspace uses, which may not exist yet.
  const remoteRepoPath = sshWorkspaceService.managedRepoPath(
    await sshWorkspaceService.resolveWorkspaceBasePath(hostId),
    project.name
  );
  const [heads, unpublished] = await sshWorkspaceGit.gitBatchRunner(hostId, remoteRepoPath).run([
    {
      args: [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(objectname) %(refname:short)',
        'refs/heads',
      ],
    },
    { args: ['rev-list', '--branches', '--not', '--remotes=origin'] },
  ]);
  if (!heads?.ok || !unpublished?.ok) return [];
  const newCommits = new Set(unpublished.output.split('\n').filter(Boolean));
  return heads.output.split('\n').flatMap((line) => {
    const [commit, name] = line.split(' ');
    return name && newCommits.has(commit) ? [name] : [];
  });
}
