import { projectRepoPath } from '../../shared/lib/project-repo-path';
import { isSshWorkspace } from '../../shared/types/workspace';

import { gitService } from './git.service';
import { projectService } from './project.service';
import { workspaceStatusService } from './workspace-status.service';

import type { Workspace } from '../../shared/types/workspace';

/** How long Komla trusts a project's origin URL before reading it again, as after it changed. */
const REPOSITORY_URL_TTL_MS = 5 * 60_000;

export interface WorkspaceEnvironmentDependencies {
  /** Names of the workspace's project, its id and name, that `projects` can match. */
  getProjectKeys(workspace: Workspace): string[];
  /** The branch checked out in the workspace, none when it's detached. */
  getBranch(workspace: Workspace): string | undefined;
  /** The URL of the origin of the workspace's repository, without credentials. */
  getRepositoryUrl(workspace: Workspace): Promise<string | undefined>;
}

/**
 * What a command Komla runs for a workspace, a hook, status item or panel, gets about it, wherever
 * it runs: its id, which the `komla` CLI acts on, its name, branch, project and repository.
 */
export async function workspaceEnvironment(
  workspace: Workspace,
  dependencies: WorkspaceEnvironmentDependencies
): Promise<Record<string, string>> {
  const project = dependencies.getProjectKeys(workspace).find((key) => key !== workspace.projectId);
  const branch = dependencies.getBranch(workspace);
  const repositoryUrl = await dependencies.getRepositoryUrl(workspace).catch(() => undefined);
  return {
    KOMLA_WORKSPACE_ID: workspace.id,
    // The title the sidebar shows, as the user or Komla named it.
    KOMLA_WORKSPACE_NAME: workspace.customName || workspace.name,
    ...(branch && { KOMLA_BRANCH: branch }),
    ...(project && { KOMLA_PROJECT: project }),
    ...(repositoryUrl && { KOMLA_REPO_URL: repositoryUrl }),
  };
}

/**
 * The branch checked out in the workspace, as Komla last saw it, since one can be checked out in
 * its terminal; until then the one it was made on.
 */
export function workspaceBranch(workspace: Workspace): string | undefined {
  const branch =
    workspaceStatusService.read(workspace.id)?.branch.currentBranch || workspace.branchName;
  // A detached checkout, which an SSH host's report can also have saved as the workspace's.
  return branch && branch !== 'HEAD' ? branch : undefined;
}

/**
 * A remote URL without the password it may carry, and for http(s), where a token can be the user
 * name, without the user name too. An SSH user name such as `git` stays, as the URL needs it.
 */
export function withoutCredentials(url: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    // Also git+https:, as npm writes a repository's URL, which a remote may have been copied from.
    const web = /^(?:git\+)?https?:$/i.test(parsed.protocol);
    if (!parsed.password && !(web && parsed.username)) return url;
    parsed.password = '';
    if (web) parsed.username = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

const repositoryUrls = new Map<string, { url: Promise<string | undefined>; readAt: number }>();

/**
 * The origin of the workspace's repository: for an SSH workspace the URL its host cloned, and
 * otherwise read from the project's repository here, kept a few minutes so runs don't each
 * start git.
 */
export function projectRepositoryUrl(
  workspace: Workspace,
  now = Date.now()
): Promise<string | undefined> {
  if (isSshWorkspace(workspace)) {
    const url = workspace.backend.gitUrl.trim();
    return Promise.resolve(url ? withoutCredentials(url) : undefined);
  }
  const project = workspace.projectId ? projectService.get(workspace.projectId) : undefined;
  if (!project || project.kind === 'directory') return Promise.resolve(undefined);
  const repoPath = projectRepoPath(project);
  const cached = repositoryUrls.get(repoPath);
  if (cached && now - cached.readAt < REPOSITORY_URL_TTL_MS) return cached.url;
  const url = gitService.getRemoteUrl(repoPath).then(
    (found) => (found?.trim() ? withoutCredentials(found.trim()) : undefined),
    () => undefined
  );
  repositoryUrls.set(repoPath, { url, readAt: now });
  return url;
}
