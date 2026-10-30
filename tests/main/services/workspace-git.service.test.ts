import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mockGitService = {
  getBranchQuickStatus: vi.fn(),
  listBranches: vi.fn(),
  getCommitGraph: vi.fn(),
  getCommitDiff: vi.fn(),
  getCommitFileDiff: vi.fn(),
  commitChanges: vi.fn(),
  rebaseOnBranch: vi.fn(),
  fetchFromRemote: vi.fn(),
  getTargetBranch: vi.fn(),
  fastForwardBranchToRemoteIfSafe: vi.fn(),
  getRemoteUrl: vi.fn(),
};

const mockSshWorkspaceService = {
  getBranchQuickStatus: vi.fn(),
  listBranches: vi.fn(),
  getCommitGraph: vi.fn(),
  commitChanges: vi.fn(),
  pushTargetBranch: vi.fn(),
};

const mockSshWorkspaceDiff = { getCommitDiff: vi.fn() };

const mockWorkspaceService = {
  get: vi.fn(),
  list: vi.fn(() => [] as Array<Record<string, unknown>>),
};

const mockProjectService = { get: vi.fn(), list: vi.fn(() => [] as Array<Record<string, unknown>>) };
const mockManagedRepoService = { getRemoteStatus: vi.fn(), fetch: vi.fn() };
const mockWorkspaceStatusService = { read: vi.fn(), change: vi.fn() };

vi.mock('../../../src/main/services/git.service', () => ({ gitService: mockGitService }));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: mockSshWorkspaceService,
}));
vi.mock('../../../src/main/services/workspace-git/ssh-git', () => ({
  sshWorkspaceGit: mockSshWorkspaceService,
}));
vi.mock('../../../src/main/services/workspace-git/ssh-diff', () => ({
  sshWorkspaceDiff: mockSshWorkspaceDiff,
}));
vi.mock('../../../src/main/services/workspace.service', () => ({
  workspaceService: mockWorkspaceService,
}));
vi.mock('../../../src/main/services/project.service', () => ({
  projectService: mockProjectService,
}));
vi.mock('../../../src/main/services/managed-repo.service', () => ({
  managedRepoService: mockManagedRepoService,
}));
vi.mock('../../../src/main/services/workspace-status.service', () => ({
  workspaceStatusService: mockWorkspaceStatusService,
}));

describe('workspaceGitService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceStatusService.read.mockReturnValue(undefined);
    mockWorkspaceStatusService.change.mockResolvedValue({ disposition: 'applied' });
  });

  it('routes branch reads through the local repository adapter', async () => {
    mockWorkspaceService.get.mockReturnValue({
      id: 'local-workspace',
      workingDirectory: '/repos/local',
      backend: { kind: 'local' },
    });
    const status = { currentBranch: 'feature' };
    mockGitService.getBranchQuickStatus.mockResolvedValue(status);
    mockGitService.listBranches.mockResolvedValue([{ name: 'feature', isRemoteOnly: false }]);

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');

    await expect(workspaceGitService.getBranchQuickStatus('local-workspace')).resolves.toBe(status);
    await expect(workspaceGitService.listBranches('local-workspace', true)).resolves.toEqual([
      { name: 'feature', isRemoteOnly: false },
    ]);
    expect(mockGitService.getBranchQuickStatus).toHaveBeenCalledWith('/repos/local');
    expect(mockGitService.listBranches).toHaveBeenCalledWith('/repos/local', true);
    expect(mockSshWorkspaceService.getBranchQuickStatus).not.toHaveBeenCalled();
  });

  it('serves SSH branch reads from the companion observation', async () => {
    const backend = {
      kind: 'ssh',
      hostId: 'host-1',
      remoteDirectory: '/remote/repo',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
      gitUrl: 'git@example.com:repo.git',
      baseBranch: 'develop',
    };
    mockWorkspaceService.get.mockReturnValue({
      id: 'ssh-workspace',
      workingDirectory: 'ssh://host-1/remote/repo',
      backend,
      baseBranch: 'release',
    });
    const status = {
      currentBranch: 'feature',
      targetBranch: 'release',
      defaultBranch: 'trunk',
      aheadTargetBranch: 2,
      behindTargetBranch: 1,
      hasRemote: true,
      hasOriginRemote: true,
      unpushedCommits: 2,
      behindRemote: 0,
      targetBranchHasRemote: true,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    };
    mockWorkspaceStatusService.read.mockReturnValue({
      workspaceId: 'ssh-workspace',
      branch: status,
    });
    mockSshWorkspaceService.listBranches.mockResolvedValue([
      { name: 'feature', isRemoteOnly: false },
    ]);

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');

    const {
      targetBranch: _targetBranch,
      defaultBranch: _defaultBranch,
      ...observedStatus
    } = status;
    await expect(workspaceGitService.getBranchQuickStatus('ssh-workspace')).resolves.toEqual({
      ...observedStatus,
      mainBranch: 'release',
      defaultBranch: 'trunk',
    });
    await expect(workspaceGitService.listBranches('ssh-workspace')).resolves.toEqual([
      { name: 'feature', isRemoteOnly: false },
    ]);
    expect(mockSshWorkspaceService.getBranchQuickStatus).not.toHaveBeenCalled();
    expect(mockSshWorkspaceService.listBranches).toHaveBeenCalledWith(backend, false);
    expect(mockGitService.getBranchQuickStatus).not.toHaveBeenCalled();
  });

  it('uses retained SSH status without requesting a CLI snapshot before observation starts', async () => {
    const backend = {
      kind: 'ssh',
      hostId: 'host-1',
      remoteDirectory: '/remote/repo',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
      gitUrl: 'git@example.com:repo.git',
      baseBranch: 'develop',
    };
    const status = {
      behindTargetBranch: 1,
      aheadTargetBranch: 2,
      mainBranch: 'develop',
      defaultBranch: 'main',
      hasRemote: true,
      hasOriginRemote: true,
      unpushedCommits: 2,
      behindRemote: 0,
      currentBranch: 'feature',
      targetBranchHasRemote: true,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 1,
    };
    mockWorkspaceService.get.mockReturnValue({
      id: 'ssh-workspace',
      workingDirectory: 'ssh://host-1/remote/repo',
      backend,
      lastKnownGitStatus: {
        branch: status,
        diff: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
        updatedAt: 1,
      },
    });
    mockWorkspaceStatusService.read.mockReturnValue(undefined);

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');

    await expect(workspaceGitService.getBranchQuickStatus('ssh-workspace')).resolves.toBe(status);
    expect(mockSshWorkspaceService.getBranchQuickStatus).not.toHaveBeenCalled();
  });

  it('returns a neutral SSH status while awaiting the first companion observation', async () => {
    mockWorkspaceService.get.mockReturnValue({
      id: 'ssh-workspace',
      workingDirectory: 'ssh://host-1/remote/repo',
      branchName: 'feature',
      baseBranch: 'develop',
      backend: {
        kind: 'ssh',
        hostId: 'host-1',
        remoteDirectory: '/remote/repo',
        remoteRepoPath: '/remote/repo.git',
        remoteProjectRoot: '/remote',
        gitUrl: 'git@example.com:repo.git',
        baseBranch: 'main',
        defaultBranch: 'main',
      },
    });

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');

    await expect(workspaceGitService.getBranchQuickStatus('ssh-workspace')).resolves.toMatchObject({
      currentBranch: 'feature',
      mainBranch: 'develop',
      defaultBranch: 'main',
      aheadTargetBranch: 0,
      behindTargetBranch: 0,
    });
    expect(mockSshWorkspaceService.getBranchQuickStatus).not.toHaveBeenCalled();
  });

  it('reads the commit graph and commits where the workspace lives', async () => {
    const graph = { commits: [], hasMore: false, currentBranch: 'feature', upstream: null };
    const diff = { commit: { hash: 'abc1234' }, files: [] };
    mockGitService.getCommitGraph.mockResolvedValue(graph);
    mockSshWorkspaceService.getCommitGraph.mockResolvedValue(graph);
    mockGitService.getCommitDiff.mockResolvedValue(diff);
    mockSshWorkspaceDiff.getCommitDiff.mockResolvedValue(diff);
    const backend = { kind: 'ssh', hostId: 'host-1', remoteDirectory: '/remote/repo' };
    mockWorkspaceService.get.mockImplementation((id: string) =>
      id === 'local-workspace'
        ? { id, workingDirectory: '/repos/local', backend: { kind: 'local' } }
        : { id, workingDirectory: 'ssh://host-1/remote/repo', backend }
    );

    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');

    const query = { limit: 100, ref: 'main', path: 'src/a.ts' };
    await expect(workspaceGitService.getCommitGraph('local-workspace', query)).resolves.toBe(graph);
    await expect(workspaceGitService.getCommitGraph('ssh-workspace', { limit: 200 })).resolves.toBe(
      graph
    );
    expect(mockGitService.getCommitGraph).toHaveBeenCalledExactlyOnceWith('/repos/local', query);
    expect(mockSshWorkspaceService.getCommitGraph).toHaveBeenCalledExactlyOnceWith(backend, {
      limit: 200,
    });

    await expect(workspaceGitService.getCommitDiff('local-workspace', 'abc1234')).resolves.toBe(
      diff
    );
    await expect(workspaceGitService.getCommitDiff('ssh-workspace', 'abc1234')).resolves.toBe(diff);
    expect(mockGitService.getCommitDiff).toHaveBeenCalledExactlyOnceWith('/repos/local', 'abc1234');
    expect(mockSshWorkspaceDiff.getCommitDiff).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'ssh-workspace', backend }),
      'abc1234'
    );

    // A local workspace's paths stay inside it.
    expect(() =>
      workspaceGitService.getCommitGraph('local-workspace', { limit: 1, path: '../out' })
    ).toThrow('path escapes');
    expect(() =>
      workspaceGitService.getCommitFileDiff('local-workspace', 'abc1234', '../out')
    ).toThrow('filePath escapes');
    expect(mockGitService.getCommitFileDiff).not.toHaveBeenCalled();
  });

  it('rejects an unknown workspace at the interface', async () => {
    mockWorkspaceService.get.mockReturnValue(undefined);
    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');

    await expect(workspaceGitService.listBranches('missing')).rejects.toThrow(
      'Workspace missing not found'
    );
  });

  it('contains SSH mutation aftermath even when the operation fails', async () => {
    const backend = {
      kind: 'ssh',
      hostId: 'host-1',
      remoteDirectory: '/remote/repo',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
      gitUrl: 'git@example.com:repo.git',
    };
    mockWorkspaceService.get.mockReturnValue({
      id: 'ssh-workspace',
      workingDirectory: 'ssh://host-1/remote/repo',
      backend,
    });
    mockSshWorkspaceService.commitChanges.mockRejectedValue(new Error('commit failed'));
    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');

    await expect(
      workspaceGitService.commitChanges('ssh-workspace', {
        subject: 'Subject',
        scope: 'all',
      })
    ).rejects.toThrow('commit failed');
    expect(mockWorkspaceStatusService.change).toHaveBeenCalledWith({
      kind: 'repository-mutated',
      workspaceId: 'ssh-workspace',
    });
  });

  it('passes rebase options through the local repository adapter', async () => {
    mockWorkspaceService.get.mockReturnValue({
      id: 'local-workspace',
      workingDirectory: '/repos/local',
      backend: { kind: 'local' },
    });
    mockGitService.rebaseOnBranch.mockResolvedValue({ success: true, message: 'ok' });
    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');

    await workspaceGitService.rebaseOnBranch('local-workspace', 'main', { stash: true });

    expect(mockGitService.rebaseOnBranch).toHaveBeenCalledWith('/repos/local', 'main', {
      stash: true,
    });
  });

  it('does not apply SSH aftermath to local mutations', async () => {
    mockWorkspaceService.get.mockReturnValue({
      id: 'local-workspace',
      workingDirectory: '/repos/local',
      backend: { kind: 'local' },
    });
    mockGitService.commitChanges.mockResolvedValue({ commitHash: 'abc123', subject: 'Subject' });
    const { workspaceGitService } =
      await import('../../../src/main/services/workspace-git.service');

    await workspaceGitService.commitChanges('local-workspace', {
      subject: 'Subject',
      scope: 'all',
    });

    expect(mockWorkspaceStatusService.change).not.toHaveBeenCalled();
  });

  describe('fetching', () => {
    const managed = {
      id: 'managed',
      managed: true,
      repositoryPath: '/p/m',
      managedRepoPath: '/p/m.git',
    };
    const own = { id: 'own', managed: false, repositoryPath: '/p/own' };
    const workspaces = [
      { id: 'w1', projectId: 'managed', workingDirectory: '/wt/w1', backend: { kind: 'local' } },
      {
        id: 'w2',
        projectId: 'managed',
        workingDirectory: '/wt/w2',
        backend: { kind: 'local' },
        baseBranch: 'release',
      },
      { id: 'w3', projectId: 'managed', workingDirectory: '/wt/w3', backend: { kind: 'local' } },
      { id: 'w4', projectId: 'managed', workingDirectory: 'ssh://h/r', backend: { kind: 'ssh' } },
      { id: 'w5', projectId: 'own', workingDirectory: '/wt/w5', backend: { kind: 'local' } },
    ];

    beforeEach(() => {
      mockProjectService.list.mockReturnValue([managed, own]);
      mockProjectService.get.mockImplementation((id: string) =>
        [managed, own].find((project) => project.id === id)
      );
      mockWorkspaceService.list.mockReturnValue(workspaces);
      mockWorkspaceService.get.mockImplementation((id: string) =>
        workspaces.find((workspace) => workspace.id === id)
      );
      mockGitService.getTargetBranch.mockResolvedValue('main');
      mockGitService.fastForwardBranchToRemoteIfSafe.mockImplementation(
        async (_repoPath: string, branch: string) => branch === 'main'
      );
      mockGitService.fetchFromRemote.mockResolvedValue({
        success: true,
        message: 'Already up to date',
      });
      mockManagedRepoService.fetch.mockResolvedValue({
        success: true,
        message: 'Fetched from remote',
      });
    });

    it("fast-forwards the project's target branches after a workspace Fetch", async () => {
      const { workspaceGitService } =
        await import('../../../src/main/services/workspace-git.service');

      await expect(workspaceGitService.fetchFromRemote('w1')).resolves.toEqual({
        success: true,
        message: 'Already up to date. Local main caught up with origin',
      });

      expect(mockGitService.fetchFromRemote).toHaveBeenCalledWith('/wt/w1');
      expect(mockGitService.getTargetBranch.mock.calls).toEqual([['/p/m.git']]);
      expect(mockGitService.fastForwardBranchToRemoteIfSafe.mock.calls).toEqual([
        ['/p/m.git', 'main'],
        ['/p/m.git', 'release'],
      ]);
    });

    it('fetches a managed project in its bare clone, and any other in its folder', async () => {
      const { workspaceGitService } =
        await import('../../../src/main/services/workspace-git.service');

      await expect(workspaceGitService.fetchProject('managed')).resolves.toEqual({
        success: true,
        message: 'Fetched from remote. Local main caught up with origin',
      });
      await workspaceGitService.fetchProject('own');

      expect(mockManagedRepoService.fetch).toHaveBeenCalledWith('/p/m.git');
      expect(mockGitService.fetchFromRemote).toHaveBeenCalledWith('/p/own');
      expect(mockGitService.fastForwardBranchToRemoteIfSafe.mock.calls.at(-1)).toEqual([
        '/p/own',
        'main',
      ]);
      await expect(workspaceGitService.fetchProject('missing')).resolves.toEqual({
        success: false,
        message: 'Project not found',
      });
    });

    it.each([
      ['a project folder', '/p/own', [['/p/own', 'main']]],
      ['a bare clone', '/p/m.git', [['/p/m.git', 'main'], ['/p/m.git', 'release']]],
      ['a workspace', '/wt/w5', [['/p/own', 'main']]],
      ['a folder of no project', '/elsewhere', []],
      // A managed project's folder is not the bare clone its workspaces compare against.
      ['a managed project folder', '/p/m', []],
    ])('finds the project to fast-forward from %s', async (_name, repoPath, calls) => {
      const { workspaceGitService } =
        await import('../../../src/main/services/workspace-git.service');

      await workspaceGitService.fetchPath(repoPath);

      expect(mockGitService.fetchFromRemote).toHaveBeenCalledWith(repoPath, undefined);
      expect(mockGitService.fastForwardBranchToRemoteIfSafe.mock.calls).toEqual(calls);
    });

    it("syncs the project's own target branch, even without local workspaces", async () => {
      mockProjectService.get.mockReturnValue({ ...own, baseBranch: 'develop' });
      mockWorkspaceService.list.mockReturnValue([]);
      mockGitService.fastForwardBranchToRemoteIfSafe.mockResolvedValue(true);
      const { workspaceGitService } =
        await import('../../../src/main/services/workspace-git.service');

      await expect(workspaceGitService.fetchProject('own')).resolves.toEqual({
        success: true,
        message: 'Already up to date. Local develop caught up with origin',
      });
      expect(mockGitService.fastForwardBranchToRemoteIfSafe.mock.calls).toEqual([
        ['/p/own', 'develop'],
      ]);
    });

    it('keeps going when the default branch cannot be read or a branch cannot move', async () => {
      mockGitService.getTargetBranch.mockRejectedValue(new Error('not a git repository'));
      mockGitService.fastForwardBranchToRemoteIfSafe.mockImplementation(
        async (_repoPath: string, branch: string) => {
          if (branch === 'release') throw new Error('cannot lock ref');
          return true;
        }
      );
      const { workspaceGitService } =
        await import('../../../src/main/services/workspace-git.service');

      await expect(workspaceGitService.fastForwardProjectTargets('managed')).resolves.toEqual([]);
      expect(mockGitService.fastForwardBranchToRemoteIfSafe.mock.calls).toEqual([
        ['/p/m.git', 'release'],
      ]);
    });

    it.each([
      ['managed', '/p/m.git', [['/p/m.git', 'main']]],
      ['own', '/p/own', []],
    ])(
      'after an SSH push, syncs the %s project and fast-forwards only a clone Komla owns',
      async (projectId, fetchedPath, calls) => {
        const sshWorkspace = {
          id: 's1',
          projectId,
          workingDirectory: 'ssh://h/r',
          backend: { kind: 'ssh', hostId: 'h', gitUrl: 'git@example.com:app.git' },
        };
        mockWorkspaceService.get.mockReturnValue(sshWorkspace);
        mockWorkspaceService.list.mockReturnValue([sshWorkspace]);
        mockSshWorkspaceService.pushTargetBranch.mockResolvedValue({
          success: true,
          message: 'Pushed',
        });
        mockGitService.getRemoteUrl.mockResolvedValue('git@example.com:app.git');
        const { workspaceGitService } =
          await import('../../../src/main/services/workspace-git.service');

        await workspaceGitService.pushTargetBranch('s1');

        const fetched = [
          ...mockManagedRepoService.fetch.mock.calls,
          ...mockGitService.fetchFromRemote.mock.calls,
        ].map(([path]) => path);
        expect(fetched).toEqual([fetchedPath]);
        expect(mockGitService.fastForwardBranchToRemoteIfSafe.mock.calls).toEqual(calls);
      }
    );

    it('leaves target branches alone after a failed fetch', async () => {
      mockGitService.fetchFromRemote.mockResolvedValue({ success: false, message: 'Fetch failed' });
      const { workspaceGitService } =
        await import('../../../src/main/services/workspace-git.service');

      await expect(workspaceGitService.fetchFromRemote('w1')).resolves.toEqual({
        success: false,
        message: 'Fetch failed',
      });
      await workspaceGitService.fetchPath('/p/own');
      expect(mockGitService.fastForwardBranchToRemoteIfSafe).not.toHaveBeenCalled();
    });

    it('stops between branches once background work should give way', async () => {
      const { workspaceGitService } =
        await import('../../../src/main/services/workspace-git.service');
      let proceed = true;
      mockGitService.fastForwardBranchToRemoteIfSafe.mockImplementation(async () => {
        proceed = false;
        return true;
      });

      await expect(
        workspaceGitService.fastForwardProjectTargets('managed', () => proceed)
      ).resolves.toEqual(['main']);
      expect(mockGitService.fastForwardBranchToRemoteIfSafe).toHaveBeenCalledTimes(1);
    });
  });
});
