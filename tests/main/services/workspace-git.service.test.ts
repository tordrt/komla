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
};

const mockSshWorkspaceService = {
  getBranchQuickStatus: vi.fn(),
  listBranches: vi.fn(),
  getCommitGraph: vi.fn(),
  commitChanges: vi.fn(),
};

const mockSshWorkspaceDiff = { getCommitDiff: vi.fn() };

const mockWorkspaceService = {
  get: vi.fn(),
};

const mockProjectService = { get: vi.fn() };
const mockManagedRepoService = { getRemoteStatus: vi.fn() };
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
});
