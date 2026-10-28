import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockElectron } from '../../../mocks/electron';

const electronMock = mockElectron();
const mockPullRequestStatusService = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('electron', () => electronMock);

const mockGitService = {
  fetchFromRemote: vi.fn(),
  getRemoteUrl: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  pullRebase: vi.fn(),
  isGitRepo: vi.fn(),
  getMainBranch: vi.fn(),
  getFileMetadata: vi.fn(),
  setOriginRemote: vi.fn(),
  pushBranchesMissingFromOrigin: vi.fn(),
  removeOriginWithoutBranches: vi.fn(),
};

const mockGithubCli = {
  checkGhAuth: vi.fn(),
  createGithubRepo: vi.fn(),
};

const mockManagedRepoService = {
  fetch: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  getRemoteStatus: vi.fn(),
};

const mockProjectService = {
  get: vi.fn(),
  list: vi.fn(),
};

const mockWorkspaceService = {
  list: vi.fn(() => []),
  get: vi.fn(),
  ensureWatcherStarted: vi.fn(),
};

const mockWorkspaceStatusService = {
  change: vi.fn(),
  read: vi.fn((request?: unknown) => (request === undefined ? [] : undefined)),
  observe: vi.fn(() => ({ initial: [], close: vi.fn() })),
};

const mockSshWorkspaceService = {
  getBranchQuickStatus: vi.fn(),
  restoreFile: vi.fn(),
  push: vi.fn(),
  pushTargetBranch: vi.fn(),
};

const mockWorkspaceFileService = {
  listFiles: vi.fn(),
  readFile: vi.fn(),
  readImageFile: vi.fn(),
  importExternalFile: vi.fn(),
  readViewerFile: vi.fn(),
  getViewerPreviewUrl: vi.fn(),
  listViewerFolder: vi.fn(),
  deletePath: vi.fn(),
};

const mockHtmlPreviewService = {
  createPreviewUrl: vi.fn(),
  createContentPreviewUrl: vi.fn(),
};

const mockSearchService = {
  searchContent: vi.fn(),
};

const sshBackend = {
  kind: 'ssh' as const,
  hostId: 'ssh-dev',
  remoteDirectory: '/home/dev/worktree',
  remoteRepoPath: '/home/dev/repo.git',
  remoteProjectRoot: '/home/dev',
  gitUrl: 'git@example.com:repo.git',
};

function mockManagedSshWorkspace(): void {
  mockWorkspaceService.get.mockReturnValue({
    id: 'ws-ssh',
    projectId: 'project-1',
    workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
    backend: sshBackend,
  });
  mockProjectService.get.mockReturnValue({
    id: 'project-1',
    managed: true,
    managedRepoPath: '/local/repo.git',
    repositoryPath: '/local/project',
  });
}

vi.mock('../../../../src/main/services/git.service', () => ({ gitService: mockGitService }));
vi.mock('../../../../src/main/services/github-cli', () => mockGithubCli);
vi.mock('../../../../src/main/services/managed-repo.service', () => ({
  managedRepoService: mockManagedRepoService,
}));
vi.mock('../../../../src/main/services/project.service', () => ({
  projectService: mockProjectService,
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
vi.mock('../../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: mockSshWorkspaceService,
}));
vi.mock('../../../../src/main/services/workspace-git/ssh-git', () => ({
  sshWorkspaceGit: mockSshWorkspaceService,
}));
vi.mock('../../../../src/main/services/workspace-file.service', () => ({
  workspaceFileService: mockWorkspaceFileService,
}));
vi.mock('../../../../src/main/services/html-preview.service', () => ({
  htmlPreviewService: mockHtmlPreviewService,
}));
vi.mock('../../../../src/main/services/search.service', () => ({
  searchService: mockSearchService,
}));
vi.mock('../../../../src/main/services/metrics-collector.service', () => ({
  metricsCollectorService: { increment: vi.fn(), incrementMcpTool: vi.fn() },
}));
vi.mock('../../../../src/main/services/paths', () => ({
  getKomlaBasePath: vi.fn(() => '/mock/home/.komla'),
}));

// Mock schema validation to just pass through args
vi.mock('../../../../src/main/ipc/validation/ipc-validators', () => ({
  handleValidated: (channel: string, schema: any, handler: any) => {
    return (event: any, ...args: any[]) => handler(event, args);
  },
  onValidated: (channel: string, schema: any, handler: any) => {
    return (event: any, ...args: any[]) => handler(event, args);
  },
}));

// Mock path safety
vi.mock('../../../../src/main/ipc/validation/path-safety', () => ({
  assertSafeRelativePath: vi.fn(),
  assertSafePosixRelativePath: vi.fn(),
  assertNoNullBytes: vi.fn(),
}));

describe('git IPC behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    // Default success responses
    mockGitService.fetchFromRemote.mockResolvedValue({ success: true, message: 'Fetched' });
    mockGitService.getRemoteUrl.mockResolvedValue('git@example.com:repo.git');
    mockGitService.push.mockResolvedValue({ success: true, message: 'Pushed' });
    mockGitService.pull.mockResolvedValue({ success: true, message: 'Pulled' });
    mockGitService.pullRebase.mockResolvedValue({ success: true, message: 'Rebased' });
    mockGitService.isGitRepo.mockResolvedValue(true);

    mockManagedRepoService.fetch.mockResolvedValue({ success: true, message: 'Managed Fetched' });
    mockManagedRepoService.push.mockResolvedValue({ success: true, message: 'Managed Pushed' });
    mockManagedRepoService.pull.mockResolvedValue({ success: true, message: 'Managed Pulled' });
    mockSshWorkspaceService.push.mockResolvedValue({ success: true, message: 'Pushed remotely' });
    mockSshWorkspaceService.pushTargetBranch.mockResolvedValue({
      success: true,
      message: 'Pushed target remotely',
    });
    mockWorkspaceStatusService.change.mockResolvedValue({ disposition: 'applied' });
  });

  it('opens directory pickers next to the last selected folder', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    electronMock.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/code/repos/komla'],
    });
    await expect(ipcMain._invoke('config:select-directory')).resolves.toBe('/code/repos/komla');
    expect(electronMock.dialog.showOpenDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultPath: '/mock/home' })
    );

    await ipcMain._invoke('config:select-any-directory');
    expect(electronMock.dialog.showOpenDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultPath: '/code/repos' })
    );
  });

  it('creates isolated HTML previews from supplied remote content', async () => {
    mockHtmlPreviewService.createContentPreviewUrl.mockResolvedValue(
      'komla-preview://token/.komla-files/report.html'
    );
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    const html = '<html><body>Remote report</body></html>';
    const result = await ipcMain._invoke(
      'git:get-html-preview-url',
      'ssh://host/home/dev/worktree',
      '.komla-files/report.html',
      html
    );

    expect(result).toBe('komla-preview://token/.komla-files/report.html');
    expect(mockHtmlPreviewService.createContentPreviewUrl).toHaveBeenCalledWith(
      '.komla-files/report.html',
      html,
      { web: true }
    );
    expect(mockHtmlPreviewService.createPreviewUrl).not.toHaveBeenCalled();
  });

  it('deletes a workspace path through the workspace file service', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(
      ipcMain._invoke('workspace:delete-path', 'ws-ssh', 'src/generated')
    ).resolves.toBeUndefined();
    expect(mockWorkspaceFileService.deletePath).toHaveBeenCalledWith(
      'ws-ssh',
      'src/generated'
    );
  });

  it.each([
    ['workspace:push', mockSshWorkspaceService.push],
    ['workspace:push-target-branch', mockSshWorkspaceService.pushTargetBranch],
  ])('syncs local managed Git state after a successful SSH %s', async (channel, pushMock) => {
    mockManagedSshWorkspace();

    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain, BrowserWindow } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      BrowserWindow: { fromWebContents: ReturnType<typeof vi.fn> };
    };
    const send = vi.fn();
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({
      isDestroyed: () => false,
      webContents: { send },
    });
    registerGitHandlers();

    const result = await ipcMain._invoke(channel, 'ws-ssh');

    expect(pushMock).toHaveBeenCalledWith(sshBackend);
    expect(mockManagedRepoService.fetch).toHaveBeenCalledWith('/local/repo.git');
    expect(send).toHaveBeenCalledWith('git:progress', {
      operation: 'fetch',
      repoPath: 'ssh://ssh-dev/home/dev/worktree',
      percent: 0,
      stage: 'Syncing local Git state',
    });
    expect(result).toMatchObject({ success: true });
  });

  it('does not sync local Git state after a rejected SSH push', async () => {
    mockManagedSshWorkspace();
    mockSshWorkspaceService.push.mockResolvedValue({
      success: false,
      message: 'Remote has new commits',
      errorCode: 'rejected',
    });

    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    const result = await ipcMain._invoke('workspace:push', 'ws-ssh');

    expect(mockManagedRepoService.fetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      message: 'Remote has new commits',
      errorCode: 'rejected',
    });
  });

  it('does not sync local Git state when the SSH workspace uses a different remote', async () => {
    mockManagedSshWorkspace();
    mockGitService.getRemoteUrl.mockResolvedValue('git@example.com:other-repo.git');

    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain, BrowserWindow } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      BrowserWindow: { fromWebContents: ReturnType<typeof vi.fn> };
    };
    const send = vi.fn();
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({
      isDestroyed: () => false,
      webContents: { send },
    });
    registerGitHandlers();

    await expect(ipcMain._invoke('workspace:push', 'ws-ssh')).resolves.toMatchObject({
      success: true,
    });

    expect(mockManagedRepoService.fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith('git:progress', expect.anything());
  });

  it('syncs when HTTPS and SSH remote URLs identify the same repository', async () => {
    mockManagedSshWorkspace();
    mockWorkspaceService.get.mockReturnValue({
      id: 'ws-ssh',
      projectId: 'project-1',
      workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
      backend: { ...sshBackend, gitUrl: 'git@github.com:example/repo.git' },
    });
    mockGitService.getRemoteUrl.mockResolvedValue('https://github.com/example/repo');

    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await ipcMain._invoke('workspace:push', 'ws-ssh');

    expect(mockManagedRepoService.fetch).toHaveBeenCalledWith('/local/repo.git');
  });

  it('keeps the SSH push successful when the local sync fails', async () => {
    mockManagedSshWorkspace();
    mockManagedRepoService.fetch.mockResolvedValue({
      success: false,
      message: 'Local authentication failed',
    });

    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(ipcMain._invoke('workspace:push', 'ws-ssh')).resolves.toEqual({
      success: true,
      message: 'Pushed remotely',
    });
  });

  it('reports progress during git fetch', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain, BrowserWindow } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      BrowserWindow: { fromWebContents: any };
    };

    // Mock BrowserWindow to capture progress events
    const mockSend = vi.fn();
    const mockWindow = {
      isDestroyed: () => false,
      webContents: { send: mockSend },
    };
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockWindow as any);

    // Capture the callback passed to gitService.fetchFromRemote
    mockGitService.fetchFromRemote.mockImplementation(async (path, onProgress) => {
      onProgress(50, 'receiving objects');
      return { success: true, message: 'Fetched' };
    });

    registerGitHandlers();

    // We need to simulate the handler call manually because _invoke doesn't pass 'event' easily in this mock setup
    // But since we mocked handleValidated to pass-through, we can just call the handler directly if we could access it.
    // However, since we are using _invoke from our mockElectron, we need to ensure mockElectron supports it or use the real ipcMain behavior logic.
    // Our mockElectron's ipcMain.handle stores handlers.

    // Let's use the invoke mechanism provided by the electron mock
    await ipcMain._invoke('git:fetch', '/path/to/repo');

    expect(mockGitService.fetchFromRemote).toHaveBeenCalledWith(
      '/path/to/repo',
      expect.any(Function)
    );
    expect(mockSend).toHaveBeenCalledWith('git:progress', {
      operation: 'fetch',
      repoPath: '/path/to/repo',
      percent: 50,
      stage: 'receiving objects',
    });
  });

  it('delegates workspace file reads to workspaceFileService', async () => {
    mockWorkspaceFileService.listFiles.mockResolvedValue({
      files: ['src/app.ts'],
      gitIgnoredFiles: [],
      emptyDirs: [],
    });
    mockWorkspaceFileService.readFile.mockResolvedValue('content');
    mockWorkspaceFileService.readImageFile.mockResolvedValue({
      data: 'aW1hZ2U=',
      mimeType: 'image/png',
    });

    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(ipcMain._invoke('workspace:list-files', 'ws-ssh', true)).resolves.toMatchObject({
      files: ['src/app.ts'],
    });
    await expect(ipcMain._invoke('workspace:read-file', 'ws-ssh', 'src/app.ts')).resolves.toBe(
      'content'
    );
    await expect(
      ipcMain._invoke('workspace:read-image-file', 'ws-ssh', 'logo.png')
    ).resolves.toMatchObject({ mimeType: 'image/png' });

    expect(mockWorkspaceFileService.listFiles).toHaveBeenCalledWith('ws-ssh', true);
    expect(mockWorkspaceFileService.readFile).toHaveBeenCalledWith('ws-ssh', 'src/app.ts');
    expect(mockWorkspaceFileService.readImageFile).toHaveBeenCalledWith('ws-ssh', 'logo.png');
  });

  it('delegates workspace file imports with the terminal execution location', async () => {
    mockWorkspaceFileService.importExternalFile.mockResolvedValue('.komla-files/report.pdf');
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(
      ipcMain._invoke(
        'workspace:import-external-file',
        'ws-ssh',
        '/Users/ada/report.pdf',
        'report.pdf',
        'workspace'
      )
    ).resolves.toBe('.komla-files/report.pdf');
    expect(mockWorkspaceFileService.importExternalFile).toHaveBeenCalledWith(
      'ws-ssh',
      '/Users/ada/report.pdf',
      'report.pdf',
      'workspace'
    );
  });

  it('delegates file viewer reads, preview URLs and folders to workspaceFileService', async () => {
    const image = { data: 'aW1hZ2U=', mimeType: 'image/png' };
    mockWorkspaceFileService.readViewerFile.mockResolvedValue(image);
    mockWorkspaceFileService.getViewerPreviewUrl.mockResolvedValue('komla-preview://t/r.html');
    const folderFiles = [{ name: 'shot.png', modifiedMs: 1_700_000_000_000 }];
    mockWorkspaceFileService.listViewerFolder.mockResolvedValue(folderFiles);
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();
    const terminalSource = { kind: 'terminal', fullPath: '/tmp/shot.png' };
    const workspaceSource = { kind: 'workspace', filePath: 'out/r.html' };

    await expect(
      ipcMain._invoke('workspace:read-viewer-file', 'ws-ssh', 'term-ssh', terminalSource)
    ).resolves.toEqual(image);
    expect(mockWorkspaceFileService.readViewerFile).toHaveBeenCalledWith(
      'ws-ssh',
      'term-ssh',
      terminalSource
    );
    await expect(
      ipcMain._invoke('workspace:get-viewer-preview-url', 'ws-ssh', 'term-ssh', workspaceSource)
    ).resolves.toBe('komla-preview://t/r.html');
    expect(mockWorkspaceFileService.getViewerPreviewUrl).toHaveBeenCalledWith(
      'ws-ssh',
      'term-ssh',
      workspaceSource,
      undefined
    );
    await expect(
      ipcMain._invoke('workspace:list-viewer-folder', 'ws-ssh', 'term-ssh', terminalSource)
    ).resolves.toEqual(folderFiles);
    expect(mockWorkspaceFileService.listViewerFolder).toHaveBeenCalledWith(
      'ws-ssh',
      'term-ssh',
      terminalSource
    );
  });

  it('invalidates the pushed SSH diff snapshot after a remote restore fails', async () => {
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/dev/worktree',
      remoteRepoPath: '/home/dev/repo.git',
      remoteProjectRoot: '/home/dev',
      gitUrl: 'git@example.com:repo.git',
    };
    mockWorkspaceService.get.mockReturnValue({ id: 'ws-ssh', backend });
    mockSshWorkspaceService.restoreFile.mockRejectedValue(new Error('remote failed'));

    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerGitHandlers();

    await expect(
      ipcMain._invoke('workspace:restore-file', 'ws-ssh', 'odd\nname.ts', 'modified')
    ).rejects.toThrow('remote failed');
    expect(mockWorkspaceStatusService.change).toHaveBeenCalledWith({
      kind: 'repository-mutated',
      workspaceId: 'ws-ssh',
    });
  });

  it('returns generic file metadata for binary preview synchronization', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    mockGitService.getFileMetadata.mockResolvedValue({ size: 42, mtimeMs: 100 });

    registerGitHandlers();
    const result = await ipcMain._invoke('git:get-file-metadata', '/repo', 'document.pdf');

    expect(mockGitService.getFileMetadata).toHaveBeenCalledWith('/repo', 'document.pdf');
    expect(result).toEqual({ size: 42, mtimeMs: 100 });
  });

  it('reports progress during git pull-rebase', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain, BrowserWindow } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      BrowserWindow: { fromWebContents: any };
    };

    const mockSend = vi.fn();
    const mockWindow = {
      isDestroyed: () => false,
      webContents: { send: mockSend },
    };
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockWindow as any);

    mockGitService.pullRebase.mockImplementation(async (path, onProgress) => {
      onProgress(75, 'rebasing commits');
      return { success: true, message: 'Rebased' };
    });

    registerGitHandlers();

    const result = await ipcMain._invoke('git:pull-rebase', '/path/to/repo');

    expect(mockGitService.pullRebase).toHaveBeenCalledWith('/path/to/repo', expect.any(Function));
    expect(mockSend).toHaveBeenCalledWith('git:progress', {
      operation: 'pull',
      repoPath: '/path/to/repo',
      percent: 75,
      stage: 'rebasing commits',
    });
    expect(result).toEqual({ success: true, message: 'Rebased' });
  });

  it('delegates managed-repo:fetch to managedRepoService for managed projects', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    mockProjectService.get.mockReturnValue({
      id: 'p1',
      managed: true,
      managedRepoPath: '/managed/path/repo.git',
    });

    registerGitHandlers();
    const result = await ipcMain._invoke('managed-repo:fetch', 'p1');

    expect(mockManagedRepoService.fetch).toHaveBeenCalledWith('/managed/path/repo.git');
    expect(result).toEqual({ success: true, message: 'Managed Fetched' });
  });

  it('falls back to gitService.fetchFromRemote for unmanaged projects in managed-repo:fetch', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    mockProjectService.get.mockReturnValue({
      id: 'p2',
      managed: false,
      repositoryPath: '/normal/repo',
    });

    registerGitHandlers();
    const result = await ipcMain._invoke('managed-repo:fetch', 'p2');

    expect(mockManagedRepoService.fetch).not.toHaveBeenCalled();
    expect(mockGitService.fetchFromRemote).toHaveBeenCalledWith('/normal/repo');
    expect(result).toEqual({ success: true, message: 'Fetched' });
  });

  it('aggregates project sync statuses excluding failed/unmanaged ones', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    mockProjectService.list.mockReturnValue([
      { id: 'p1', managed: true, managedRepoPath: '/managed/p1.git' },
      { id: 'p2', managed: false }, // Should skip
      { id: 'p3', managed: true, managedRepoPath: '/managed/p3.git' },
    ]);

    mockGitService.getMainBranch.mockResolvedValue('main');
    mockManagedRepoService.getRemoteStatus.mockImplementation(async (path) => {
      if (path === '/managed/p3.git') throw new Error('Repo broken');
      return { ahead: 1, behind: 2, lastFetched: 1000 };
    });

    registerGitHandlers();
    const results = (await ipcMain._invoke('project-sync:get-all-statuses')) as any[];

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      projectId: 'p1',
      behindRemote: 2,
      aheadRemote: 1,
      lastFetched: 1000,
      mainBranch: 'main',
    });
  });

  it('uses project baseBranch for sync status when set', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    mockProjectService.list.mockReturnValue([
      { id: 'p1', managed: true, managedRepoPath: '/managed/p1.git', baseBranch: 'develop' },
    ]);

    mockGitService.getMainBranch.mockResolvedValue('main');
    mockManagedRepoService.getRemoteStatus.mockResolvedValue({
      ahead: 3,
      behind: 1,
      lastFetched: 500,
    });

    registerGitHandlers();
    const results = (await ipcMain._invoke('project-sync:get-all-statuses')) as any[];

    // Should use project baseBranch, not auto-detected main
    expect(mockManagedRepoService.getRemoteStatus).toHaveBeenCalledWith(
      '/managed/p1.git',
      'develop'
    );
    expect(mockGitService.getMainBranch).not.toHaveBeenCalled();
    expect(results[0]).toEqual({
      projectId: 'p1',
      behindRemote: 1,
      aheadRemote: 3,
      lastFetched: 500,
      mainBranch: 'develop',
    });
  });

  it('refreshes project sync status with fetch', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    mockProjectService.get.mockReturnValue({
      id: 'p1',
      managed: true,
      managedRepoPath: '/managed/p1.git',
    });
    mockGitService.getMainBranch.mockResolvedValue('master');
    mockManagedRepoService.getRemoteStatus.mockResolvedValue({
      ahead: 0,
      behind: 5,
      lastFetched: 2000,
    });

    registerGitHandlers();
    const result = await ipcMain._invoke('project-sync:refresh', 'p1');

    expect(mockManagedRepoService.fetch).toHaveBeenCalledWith('/managed/p1.git');
    expect(result).toEqual({
      projectId: 'p1',
      behindRemote: 5,
      aheadRemote: 0,
      lastFetched: 2000,
      mainBranch: 'master',
    });
  });

  it('uses project baseBranch when refreshing sync status', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    mockProjectService.get.mockReturnValue({
      id: 'p1',
      managed: true,
      managedRepoPath: '/managed/p1.git',
      baseBranch: 'develop',
    });
    mockGitService.getMainBranch.mockResolvedValue('main');
    mockManagedRepoService.getRemoteStatus.mockResolvedValue({
      ahead: 2,
      behind: 3,
      lastFetched: 3000,
    });

    registerGitHandlers();
    const result = await ipcMain._invoke('project-sync:refresh', 'p1');

    // Should use project baseBranch, not auto-detected main
    expect(mockManagedRepoService.getRemoteStatus).toHaveBeenCalledWith(
      '/managed/p1.git',
      'develop'
    );
    expect(mockGitService.getMainBranch).not.toHaveBeenCalled();
    expect(result).toEqual({
      projectId: 'p1',
      behindRemote: 3,
      aheadRemote: 2,
      lastFetched: 3000,
      mainBranch: 'develop',
    });
  });

  it('points origin at the URL the user enters', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    mockGitService.setOriginRemote.mockResolvedValue(undefined);

    registerGitHandlers();
    const result = await ipcMain._invoke(
      'git:add-origin-remote',
      '/projects/new',
      'git@github.com:me/new.git'
    );

    expect(mockGitService.setOriginRemote).toHaveBeenCalledWith(
      '/projects/new',
      'git@github.com:me/new.git'
    );
    expect(result).toEqual({ success: true, message: 'Remote added successfully' });
  });

  it('removes a new origin that has no branches when pushing to it fails', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    mockProjectService.get.mockReturnValue({
      id: 'p1',
      managed: true,
      managedRepoPath: '/managed/p1/.git',
      repositoryPath: '/managed/p1',
    });
    mockGitService.pushBranchesMissingFromOrigin.mockRejectedValue(
      new Error('ERROR: Repository not found.')
    );
    mockGitService.removeOriginWithoutBranches.mockResolvedValue(true);

    registerGitHandlers();
    const result = await ipcMain._invoke('git:push-project-branches', 'p1', ['main']);

    expect(mockGitService.removeOriginWithoutBranches).toHaveBeenCalledWith('/managed/p1/.git');
    expect(result).toEqual({
      success: false,
      message: 'ERROR: Repository not found.',
      removedOrigin: true,
    });
  });

  it('keeps origin when pushing the branches succeeds', async () => {
    const { registerGitHandlers } = await import('../../../../src/main/ipc/handlers/git.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    mockProjectService.get.mockReturnValue({
      id: 'p1',
      managed: true,
      managedRepoPath: '/managed/p1/.git',
      repositoryPath: '/managed/p1',
    });
    mockGitService.pushBranchesMissingFromOrigin.mockResolvedValue(['main']);

    registerGitHandlers();
    const result = await ipcMain._invoke('git:push-project-branches', 'p1', ['main']);

    expect(mockGitService.removeOriginWithoutBranches).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, message: 'Pushed main' });
  });
});
