import { describe, expect, it, vi } from 'vitest';

import {
  projectRepositoryUrl,
  withoutCredentials,
  workspaceBranch,
  workspaceEnvironment,
} from '../../../src/main/services/workspace-environment';

import type { Project } from '../../../src/shared/types/project';
import type { Workspace } from '../../../src/shared/types/workspace';

const projects = new Map<string, Partial<Project>>();
const getRemoteUrl = vi.fn(async (_path: string): Promise<string | null> => null);
const observedBranches = new Map<string, string>();

vi.mock('../../../src/main/services/project.service', () => ({
  projectService: { get: (id: string) => projects.get(id) },
}));
vi.mock('../../../src/main/services/git.service', () => ({
  gitService: { getRemoteUrl: (path: string) => getRemoteUrl(path) },
}));
vi.mock('../../../src/main/services/workspace-status.service', () => ({
  workspaceStatusService: {
    read: (id: string) =>
      observedBranches.has(id)
        ? { branch: { currentBranch: observedBranches.get(id) } }
        : undefined,
  },
}));

const workspace = {
  id: 'ws-1',
  name: 'fix-login',
  customName: 'Fix login',
  projectId: 'p-1',
  branchName: 'fix-login',
} as Workspace;

describe('workspaceEnvironment', () => {
  it('says which workspace a command runs for, with its project and repository', async () => {
    await expect(
      workspaceEnvironment(workspace, {
        getProjectKeys: () => ['p-1', 'komla'],
        getBranch: () => 'fix-login',
        getRepositoryUrl: async () => 'git@github.com:acme/komla.git',
      })
    ).resolves.toEqual({
      KOMLA_WORKSPACE_ID: 'ws-1',
      KOMLA_WORKSPACE_NAME: 'Fix login',
      KOMLA_BRANCH: 'fix-login',
      KOMLA_PROJECT: 'komla',
      KOMLA_REPO_URL: 'git@github.com:acme/komla.git',
    });
  });

  it("leaves out what Komla doesn't know, and runs the command when it can't read the origin", async () => {
    await expect(
      workspaceEnvironment({ id: 'ws-2', name: 'scratch' } as Workspace, {
        getProjectKeys: () => [],
        getBranch: () => undefined,
        getRepositoryUrl: async () => {
          throw new Error('not a git repository');
        },
      })
    ).resolves.toEqual({ KOMLA_WORKSPACE_ID: 'ws-2', KOMLA_WORKSPACE_NAME: 'scratch' });
  });
});

describe('workspaceBranch', () => {
  it('is the branch Komla saw checked out, the one it was made on until then', () => {
    expect(workspaceBranch(workspace)).toBe('fix-login');
    observedBranches.set('ws-1', 'checked-out-later');
    expect(workspaceBranch(workspace)).toBe('checked-out-later');
    // A detached checkout has no branch.
    observedBranches.set('ws-1', 'HEAD');
    expect(workspaceBranch(workspace)).toBeUndefined();
    observedBranches.clear();
    expect(workspaceBranch({ ...workspace, branchName: 'HEAD' })).toBeUndefined();
  });
});

describe('withoutCredentials', () => {
  it.each([
    [
      'https://x-access-token:ghp_secret@github.com/acme/komla.git',
      'https://github.com/acme/komla.git',
    ],
    ['https://oauth2@gitlab.com/acme/komla.git', 'https://gitlab.com/acme/komla.git'],
    ['https://github.com/acme/komla.git', 'https://github.com/acme/komla.git'],
    ['git@github.com:acme/komla.git', 'git@github.com:acme/komla.git'],
    ['ssh://git@github.com/acme/komla.git', 'ssh://git@github.com/acme/komla.git'],
    ['ssh://deploy:secret@git.example.com/r.git', 'ssh://deploy@git.example.com/r.git'],
    ['git+https://ghp_secret@github.com/acme/komla.git', 'git+https://github.com/acme/komla.git'],
    ['svn+https://deploy@svn.example.com/r', 'svn+https://deploy@svn.example.com/r'],
  ])('keeps %s as %s', (url, expected) => {
    expect(withoutCredentials(url)).toBe(expected);
  });
});

describe('projectRepositoryUrl', () => {
  it("reads the origin of the project's repository here, again only after a few minutes", async () => {
    projects.set('p-1', { id: 'p-1', repositoryPath: '/repos/komla', managed: false });
    getRemoteUrl.mockResolvedValue('https://token@github.com/acme/komla.git\n');

    await expect(projectRepositoryUrl(workspace, 1000)).resolves.toBe(
      'https://github.com/acme/komla.git'
    );
    await expect(projectRepositoryUrl(workspace, 2000)).resolves.toBe(
      'https://github.com/acme/komla.git'
    );
    expect(getRemoteUrl).toHaveBeenCalledOnce();
    expect(getRemoteUrl).toHaveBeenCalledWith('/repos/komla');

    getRemoteUrl.mockResolvedValue('git@github.com:acme/renamed.git');
    await expect(projectRepositoryUrl(workspace, 1000 + 5 * 60_000)).resolves.toBe(
      'git@github.com:acme/renamed.git'
    );
  });

  it('is the URL an SSH workspace was cloned from on its host, without git here', async () => {
    getRemoteUrl.mockClear();
    const ssh = {
      ...workspace,
      backend: { kind: 'ssh', hostId: 'host-1', gitUrl: 'https://tok@github.com/acme/komla.git' },
    } as unknown as Workspace;
    await expect(projectRepositoryUrl(ssh)).resolves.toBe('https://github.com/acme/komla.git');
    expect(getRemoteUrl).not.toHaveBeenCalled();
  });

  it('has none for a workspace without a project, or a folder that is not a repository', async () => {
    projects.set('p-2', { id: 'p-2', kind: 'directory', repositoryPath: '/notes', managed: false });
    getRemoteUrl.mockClear();
    await expect(projectRepositoryUrl({ ...workspace, projectId: 'missing' })).resolves.toBe(
      undefined
    );
    await expect(projectRepositoryUrl({ ...workspace, projectId: 'p-2' })).resolves.toBe(undefined);
    expect(getRemoteUrl).not.toHaveBeenCalled();
  });
});
