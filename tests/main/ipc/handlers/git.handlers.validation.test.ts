import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

const mockPullRequestStatusService = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('electron', () => mockElectron());

const mockGitService = {
  isGitRepo: vi.fn(),
  getCurrentBranch: vi.fn(),
  listWorktrees: vi.fn(),
  getWorkingTreeDiff: vi.fn(),
  getWorkingTreeDiffAgainstBranch: vi.fn(),
  getFullFileDiff: vi.fn(),
  getFullFileDiffAgainstBranch: vi.fn(),
  getBranchQuickStatus: vi.fn(),
  mergeFrom: vi.fn(),
  listBranches: vi.fn(),
  createBranch: vi.fn(),
  getTargetBranch: vi.fn(),
  fetchFromRemote: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  pullRebase: vi.fn(),
  pushTargetBranch: vi.fn(),
  pullTargetBranch: vi.fn(),
  mergeTargetBranchFromRemote: vi.fn(),
  rebaseOnTargetBranch: vi.fn(),
  rebaseOnBranch: vi.fn(),
  abortRebase: vi.fn(),
  mergeToTargetBranch: vi.fn(),
  switchBranch: vi.fn(),
  deleteBranch: vi.fn(),
  deleteRemoteBranch: vi.fn(),
  getBranchUrl: vi.fn(),
  getCreatePrUrl: vi.fn(),
  getRepoWebInfo: vi.fn(),
  fileExists: vi.fn(),
  getFileMetadata: vi.fn(),
  copyFile: vi.fn(),
  copyDirectory: vi.fn(),
  deleteFile: vi.fn(),
  writeFile: vi.fn(),
  listFiles: vi.fn(),
  readFileContent: vi.fn(),
  restoreFile: vi.fn(),
  discardAllChanges: vi.fn(),
  inspectCommitScope: vi.fn(),
  generateCommitDraft: vi.fn(),
  commitChanges: vi.fn(),
  validateRemoteUrl: vi.fn(),
  getMainBranch: vi.fn(),
  getIdentityStatus: vi.fn(),
  setGlobalIdentity: vi.fn(),
};

const mockManagedRepoService = {
  getRemoteStatus: vi.fn(),
  fetch: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
};

const mockProjectService = {
  get: vi.fn(),
  list: vi.fn(() => []),
};

const mockWorkspaceService = {
  list: vi.fn(() => []),
  get: vi.fn(),
  ensureWatcherStarted: vi.fn(),
  update: vi.fn(),
};

const mockWorkspaceStatusService = {
  change: vi.fn(),
  read: vi.fn((request?: unknown) => (request === undefined ? [] : undefined)),
  observe: vi.fn(() => ({ initial: [], close: vi.fn() })),
};

const mockSshWorkspaceService = {
  getBranchQuickStatus: vi.fn(),
  listBranches: vi.fn(),
  fetchFromRemote: vi.fn(),
  mergeFrom: vi.fn(),
  rebaseOnBranch: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  pushTargetBranch: vi.fn(),
  pullTargetBranch: vi.fn(),
  mergeTargetBranchFromRemote: vi.fn(),
  mergeToTargetBranch: vi.fn(),
  restoreFile: vi.fn(),
  discardAllChanges: vi.fn(),
  inspectCommitScope: vi.fn(),
  generateCommitDraft: vi.fn(),
  commitChanges: vi.fn(),
  createBranch: vi.fn(),
  switchBranch: vi.fn(),
};

const mockWorkspaceFileService = {
  listFiles: vi.fn(),
  readFile: vi.fn(),
  readImageFile: vi.fn(),
  searchContent: vi.fn(),
  importExternalFile: vi.fn(),
  readViewerFile: vi.fn(),
  getViewerPreviewUrl: vi.fn(),
  listViewerFolder: vi.fn(),
  writeFile: vi.fn(),
  deletePath: vi.fn(),
};

vi.mock('../../../../src/main/services/git.service', () => ({
  gitService: mockGitService,
}));

vi.mock('../../../../src/main/services/managed-repo.service', () => ({
  managedRepoService: mockManagedRepoService,
}));

vi.mock('../../../../src/main/services/project.service', () => ({
  projectService: mockProjectService,
}));

vi.mock('../../../../src/main/services/search.service', () => ({
  searchService: {
    searchContent: vi.fn(),
  },
}));

vi.mock('../../../../src/main/services/workspace.service', () => ({
  workspaceService: mockWorkspaceService,
}));
vi.mock('../../../../src/main/services/workspace-status.service', () => ({
  workspaceStatusService: mockWorkspaceStatusService,
}));
vi.mock('../../../../src/main/services/pull-request-status.service', () => ({
  pullRequestStatusService: mockPullRequestStatusService,
}));
vi.mock('../../../../src/main/services/github-cli', () => ({
  checkGhAuth: vi.fn(),
  createGithubRepo: vi.fn(),
}));

vi.mock('../../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: mockSshWorkspaceService,
}));
vi.mock('../../../../src/main/services/workspace-git/ssh-git', () => ({
  sshWorkspaceGit: mockSshWorkspaceService,
}));
vi.mock('../../../../src/main/services/workspace-file.service', () => ({
  workspaceFileService: mockWorkspaceFileService,
}));

vi.mock('../../../../src/main/services/metrics-collector.service', () => ({
  metricsCollectorService: { increment: vi.fn(), incrementMcpTool: vi.fn() },
}));

describe('git IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockWorkspaceStatusService.change.mockResolvedValue({ disposition: 'applied' });
  });

  it('blocks path traversal in git:read-file', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerGitHandlers();

    await expect(ipcMain._invoke('git:read-file', '/tmp/repo', '../secrets.txt')).rejects.toThrow(
      'escapes the allowed root path'
    );
    expect(mockGitService.readFileContent).not.toHaveBeenCalled();
  });

  it('blocks path traversal in workspace:read-file', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(
      ipcMain._invoke('workspace:read-file', 'ws-ssh', '../secrets.txt')
    ).rejects.toThrow('escapes the allowed root path');
    expect(mockWorkspaceFileService.readFile).not.toHaveBeenCalled();
  });

  it('blocks path traversal in workspace:delete-path', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(
      ipcMain._invoke('workspace:delete-path', 'ws-ssh', '../secrets.txt')
    ).rejects.toThrow('escapes the allowed root path');
    expect(mockWorkspaceFileService.deletePath).not.toHaveBeenCalled();
  });

  it('rejects all-whitespace workspace deletion paths', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(ipcMain._invoke('workspace:delete-path', 'ws-ssh', '   ')).rejects.toThrow();
    expect(mockWorkspaceFileService.deletePath).not.toHaveBeenCalled();
  });

  it('preserves leading and trailing whitespace in workspace deletion paths', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(
      ipcMain._invoke('workspace:delete-path', 'ws-ssh', ' report ')
    ).resolves.toBeUndefined();
    expect(mockWorkspaceFileService.deletePath).toHaveBeenCalledWith('ws-ssh', ' report ');
  });

  it('uses POSIX semantics for remote deletion paths', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(
      ipcMain._invoke('workspace:delete-path', 'ws-ssh', '..\\report')
    ).resolves.toBeUndefined();
    await expect(
      ipcMain._invoke('workspace:delete-path', 'ws-ssh', 'C:\\report')
    ).resolves.toBeUndefined();
    expect(mockWorkspaceFileService.deletePath).toHaveBeenNthCalledWith(
      1,
      'ws-ssh',
      '..\\report'
    );
    expect(mockWorkspaceFileService.deletePath).toHaveBeenNthCalledWith(2, 'ws-ssh', 'C:\\report');
  });

  it('rejects unsafe workspace:write-file arguments', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(
      ipcMain._invoke('workspace:write-file', 'ws-ssh', '../secrets.txt', 'x')
    ).rejects.toThrow('escapes the allowed root path');
    await expect(ipcMain._invoke('workspace:write-file', 'ws-ssh', '   ', 'x')).rejects.toThrow();
    await expect(
      ipcMain._invoke('workspace:write-file', 'ws-ssh', 'notes.txt', 'a\0b')
    ).rejects.toThrow('null');
    await expect(
      ipcMain._invoke('workspace:write-file', 'ws-ssh', 'notes.txt', 42)
    ).rejects.toThrow();
    expect(mockWorkspaceFileService.writeFile).not.toHaveBeenCalled();
  });

  it('reads the exact workspace file path', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await ipcMain._invoke('workspace:read-file', 'ws-ssh', 'notes.txt ');
    expect(mockWorkspaceFileService.readFile).toHaveBeenCalledWith('ws-ssh', 'notes.txt ');
  });

  it('searches workspace contents and rejects invalid search arguments', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(ipcMain._invoke('workspace:search-content', '', 'needle')).rejects.toThrow();
    await expect(ipcMain._invoke('workspace:search-content', 'ws-ssh', '')).rejects.toThrow();
    await expect(
      ipcMain._invoke('workspace:search-content', 'ws-ssh', 'needle', { maxResults: 0 })
    ).rejects.toThrow();
    await expect(
      ipcMain._invoke('workspace:search-content', 'ws-ssh', 'needle', { maxFileSize: '1 MB' })
    ).rejects.toThrow();
    expect(mockWorkspaceFileService.searchContent).not.toHaveBeenCalled();

    await ipcMain._invoke('workspace:search-content', 'ws-ssh', 'needle', {
      maxFileSize: '2M',
      extra: true,
    });
    expect(mockWorkspaceFileService.searchContent).toHaveBeenCalledWith('ws-ssh', 'needle', {
      maxFileSize: '2M',
    });
  });

  it('writes the exact workspace file path', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(
      ipcMain._invoke('workspace:write-file', 'ws-ssh', ' report ', 'content')
    ).resolves.toBeUndefined();
    expect(mockWorkspaceFileService.writeFile).toHaveBeenCalledWith('ws-ssh', ' report ', 'content');
  });

  it('rejects invalid workspace import execution locations', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(
      ipcMain._invoke(
        'workspace:import-external-file',
        'ws-ssh',
        '/tmp/report.pdf',
        'report.pdf',
        'somewhere-else'
      )
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockWorkspaceFileService.importExternalFile).not.toHaveBeenCalled();
  });

  it('rejects invalid file viewer sources', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    const invalidSources = [
      '/tmp/shot.png',
      { kind: 'terminal', fullPath: '../shot.png' },
      // Only the terminal user's own home folder.
      { kind: 'terminal', fullPath: '~other/shot.png' },
      { kind: 'terminal', fullPath: '~shot.png' },
      { kind: 'terminal', fullPath: '/tmp/a\0.png' },
      { kind: 'terminal', filePath: '/tmp/shot.png' },
      { kind: 'workspace', filePath: '' },
      { kind: 'workspace', filePath: 'a.png', fullPath: '/tmp/a.png' },
      { kind: 'other', fullPath: '/tmp/shot.png' },
    ];
    for (const channel of [
      'workspace:read-viewer-file',
      'workspace:get-viewer-preview-url',
      'workspace:list-viewer-folder',
    ]) {
      for (const source of invalidSources) {
        await expect(ipcMain._invoke(channel, 'ws-ssh', 'term-ssh', source)).rejects.toMatchObject({
          code: 'IPC_VALIDATION_ERROR',
        });
      }
      await expect(
        ipcMain._invoke(channel, 'ws-ssh', 'term-ssh', { kind: 'workspace', filePath: '../a.md' })
      ).rejects.toThrow();
    }
    expect(mockWorkspaceFileService.readViewerFile).not.toHaveBeenCalled();
    expect(mockWorkspaceFileService.getViewerPreviewUrl).not.toHaveBeenCalled();
    expect(mockWorkspaceFileService.listViewerFolder).not.toHaveBeenCalled();
  });

  it('accepts a workspace file without a terminal', async () => {
    mockWorkspaceFileService.getViewerPreviewUrl.mockResolvedValue('komla-preview://t/paper.pdf');
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();
    const source = { kind: 'workspace', filePath: 'paper.pdf' };

    await expect(
      ipcMain._invoke('workspace:get-viewer-preview-url', 'ws-ssh', null, source)
    ).resolves.toBe('komla-preview://t/paper.pdf');
    expect(mockWorkspaceFileService.getViewerPreviewUrl).toHaveBeenCalledWith(
      'ws-ssh',
      null,
      source,
      undefined
    );
  });

  it('passes on whether a preview URL replaces the one before, and nothing else', async () => {
    mockWorkspaceFileService.getViewerPreviewUrl.mockResolvedValue('komla-preview://t/paper.pdf');
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();
    const source = { kind: 'workspace', filePath: 'paper.pdf' };

    await ipcMain._invoke('workspace:get-viewer-preview-url', 'ws-ssh', null, source, {
      replacesPrevious: true,
    });
    expect(mockWorkspaceFileService.getViewerPreviewUrl).toHaveBeenCalledWith(
      'ws-ssh',
      null,
      source,
      { replacesPrevious: true }
    );
    for (const options of [{ replacesPrevious: 'yes' }, { key: 'other' }, 'replace']) {
      await expect(
        ipcMain._invoke('workspace:get-viewer-preview-url', 'ws-ssh', null, source, options)
      ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    }
  });

  it('accepts terminal paths in the home folder, as printed', async () => {
    mockWorkspaceFileService.listViewerFolder.mockResolvedValue([]);
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();
    const source = { kind: 'terminal', fullPath: '~/shots/' };

    await expect(
      ipcMain._invoke('workspace:list-viewer-folder', 'ws-ssh', 'term-ssh', source)
    ).resolves.toEqual([]);
    expect(mockWorkspaceFileService.listViewerFolder).toHaveBeenCalledWith(
      'ws-ssh',
      'term-ssh',
      source
    );
  });

  it('preserves whitespace in workspace import source paths', async () => {
    mockWorkspaceFileService.importExternalFile.mockResolvedValue('.komla-files/report');
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await ipcMain._invoke(
      'workspace:import-external-file',
      'ws-ssh',
      '/tmp/report ',
      'report ',
      undefined
    );

    expect(mockWorkspaceFileService.importExternalFile).toHaveBeenCalledWith(
      'ws-ssh',
      '/tmp/report ',
      'report',
      undefined
    );
  });

  it('blocks path traversal in git:get-file-metadata', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerGitHandlers();

    await expect(
      ipcMain._invoke('git:get-file-metadata', '/tmp/repo', '../secrets.pdf')
    ).rejects.toThrow('escapes the allowed root path');
    expect(mockGitService.getFileMetadata).not.toHaveBeenCalled();
  });

  it('rejects invalid delete-file status enum', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerGitHandlers();

    await expect(
      ipcMain._invoke('git:delete-file', '/tmp/repo', 'README.md', 'staged')
    ).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockGitService.deleteFile).not.toHaveBeenCalled();
  });

  it("reads a workspace's pull request and rejects invalid ids", async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();
    mockPullRequestStatusService.get.mockResolvedValue({ kind: 'none' });

    await expect(
      ipcMain._invoke('workspace:get-pull-request-status', 42)
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockPullRequestStatusService.get).not.toHaveBeenCalled();
    await expect(ipcMain._invoke('workspace:get-pull-request-status', 'ws-1')).resolves.toEqual({
      kind: 'none',
    });
    expect(mockPullRequestStatusService.get).toHaveBeenCalledWith('ws-1');
  });

  it('reads the git identity and rejects unexpected arguments', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();
    mockGitService.getIdentityStatus.mockResolvedValue({ canCommit: false, userName: 'Ada' });

    await expect(ipcMain._invoke('git:get-identity', '/tmp/repo')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockGitService.getIdentityStatus).not.toHaveBeenCalled();
    await expect(ipcMain._invoke('git:get-identity')).resolves.toEqual({
      canCommit: false,
      userName: 'Ada',
    });
  });

  it.each([
    ['', 'ada@example.com'],
    ['Ada', 'not-an-email'],
    ['Ada <ada>', 'ada@example.com'],
    ['Ada', 42],
  ])('rejects git:set-identity with name %j and email %j', async (userName, userEmail) => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(ipcMain._invoke('git:set-identity', userName, userEmail)).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockGitService.setGlobalIdentity).not.toHaveBeenCalled();
  });

  it('saves a trimmed git identity and reports git failures', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();
    mockGitService.setGlobalIdentity.mockResolvedValueOnce(undefined);

    await expect(
      ipcMain._invoke('git:set-identity', ' Ada Lovelace ', ' ada@example.com ')
    ).resolves.toEqual({ success: true, message: 'Git identity saved' });
    expect(mockGitService.setGlobalIdentity).toHaveBeenCalledWith(
      'Ada Lovelace',
      'ada@example.com'
    );

    mockGitService.setGlobalIdentity.mockRejectedValueOnce(
      new Error('could not lock config file /home/ada/.gitconfig')
    );
    await expect(ipcMain._invoke('git:set-identity', 'Ada', 'ada@example.com')).resolves.toEqual({
      success: false,
      message: 'could not lock config file /home/ada/.gitconfig',
    });
  });

  it('keeps branch status when managed repo status lookup fails', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    mockGitService.getBranchQuickStatus.mockResolvedValue({
      mainBranch: 'main',
      targetBranchAheadRemote: 1,
    });
    mockProjectService.get.mockReturnValue({
      id: 'p1',
      managed: true,
      managedRepoPath: '/tmp/managed',
    });
    mockManagedRepoService.getRemoteStatus.mockRejectedValue(new Error('remote unavailable'));

    registerGitHandlers();

    const result = (await ipcMain._invoke('git:get-branch-status', '/tmp/repo', 'p1')) as {
      targetBranchAheadRemote: number;
    };

    expect(result.targetBranchAheadRemote).toBe(1);
  });

  it('routes workspace branch status for SSH workspaces through Workspace Git', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    const status = {
      currentBranch: 'feature',
      mainBranch: 'main',
      defaultBranch: 'main',
      aheadTargetBranch: 4,
      behindTargetBranch: 0,
      hasRemote: true,
      hasOriginRemote: true,
      unpushedCommits: 4,
      behindRemote: 0,
      targetBranchHasRemote: true,
      targetBranchAheadRemote: 4,
      targetBranchBehindRemote: 0,
    };
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/dev/.komla/worktrees/app/feature',
      remoteRepoPath: '/home/dev/.komla/repos/app/repo.git',
      remoteProjectRoot: '/home/dev/.komla/worktrees/app',
      gitUrl: 'git@github.com:example/app.git',
      baseBranch: 'main',
    };
    mockWorkspaceService.get.mockReturnValue({
      id: 'ws-ssh',
      workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/app/feature',
      baseBranch: 'main',
      backend,
      lastKnownGitStatus: {
        branch: status,
        diff: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
        updatedAt: 1,
      },
    });
    mockProjectService.get.mockReturnValue({
      id: 'p1',
      managed: true,
      managedRepoPath: '/tmp/managed',
    });
    mockManagedRepoService.getRemoteStatus.mockResolvedValue({
      hasRemote: true,
      ahead: 0,
      behind: 0,
    });

    registerGitHandlers();

    const result = await ipcMain._invoke('workspace:get-branch-status', 'ws-ssh', 'p1');

    expect(result).toBe(status);
    expect(result).toMatchObject({ targetBranchAheadRemote: 4 });
    expect(mockSshWorkspaceService.getBranchQuickStatus).not.toHaveBeenCalled();
    expect(mockGitService.getBranchQuickStatus).not.toHaveBeenCalled();
    expect(mockManagedRepoService.getRemoteStatus).not.toHaveBeenCalled();
  });

  it('routes workspace restore for SSH workspaces through Workspace Git', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/dev/.komla/worktrees/app/feature',
      remoteRepoPath: '/home/dev/.komla/repos/app/repo.git',
      remoteProjectRoot: '/home/dev/.komla/worktrees/app',
      gitUrl: 'git@github.com:example/app.git',
      baseBranch: 'main',
    };
    mockWorkspaceService.get.mockReturnValue({
      id: 'ws-ssh',
      workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/app/feature',
      backend,
    });

    registerGitHandlers();

    await ipcMain._invoke('workspace:restore-file', 'ws-ssh', 'src/app.ts', 'modified', undefined);

    expect(mockSshWorkspaceService.restoreFile).toHaveBeenCalledWith(
      backend,
      'src/app.ts',
      'modified',
      undefined
    );
    expect(mockGitService.restoreFile).not.toHaveBeenCalled();
  });

  it('routes workspace branch list for SSH workspaces through Workspace Git', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/dev/.komla/worktrees/app/feature',
      remoteRepoPath: '/home/dev/.komla/repos/app/repo.git',
      remoteProjectRoot: '/home/dev/.komla/worktrees/app',
      gitUrl: 'git@github.com:example/app.git',
      baseBranch: 'main',
    };
    const branches = [{ name: 'main', isRemoteOnly: false }];
    mockWorkspaceService.get.mockReturnValue({
      id: 'ws-ssh',
      workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/app/feature',
      backend,
    });
    mockSshWorkspaceService.listBranches.mockResolvedValue(branches);

    registerGitHandlers();

    const result = await ipcMain._invoke('workspace:list-branches', 'ws-ssh', true);

    expect(result).toBe(branches);
    expect(mockSshWorkspaceService.listBranches).toHaveBeenCalledWith(backend, true);
    expect(mockGitService.listBranches).not.toHaveBeenCalled();
  });

  it('routes workspace sync actions for SSH workspaces through Workspace Git', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/dev/.komla/worktrees/app/feature',
      remoteRepoPath: '/home/dev/.komla/repos/app/repo.git',
      remoteProjectRoot: '/home/dev/.komla/worktrees/app',
      gitUrl: 'git@github.com:example/app.git',
      baseBranch: 'main',
    };
    const ok = { success: true, message: 'ok' };
    mockWorkspaceService.get.mockReturnValue({
      id: 'ws-ssh',
      workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/app/feature',
      backend,
    });
    mockSshWorkspaceService.fetchFromRemote.mockResolvedValue(ok);
    mockSshWorkspaceService.mergeFrom.mockResolvedValue(ok);
    mockSshWorkspaceService.rebaseOnBranch.mockResolvedValue(ok);
    mockSshWorkspaceService.push.mockResolvedValue(ok);
    mockSshWorkspaceService.pull.mockResolvedValue(ok);
    mockSshWorkspaceService.pushTargetBranch.mockResolvedValue(ok);
    mockSshWorkspaceService.pullTargetBranch.mockResolvedValue(ok);
    mockSshWorkspaceService.mergeTargetBranchFromRemote.mockResolvedValue(ok);
    mockSshWorkspaceService.mergeToTargetBranch.mockResolvedValue(ok);

    registerGitHandlers();

    await ipcMain._invoke('workspace:fetch-remote', 'ws-ssh');
    await ipcMain._invoke('workspace:merge-from', 'ws-ssh', 'main', { stash: true });
    await ipcMain._invoke('workspace:rebase-on-branch', 'ws-ssh', 'main', { stash: true });
    await ipcMain._invoke('workspace:push', 'ws-ssh');
    await ipcMain._invoke('workspace:pull', 'ws-ssh');
    await ipcMain._invoke('workspace:push-target-branch', 'ws-ssh');
    await ipcMain._invoke('workspace:pull-target-branch', 'ws-ssh');
    await ipcMain._invoke('workspace:merge-target-branch-from-remote', 'ws-ssh');
    await ipcMain._invoke('workspace:merge-to-target-branch', 'ws-ssh');

    expect(mockSshWorkspaceService.fetchFromRemote).toHaveBeenCalledWith(backend);
    expect(mockSshWorkspaceService.mergeFrom).toHaveBeenCalledWith(backend, 'main', {
      stash: true,
      targetBranch: 'main',
    });
    expect(mockSshWorkspaceService.rebaseOnBranch).toHaveBeenCalledWith(backend, 'main', {
      stash: true,
      targetBranch: 'main',
    });
    expect(mockSshWorkspaceService.push).toHaveBeenCalledWith(backend);
    expect(mockSshWorkspaceService.pull).toHaveBeenCalledWith(backend);
    expect(mockSshWorkspaceService.pushTargetBranch).toHaveBeenCalledWith(backend);
    expect(mockSshWorkspaceService.pullTargetBranch).toHaveBeenCalledWith(backend);
    expect(mockSshWorkspaceService.mergeTargetBranchFromRemote).toHaveBeenCalledWith(backend);
    expect(mockSshWorkspaceService.mergeToTargetBranch).toHaveBeenCalledWith(backend);
    expect(mockGitService.fetchFromRemote).not.toHaveBeenCalled();
    expect(mockGitService.mergeFrom).not.toHaveBeenCalled();
    expect(mockGitService.rebaseOnBranch).not.toHaveBeenCalled();
  });

  it('routes workspace commit, branch-create and branch-switch actions through Workspace Git', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/dev/.komla/worktrees/app/feature',
      remoteRepoPath: '/home/dev/.komla/repos/app/repo.git',
      remoteProjectRoot: '/home/dev/.komla/worktrees/app',
      gitUrl: 'git@github.com:example/app.git',
      baseBranch: 'main',
    };
    mockWorkspaceService.get.mockReturnValue({
      id: 'ws-ssh',
      workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/app/feature',
      backend,
    });
    mockSshWorkspaceService.inspectCommitScope.mockResolvedValue({ scope: 'all', fileCount: 2 });
    mockSshWorkspaceService.commitChanges.mockResolvedValue({
      commitHash: 'abc',
      subject: 'Remote change',
    });
    mockSshWorkspaceService.switchBranch.mockResolvedValue({
      success: true,
      message: 'Switched to branch main',
    });
    registerGitHandlers();

    await ipcMain._invoke('workspace:inspect-commit-scope', 'ws-ssh');
    await ipcMain._invoke('workspace:commit-changes', 'ws-ssh', {
      subject: 'Remote change',
      body: null,
      scope: 'all',
    });
    await ipcMain._invoke('workspace:create-branch', 'ws-ssh', 'release', 'main');
    await ipcMain._invoke('workspace:switch-branch', 'ws-ssh', 'main');

    expect(mockSshWorkspaceService.createBranch).toHaveBeenCalledWith(backend, 'release', 'main');
    expect(mockSshWorkspaceService.inspectCommitScope).toHaveBeenCalledWith(backend);
    expect(mockSshWorkspaceService.commitChanges).toHaveBeenCalledWith(backend, {
      subject: 'Remote change',
      body: null,
      scope: 'all',
    });
    expect(mockSshWorkspaceService.switchBranch).toHaveBeenCalledWith(backend, 'main');
    expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-ssh', { branchName: 'main' });
    await expect(ipcMain._invoke('workspace:switch-branch', 'ws-ssh', '')).rejects.toThrow();
    await expect(ipcMain._invoke('workspace:create-branch', 'ws-ssh', '')).rejects.toThrow();
  });

  it('rejects SSH pseudo paths in local git file handlers', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerGitHandlers();

    await expect(
      ipcMain._invoke('git:delete-file', 'ssh://ssh-dev/home/dev/repo', 'README.md', 'modified')
    ).rejects.toThrow('not available for SSH workspaces');
    expect(mockGitService.deleteFile).not.toHaveBeenCalled();
  });

  it('returns hasRemote=false for invalid managed-repo:get-remote-status requests', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    mockProjectService.get.mockReturnValue(undefined);

    registerGitHandlers();

    const result = await ipcMain._invoke('managed-repo:get-remote-status', 'missing', 'main');

    expect(result).toEqual({ hasRemote: false, ahead: 0, behind: 0, lastFetched: null });
  });

  it('rejects invalid payloads for git:pull-rebase', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerGitHandlers();

    await expect(ipcMain._invoke('git:pull-rebase', '')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockGitService.pullRebase).not.toHaveBeenCalled();
  });

  it('aborts a local rebase and rejects invalid or SSH paths', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    const aborted = { success: true, message: 'Rebase aborted.' };
    mockGitService.abortRebase.mockResolvedValue(aborted);

    registerGitHandlers();

    await expect(ipcMain._invoke('git:abort-rebase', '')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    await expect(
      ipcMain._invoke('git:abort-rebase', 'ssh://ssh-dev/home/dev/repo')
    ).rejects.toThrow('not available for SSH workspaces');
    expect(mockGitService.abortRebase).not.toHaveBeenCalled();

    await expect(ipcMain._invoke('git:abort-rebase', '/repo/worktree')).resolves.toEqual(aborted);
    expect(mockGitService.abortRebase).toHaveBeenCalledWith('/repo/worktree');
  });

  it('validates commit input before invoking Git', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(
      ipcMain._invoke('git:commit-changes', '/tmp/repo', {
        subject: '   ',
        scope: 'everything',
      })
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockGitService.commitChanges).not.toHaveBeenCalled();
  });

  it('validates and invokes local commit-scope inspection', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    mockGitService.inspectCommitScope.mockResolvedValue({ scope: 'all', fileCount: 2 });
    registerGitHandlers();

    await expect(ipcMain._invoke('git:inspect-commit-scope', '/tmp/repo')).resolves.toEqual({
      scope: 'all',
      fileCount: 2,
    });
    await expect(ipcMain._invoke('git:inspect-commit-scope', '')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockGitService.inspectCommitScope).toHaveBeenCalledTimes(1);
  });

  it('passes an optional commit scope to local draft generation', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    mockGitService.generateCommitDraft.mockResolvedValue({
      subject: 'Update',
      body: null,
      scope: 'all',
      fileCount: 2,
    });
    registerGitHandlers();

    // The preload always sends the scope argument, undefined for the default scope.
    await ipcMain._invoke('git:generate-commit-draft', '/tmp/repo', undefined);
    await ipcMain._invoke('git:generate-commit-draft', '/tmp/repo', 'all');
    await expect(
      ipcMain._invoke('git:generate-commit-draft', '/tmp/repo', 'everything')
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });

    expect(mockGitService.generateCommitDraft).toHaveBeenNthCalledWith(1, '/tmp/repo', undefined);
    expect(mockGitService.generateCommitDraft).toHaveBeenNthCalledWith(2, '/tmp/repo', 'all');
    expect(mockGitService.generateCommitDraft).toHaveBeenCalledTimes(2);
  });
});
