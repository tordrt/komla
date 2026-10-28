import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  WORKSPACE_LIMIT_ERROR_PREFIX,
  DUPLICATE_WORKSPACE_ERROR_PREFIX,
} from '../../../../src/shared/types/workspace';
import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const { mockExecFile, mockRm, mockRealpath, mockBuildTerminalEnv, mockGetShell, mockGetShellArgs } =
  vi.hoisted(() => ({
    mockExecFile: vi.fn(
      (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
        callback(null, '', '');
      }
    ),
    mockRm: vi.fn(async () => undefined),
    mockRealpath: vi.fn(async (p: string) => p),
    mockBuildTerminalEnv: vi.fn(() => ({ PATH: '/mock/path' })),
    mockGetShell: vi.fn(() => '/bin/zsh'),
    mockGetShellArgs: vi.fn(() => ['-l', '-o', 'nopromptsp']),
  }));

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('../../../../src/main/lib/shell', () => ({
  buildTerminalEnv: mockBuildTerminalEnv,
  getShell: mockGetShell,
  getShellArgs: mockGetShellArgs,
}));

vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  rm: mockRm,
  realpath: mockRealpath,
}));

const mockWorkspaceService = {
  create: vi.fn(),
  createBatch: vi.fn(),
  addTerminal: vi.fn(),
  addTerminalWithPreparation: vi.fn(),
  removeTerminal: vi.fn(),
  stop: vi.fn(),
  stopStepsSettled: vi.fn(),
  stopTerminal: vi.fn(),
  restartTerminal: vi.fn(),
  reconnectSshTerminal: vi.fn(),
  recoverSshSessions: vi.fn(),
  retryLocalMirrorSync: vi.fn(),
  retrySetupStep: vi.fn(),
  dismissSetupActivity: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(() => []),
  get: vi.fn(),
  update: vi.fn(),
  updateTerminal: vi.fn(),
  restart: vi.fn(),
  restartWithCleanup: vi.fn(),
  reorderWorkspace: vi.fn(),
  clearAttention: vi.fn(),
};

const mockGitService = {
  hasUncommittedChanges: vi.fn(),
};

const mockWorktreeWatcherService = {
  stopWatching: vi.fn(async () => undefined),
  startWatching: vi.fn(async () => undefined),
  isWatching: vi.fn(() => true),
};

const mockSshPortForwardService = {
  startPreviewForward: vi.fn(),
  startLinkForward: vi.fn(),
  stopLinkForward: vi.fn(),
  stopPreviewForward: vi.fn(),
};

const mockSshWorkspaceService = {
  runTrashCleanup: vi.fn(),
};

const mockLocalMirrorService = {
  remove: vi.fn(async () => undefined),
};

const mockConfigService = {
  get: vi.fn(() => ({})),
  update: vi.fn(),
};

const mockProjectService = {
  get: vi.fn(),
};

vi.mock('../../../../src/main/services/workspace.service', () => ({
  workspaceService: mockWorkspaceService,
}));

vi.mock('../../../../src/main/services/git.service', () => ({
  gitService: mockGitService,
}));

vi.mock('../../../../src/main/services/worktree-watcher.service', () => ({
  worktreeWatcherService: mockWorktreeWatcherService,
}));

vi.mock('../../../../src/main/services/ssh-port-forward.service', () => ({
  sshPortForwardService: mockSshPortForwardService,
}));

vi.mock('../../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: mockSshWorkspaceService,
}));

vi.mock('../../../../src/main/services/local-mirror.service', () => ({
  localMirrorService: mockLocalMirrorService,
}));

vi.mock('../../../../src/main/services/config.service', () => ({
  configService: mockConfigService,
}));

vi.mock('../../../../src/main/services/project.service', () => ({
  projectService: mockProjectService,
}));

type IpcMainWithInvoke = { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };

async function setup() {
  const { registerWorkspaceHandlers } =
    await import('../../../../src/main/ipc/handlers/workspace.handlers');
  const { ipcMain } = (await import('electron')) as unknown as { ipcMain: IpcMainWithInvoke };
  registerWorkspaceHandlers();
  return ipcMain;
}

describe('workspace IPC behavior', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockConfigService.get.mockReturnValue({});
    mockProjectService.get.mockReturnValue(undefined);
    mockExecFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
        callback(null, '', '');
      }
    );
    mockBuildTerminalEnv.mockReturnValue({ PATH: '/mock/path' });
    mockGetShell.mockReturnValue('/bin/zsh');
    mockGetShellArgs.mockReturnValue(['-l', '-o', 'nopromptsp']);
    mockRm.mockResolvedValue(undefined);
    mockRealpath.mockImplementation(async (p: string) => p);
    mockWorktreeWatcherService.isWatching.mockReturnValue(true);
    mockWorkspaceService.stop.mockResolvedValue(undefined);
    mockWorkspaceService.restartWithCleanup.mockResolvedValue(undefined);
  });

  // Channels whose handler only validates its arguments and hands them to one service method.
  it.each<{ channel: string; args: unknown[]; method: Mock; returns?: unknown }>([
    {
      channel: 'workspace:list',
      args: [],
      method: mockWorkspaceService.list,
      returns: [{ id: 'ws-1' }],
    },
    {
      channel: 'workspace:delete',
      args: ['ws-1', false, false],
      method: mockWorkspaceService.delete,
    },
    {
      channel: 'workspace:delete',
      args: ['ws-1', true, true],
      method: mockWorkspaceService.delete,
    },
    { channel: 'workspace:stop', args: ['ws-1'], method: mockWorkspaceService.stop },
    {
      channel: 'workspace:stop-ssh-link-forward',
      args: ['ws-1', 'forward-1'],
      method: mockSshPortForwardService.stopLinkForward,
    },
    {
      channel: 'workspace:stop-ssh-preview-forward',
      args: ['ws-1', 'tab-1'],
      method: mockSshPortForwardService.stopPreviewForward,
    },
    {
      channel: 'workspace:remove-terminal',
      args: ['ws-1', 'term-1'],
      method: mockWorkspaceService.removeTerminal,
    },
    {
      channel: 'workspace:reconnect-ssh-terminal',
      args: ['term-1', 120, 30],
      method: mockWorkspaceService.reconnectSshTerminal,
      returns: { id: 'term-1', status: 'starting' },
    },
    {
      channel: 'workspace:recover-ssh-sessions',
      args: ['ssh-ws'],
      method: mockWorkspaceService.recoverSshSessions,
      returns: { id: 'ssh-ws', backend: { kind: 'ssh' } },
    },
  ])('$channel hands $args to its service', async ({ channel, args, method, returns }) => {
    const ipcMain = await setup();
    method.mockResolvedValue(returns);

    const result = await ipcMain._invoke(channel, ...args);

    expect(method).toHaveBeenCalledWith(...args);
    expect(result).toEqual(returns);
  });

  describe('workspace:create', () => {
    it('delegates to workspaceService.create', async () => {
      const ipcMain = await setup();
      const params = { mode: 'worktree' as const, name: 'Test Workspace' };
      const created = { id: 'ws-1', ...params };
      mockWorkspaceService.create.mockReturnValue(created);

      const result = await ipcMain._invoke('workspace:create', params);

      expect(mockWorkspaceService.create).toHaveBeenCalledWith(params);
      expect(result).toEqual(created);
    });

    it('returns workspace limit error as value instead of throwing', async () => {
      const ipcMain = await setup();
      const params = { mode: 'worktree' as const, name: 'Test' };
      const errorMsg = `${WORKSPACE_LIMIT_ERROR_PREFIX}Free plan is limited to 4 running workspaces.`;
      mockWorkspaceService.create.mockRejectedValue(new Error(errorMsg));

      const result = await ipcMain._invoke('workspace:create', params);

      expect(result).toEqual({ __workspaceCreateError: true, message: errorMsg });
    });

    it('returns duplicate workspace error as value instead of throwing', async () => {
      const ipcMain = await setup();
      const params = { mode: 'directory' as const, directoryPath: '/tmp/foo' };
      const errorMsg = `${DUPLICATE_WORKSPACE_ERROR_PREFIX}A workspace already exists for this directory: "my-project"`;
      mockWorkspaceService.create.mockRejectedValue(new Error(errorMsg));

      const result = await ipcMain._invoke('workspace:create', params);

      expect(result).toEqual({ __workspaceCreateError: true, message: errorMsg });
    });

    it('returns branch conflict error as value instead of throwing', async () => {
      const ipcMain = await setup();
      const params = { mode: 'worktree' as const, name: 'Test' };
      const errorMsg =
        'Branch "main" is already open in workspace "komla (main)". Open that workspace or choose a different branch.';
      mockWorkspaceService.create.mockRejectedValue(new Error(errorMsg));

      const result = await ipcMain._invoke('workspace:create', params);

      expect(result).toEqual({ __workspaceCreateError: true, message: errorMsg });
    });

    it('returns active worktree conflict error as value instead of throwing', async () => {
      const ipcMain = await setup();
      const params = { mode: 'worktree' as const, name: 'Test' };
      const errorMsg =
        'Branch "feature" already has an active worktree. Choose a different branch or remove the existing worktree first.';
      mockWorkspaceService.create.mockRejectedValue(new Error(errorMsg));

      const result = await ipcMain._invoke('workspace:create', params);

      expect(result).toEqual({ __workspaceCreateError: true, message: errorMsg });
    });

    it('returns a project that needs a remote with its id and branches', async () => {
      const ipcMain = await setup();
      // setup() resets modules; the handler matches the class from its own module instance.
      const { SshProjectNeedsRemoteError } = await import('../../../../src/shared/types/workspace');
      const detail = { projectId: 'project-1', branches: ['main'] };
      mockWorkspaceService.create.mockRejectedValue(new SshProjectNeedsRemoteError(detail));

      const result = await ipcMain._invoke('workspace:create', { mode: 'worktree' as const });

      expect(result).toEqual({
        __workspaceCreateError: true,
        message: 'SSH workspaces require a Git remote URL. Add a remote to this project.',
        sshProjectNeedsRemote: detail,
      });
    });

    it('rethrows unexpected errors', async () => {
      const ipcMain = await setup();
      const params = { mode: 'worktree' as const, name: 'Test' };
      mockWorkspaceService.create.mockRejectedValue(new Error('disk full'));

      await expect(ipcMain._invoke('workspace:create', params)).rejects.toThrow('disk full');
    });
  });

  describe('workspace:create-batch', () => {
    it('delegates the complete batch to workspaceService.createBatch', async () => {
      const ipcMain = await setup();
      const params = [
        { mode: 'directory' as const, directoryPath: '/tmp/one' },
        { mode: 'directory' as const, directoryPath: '/tmp/two' },
      ];
      const created = [{ id: 'ws-1' }, { id: 'ws-2' }];
      mockWorkspaceService.createBatch.mockResolvedValue(created);

      const result = await ipcMain._invoke('workspace:create-batch', params);

      expect(mockWorkspaceService.createBatch).toHaveBeenCalledWith(params);
      expect(result).toEqual(created);
    });

    it('returns workspace limit errors without starting individual creates', async () => {
      const ipcMain = await setup();
      const errorMsg = `${WORKSPACE_LIMIT_ERROR_PREFIX}Not enough slots for the batch.`;
      mockWorkspaceService.createBatch.mockRejectedValue(new Error(errorMsg));

      const result = await ipcMain._invoke('workspace:create-batch', [
        { mode: 'directory', directoryPath: '/tmp/one' },
        { mode: 'directory', directoryPath: '/tmp/two' },
      ]);

      expect(result).toEqual({ __workspaceCreateError: true, message: errorMsg });
      expect(mockWorkspaceService.create).not.toHaveBeenCalled();
    });

    it('rejects an empty batch during IPC validation', async () => {
      const ipcMain = await setup();

      await expect(ipcMain._invoke('workspace:create-batch', [])).rejects.toThrow();
      expect(mockWorkspaceService.createBatch).not.toHaveBeenCalled();
    });
  });

  describe('workspace:get', () => {
    it('returns workspace by ID', async () => {
      const ipcMain = await setup();
      const workspace = { id: 'ws-1', name: 'Test' };
      mockWorkspaceService.get.mockReturnValue(workspace);

      const result = await ipcMain._invoke('workspace:get', 'ws-1');

      expect(mockWorkspaceService.get).toHaveBeenCalledWith('ws-1');
      expect(result).toEqual(workspace);
    });

    it('returns undefined for non-existent workspace', async () => {
      const ipcMain = await setup();
      mockWorkspaceService.get.mockReturnValue(undefined);

      const result = await ipcMain._invoke('workspace:get', 'nonexistent');

      expect(result).toBeUndefined();
    });
  });

  describe('workspace Setup activity', () => {
    it('retries only the requested Setup step', async () => {
      const ipcMain = await setup();
      const workspace = { id: 'ws-1', setupActivities: [] };
      mockWorkspaceService.retrySetupStep.mockReturnValue(workspace);

      const result = await ipcMain._invoke('workspace:retry-setup-step', 'ws-1', 'step-1');

      expect(mockWorkspaceService.retrySetupStep).toHaveBeenCalledWith('ws-1', 'step-1');
      expect(result).toBe(workspace);
    });

    it('dismisses only the requested Setup activity run', async () => {
      const ipcMain = await setup();
      const workspace = { id: 'ws-1', setupActivities: [] };
      mockWorkspaceService.dismissSetupActivity.mockReturnValue(workspace);

      const result = await ipcMain._invoke(
        'workspace:dismiss-setup-activity',
        'ws-1',
        'activity-1'
      );

      expect(mockWorkspaceService.dismissSetupActivity).toHaveBeenCalledWith('ws-1', 'activity-1');
      expect(result).toBe(workspace);
    });
  });

  it('retries a local mirror sync', async () => {
    const ipcMain = await setup();

    await ipcMain._invoke('workspace:retry-local-mirror-sync', 'ws-1');

    expect(mockWorkspaceService.retryLocalMirrorSync).toHaveBeenCalledWith('ws-1');
  });

  describe('workspace:update', () => {
    it('delegates to workspaceService.update', async () => {
      const ipcMain = await setup();
      const updated = { id: 'ws-1', name: 'Updated' };
      mockWorkspaceService.get.mockReturnValue({ id: 'ws-1', name: 'Old', status: 'active' });
      mockWorkspaceService.update.mockReturnValue(updated);

      const result = await ipcMain._invoke('workspace:update', 'ws-1', { name: 'Updated' });

      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', { name: 'Updated' });
      expect(result).toEqual(updated);
    });

    it('does not touch watcher when trash state does not change', async () => {
      const ipcMain = await setup();
      mockWorkspaceService.get.mockReturnValue({ id: 'ws-1', status: 'active' });
      mockWorkspaceService.update.mockReturnValue({
        id: 'ws-1',
        status: 'active',
        name: 'Renamed',
      });

      await ipcMain._invoke('workspace:update', 'ws-1', { name: 'Renamed' });

      expect(mockWorktreeWatcherService.stopWatching).not.toHaveBeenCalled();
      expect(mockWorktreeWatcherService.startWatching).not.toHaveBeenCalled();
    });

    it('confirms SSH session cleanup before trashing', async () => {
      const ipcMain = await setup();
      mockWorkspaceService.get.mockReturnValue({
        id: 'ssh-ws',
        status: 'active',
        backend: { kind: 'ssh', hostId: 'ssh-dev' },
      });
      mockWorkspaceService.stop.mockResolvedValue(undefined);
      mockWorkspaceService.update.mockReturnValue({ id: 'ssh-ws', status: 'trashed' });

      await ipcMain._invoke('workspace:update', 'ssh-ws', { status: 'trashed' });

      expect(mockWorkspaceService.stop).toHaveBeenCalledWith('ssh-ws');
      expect(mockWorkspaceService.stop.mock.invocationCallOrder[0]).toBeLessThan(
        mockWorkspaceService.update.mock.invocationCallOrder[0]
      );
    });

    it('does not trash an SSH workspace when session cleanup fails', async () => {
      const ipcMain = await setup();
      mockWorkspaceService.get.mockReturnValue({
        id: 'ssh-ws',
        status: 'active',
        backend: { kind: 'ssh', hostId: 'ssh-dev' },
      });
      mockWorkspaceService.stop.mockRejectedValue(new Error('remote offline'));

      await expect(
        ipcMain._invoke('workspace:update', 'ssh-ws', { status: 'trashed' })
      ).rejects.toThrow('remote offline');
      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
    });

    it('runs trash cleanup on the SSH workspace before trashing', async () => {
      const ipcMain = await setup();
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'https://github.com/example/repo.git',
      };
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'rm -rf node_modules',
      });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ssh-ws',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
        isWorktree: true,
        backend,
      });
      mockWorkspaceService.update.mockReturnValue({
        id: 'ssh-ws',
        status: 'trashed',
        backend,
      });

      await ipcMain._invoke('workspace:update', 'ssh-ws', { status: 'trashed' });

      expect(mockWorkspaceService.stop).toHaveBeenCalledWith('ssh-ws');
      expect(mockSshWorkspaceService.runTrashCleanup).toHaveBeenCalledWith(
        backend,
        'rm -rf node_modules'
      );
      expect(mockLocalMirrorService.remove).toHaveBeenCalledWith('ssh-ws', backend);
      expect(mockSshWorkspaceService.runTrashCleanup.mock.invocationCallOrder[0]).toBeLessThan(
        mockLocalMirrorService.remove.mock.invocationCallOrder[0]
      );
      expect(mockLocalMirrorService.remove.mock.invocationCallOrder[0]).toBeLessThan(
        mockWorkspaceService.update.mock.invocationCallOrder[0]
      );
      expect(mockRm).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ssh-ws', {
        status: 'trashed',
      });
    });

    it('keeps an SSH workspace restored when Local copy removal fails', async () => {
      const ipcMain = await setup();
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'https://github.com/example/repo.git',
      };
      mockWorkspaceService.get.mockReturnValue({
        id: 'ssh-ws',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
        isWorktree: true,
        backend,
      });
      mockLocalMirrorService.remove.mockRejectedValueOnce(new Error('local folder is busy'));

      await expect(
        ipcMain._invoke('workspace:update', 'ssh-ws', { status: 'trashed' })
      ).rejects.toThrow('local folder is busy');

      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
    });

    it("handles the project's simple rm -rf trash cleanup natively before trashing a worktree workspace", async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'rm -rf node_modules dist',
      });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      mockWorkspaceService.update.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'trashed',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });

      await ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' });

      expect(mockProjectService.get).toHaveBeenCalledWith('proj-1');
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockRm).toHaveBeenCalledWith('/tmp/repo/node_modules', {
        recursive: true,
        force: true,
      });
      expect(mockRm).toHaveBeenCalledWith('/tmp/repo/dist', { recursive: true, force: true });
      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', { status: 'trashed' });
    });

    it('uses the shell for custom trash cleanup scripts', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'npm run cleanup',
      });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      mockWorkspaceService.update.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'trashed',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });

      await ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' });

      expect(mockRm).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l', '-o', 'nopromptsp', '-c', 'npm run cleanup'],
        expect.objectContaining({ cwd: '/tmp/repo', env: { PATH: '/mock/path' } }),
        expect.any(Function)
      );
      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', { status: 'trashed' });
    });

    it('uses the configured PowerShell command flag for custom trash cleanup scripts', async () => {
      const ipcMain = await setup();
      mockGetShell.mockReturnValue('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
      mockGetShellArgs.mockReturnValue(['-ExecutionPolicy', 'Bypass', '-NoLogo']);
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'npm run cleanup',
      });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: 'C:\\repo',
        isWorktree: true,
      });
      mockWorkspaceService.update.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'trashed',
        workingDirectory: 'C:\\repo',
        isWorktree: true,
      });

      await ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' });

      expect(mockExecFile).toHaveBeenCalledWith(
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        ['-ExecutionPolicy', 'Bypass', '-NoLogo', '-Command', 'npm run cleanup'],
        expect.objectContaining({ cwd: 'C:\\repo' }),
        expect.any(Function)
      );
    });

    it('uses the shell for rm -rf scripts with unsupported paths', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'rm -rf *.egg-info',
      });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      mockWorkspaceService.update.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'trashed',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });

      await ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' });

      expect(mockRm).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l', '-o', 'nopromptsp', '-c', 'rm -rf *.egg-info'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
        expect.any(Function)
      );
      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', { status: 'trashed' });
    });

    it('does nothing when the project has no cleanup script', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({ id: 'proj-1' });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      mockWorkspaceService.update.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'trashed',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });

      await ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' });

      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', { status: 'trashed' });
    });

    it('skips the cleanup script for directory-mode workspaces', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'rm -rf node_modules',
      });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: false,
      });
      mockWorkspaceService.update.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'trashed',
        workingDirectory: '/tmp/repo',
        isWorktree: false,
      });

      await ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' });

      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', { status: 'trashed' });
    });

    it('does not run the cleanup script when the workspace is already trashed', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'rm -rf node_modules',
      });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'trashed',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      mockWorkspaceService.update.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'trashed',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });

      await ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' });

      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('does not run the cleanup script when status is not changing to trashed', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'rm -rf node_modules',
      });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      mockWorkspaceService.update.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });

      await ipcMain._invoke('workspace:update', 'ws-1', { name: 'renamed' });

      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('does not trash when the cleanup script fails', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'npm run cleanup',
      });
      mockExecFile.mockImplementation(
        (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
          callback(new Error('exit 1'), '', 'failed');
        }
      );
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });

      await expect(
        ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' })
      ).rejects.toThrow('Trash cleanup script failed');
      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
    });

    it('falls back to shell when an rm path looks like a flag', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'rm -rf -delete-me',
      });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      mockWorkspaceService.update.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'trashed',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });

      await ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' });

      // Native fs.rm would happily delete a file named "-delete-me", but POSIX rm
      // would treat it as an unknown option. Defer to shell for parity.
      expect(mockRm).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l', '-o', 'nopromptsp', '-c', 'rm -rf -delete-me'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
        expect.any(Function)
      );
    });

    it('refuses native cleanup when a symlinked subdir would escape the workspace', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'rm -rf vendor/bundle',
      });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      // Simulate `vendor` inside the workspace being a symlink to /shared so that
      // the realpath of the parent of `vendor/bundle` lands outside the workspace.
      mockRealpath.mockImplementation(async (p: string) => {
        if (p === '/tmp/repo') return '/tmp/repo';
        if (p === '/tmp/repo/vendor') return '/shared';
        return p;
      });

      await expect(
        ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' })
      ).rejects.toThrow('Trash cleanup script failed');

      expect(mockRm).not.toHaveBeenCalled();
      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
    });

    it('skips native deletion when the parent directory does not exist', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'rm -rf node_modules ghost/missing',
      });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      mockWorkspaceService.update.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'trashed',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      mockRealpath.mockImplementation(async (p: string) => {
        if (p === '/tmp/repo/ghost') {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return p;
      });

      await ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' });

      // node_modules deletes normally; ghost/missing is silently skipped.
      expect(mockRm).toHaveBeenCalledWith('/tmp/repo/node_modules', {
        recursive: true,
        force: true,
      });
      expect(mockRm).not.toHaveBeenCalledWith('/tmp/repo/ghost/missing', expect.anything());
    });

    it('falls back to shell when the rm script contains shell metacharacters', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'rm -rf node_modules && npm run cleanup:trash',
      });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      mockWorkspaceService.update.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'trashed',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });

      await ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' });

      // `&&` must NOT be treated as a literal directory name to be deleted natively.
      expect(mockRm).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l', '-o', 'nopromptsp', '-c', 'rm -rf node_modules && npm run cleanup:trash'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
        expect.any(Function)
      );
    });

    it('stops the worktree watcher before cleanup and leaves it stopped on success', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'rm -rf node_modules',
      });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      mockWorkspaceService.update.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'trashed',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      const order: string[] = [];
      mockWorktreeWatcherService.stopWatching.mockImplementation(async () => {
        order.push('stopWatcher');
      });
      mockRm.mockImplementation(async () => {
        order.push('rm');
      });

      await ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' });

      // Watcher must be stopped at least once before rm runs.
      expect(order[0]).toBe('stopWatcher');
      expect(order).toContain('rm');
      expect(order.indexOf('stopWatcher')).toBeLessThan(order.indexOf('rm'));
      expect(mockWorktreeWatcherService.startWatching).not.toHaveBeenCalled();
    });

    it("waits for the stop's stop steps before Trash cleanup", async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'rm -rf node_modules',
      });
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      mockWorkspaceService.update.mockReturnValue({ id: 'ws-1', status: 'trashed' });
      const order: string[] = [];
      mockWorkspaceService.stopStepsSettled.mockReturnValue(
        Promise.resolve().then(() => {
          order.push('stop steps');
        })
      );
      mockRm.mockImplementation(async () => {
        order.push('rm');
      });

      await ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' });

      expect(mockWorkspaceService.stopStepsSettled).toHaveBeenCalledWith('ws-1');
      expect(order).toEqual(['stop steps', 'rm']);
    });

    it('restarts the watcher when trash cleanup fails and the watcher was active', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'npm run cleanup',
      });
      mockExecFile.mockImplementation(
        (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
          callback(new Error('exit 1'), '', 'failed');
        }
      );
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      mockWorktreeWatcherService.isWatching.mockReturnValue(true);

      await expect(
        ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' })
      ).rejects.toThrow('Trash cleanup script failed');

      expect(mockWorktreeWatcherService.stopWatching).toHaveBeenCalledWith('ws-1');
      expect(mockWorktreeWatcherService.startWatching).toHaveBeenCalledWith('ws-1', '/tmp/repo');
    });

    it('does not restart the watcher when trash cleanup fails if the watcher was already stopped', async () => {
      const ipcMain = await setup();
      mockProjectService.get.mockReturnValue({
        id: 'proj-1',
        trashCleanupScript: 'npm run cleanup',
      });
      mockExecFile.mockImplementation(
        (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
          callback(new Error('exit 1'), '', 'failed');
        }
      );
      // Renderer trash flow stops the workspace (which stops the watcher) before
      // calling workspace:update, so the watcher can be stopped while status is
      // still 'active'. The handler must trust isWatching, not status.
      mockWorkspaceService.get.mockReturnValue({
        id: 'ws-1',
        projectId: 'proj-1',
        status: 'active',
        workingDirectory: '/tmp/repo',
        isWorktree: true,
      });
      mockWorktreeWatcherService.isWatching.mockReturnValue(false);

      await expect(
        ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' })
      ).rejects.toThrow('Trash cleanup script failed');

      expect(mockWorktreeWatcherService.stopWatching).not.toHaveBeenCalled();
      expect(mockWorktreeWatcherService.startWatching).not.toHaveBeenCalled();
    });
  });

  describe('workspace:start-ssh-preview-forward', () => {
    it('delegates SSH workspaces to sshPortForwardService', async () => {
      const ipcMain = await setup();
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-devbox',
        remoteDirectory: '/home/me/.komla/worktrees/repo/branch',
        remoteRepoPath: '/home/me/.komla/repos/repo.git',
        remoteProjectRoot: '/home/me/.komla/worktrees/repo',
      };
      const forward = {
        id: 'forward-1',
        workspaceId: 'ws-1',
        localUrl: 'http://127.0.0.1:53127',
        localPort: 53127,
        remotePort: 3000,
      };
      mockWorkspaceService.get.mockReturnValue({ id: 'ws-1', backend });
      mockSshPortForwardService.startPreviewForward.mockResolvedValue(forward);

      const result = await ipcMain._invoke(
        'workspace:start-ssh-preview-forward',
        'ws-1',
        'tab-1',
        3000,
        'http'
      );

      expect(mockSshPortForwardService.startPreviewForward).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        tabId: 'tab-1',
        backend,
        remotePort: 3000,
        scheme: 'http',
      });
      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
      expect(result).toEqual(forward);
    });

    it('rejects local workspaces', async () => {
      const ipcMain = await setup();
      mockWorkspaceService.get.mockReturnValue({ id: 'ws-1', backend: { kind: 'local' } });

      await expect(
        ipcMain._invoke('workspace:start-ssh-preview-forward', 'ws-1', 'tab-1', 3000, 'http')
      ).rejects.toThrow('SSH preview forwarding is only available for SSH workspaces');
      expect(mockSshPortForwardService.startPreviewForward).not.toHaveBeenCalled();
    });
  });

  describe('workspace:start-ssh-link-forward', () => {
    it('delegates SSH workspaces to sshPortForwardService', async () => {
      const ipcMain = await setup();
      const backend = {
        kind: 'ssh' as const,
        hostId: 'ssh-devbox',
        remoteDirectory: '/home/me/.komla/worktrees/repo/branch',
        remoteRepoPath: '/home/me/.komla/repos/repo.git',
        remoteProjectRoot: '/home/me/.komla/worktrees/repo',
      };
      const forward = {
        id: 'forward-1',
        workspaceId: 'ws-1',
        localUrl: 'http://127.0.0.1:3000',
        localPort: 3000,
        remotePort: 3000,
      };
      mockWorkspaceService.get.mockReturnValue({ id: 'ws-1', backend });
      mockSshPortForwardService.startLinkForward.mockResolvedValue(forward);

      const result = await ipcMain._invoke(
        'workspace:start-ssh-link-forward',
        'ws-1',
        3000,
        'http'
      );

      expect(mockSshPortForwardService.startLinkForward).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        backend,
        remotePort: 3000,
        scheme: 'http',
      });
      expect(result).toEqual(forward);
    });

    it('rejects local workspaces', async () => {
      const ipcMain = await setup();
      mockWorkspaceService.get.mockReturnValue({ id: 'ws-1', backend: { kind: 'local' } });

      await expect(
        ipcMain._invoke('workspace:start-ssh-link-forward', 'ws-1', 3000, 'http')
      ).rejects.toThrow('SSH preview forwarding is only available for SSH workspaces');
      expect(mockSshPortForwardService.startLinkForward).not.toHaveBeenCalled();
    });
  });

  describe('workspace:restart', () => {
    it('delegates to workspaceService.restartWithCleanup', async () => {
      const ipcMain = await setup();
      const terminal = { id: 'term-1', name: 'Shell' };
      mockWorkspaceService.restartWithCleanup.mockResolvedValue(terminal);

      const result = await ipcMain._invoke('workspace:restart', 'ws-1');

      expect(mockWorkspaceService.restartWithCleanup).toHaveBeenCalledWith('ws-1');
      expect(result).toEqual(terminal);
    });

    it('returns workspace limit error as value instead of throwing', async () => {
      const ipcMain = await setup();
      const errorMsg = `${WORKSPACE_LIMIT_ERROR_PREFIX}Free plan is limited to 4 running workspaces.`;
      mockWorkspaceService.restartWithCleanup.mockRejectedValue(new Error(errorMsg));

      const result = await ipcMain._invoke('workspace:restart', 'ws-1');

      expect(result).toEqual({ __workspaceRestartError: true, message: errorMsg });
    });

    it('rethrows unexpected errors', async () => {
      const ipcMain = await setup();
      mockWorkspaceService.restartWithCleanup.mockRejectedValue(new Error('pty spawn failed'));

      await expect(ipcMain._invoke('workspace:restart', 'ws-1')).rejects.toThrow(
        'pty spawn failed'
      );
    });
  });

  describe('workspace:add-terminal', () => {
    it('delegates to workspaceService.addTerminalWithPreparation', async () => {
      const ipcMain = await setup();
      const terminal = { id: 'term-1' };
      mockWorkspaceService.addTerminalWithPreparation.mockResolvedValue(terminal);

      const result = await ipcMain._invoke(
        'workspace:add-terminal',
        'ws-1',
        'Shell',
        undefined,
        undefined,
        undefined,
        undefined
      );

      expect(mockWorkspaceService.addTerminalWithPreparation).toHaveBeenCalledWith(
        'ws-1',
        'Shell',
        undefined,
        undefined,
        undefined,
        undefined
      );
      expect(result).toEqual(terminal);
    });
  });

  describe('workspace:restart-terminal', () => {
    it('delegates to workspaceService.restartTerminal', async () => {
      const ipcMain = await setup();
      const terminal = { id: 'term-1', status: 'starting' };
      mockWorkspaceService.restartTerminal.mockReturnValue(terminal);

      const result = await ipcMain._invoke(
        'workspace:restart-terminal',
        'term-1',
        'preset-1',
        'plan',
        120,
        30,
        { plainShell: false }
      );

      expect(mockWorkspaceService.restartTerminal).toHaveBeenCalledWith(
        'term-1',
        'preset-1',
        'plan',
        120,
        30,
        { plainShell: false, sshAction: undefined }
      );
      expect(result).toEqual(terminal);
    });

    it('accepts a restart with the dimensions omitted', async () => {
      const ipcMain = await setup();
      const terminal = { id: 'term-1', status: 'starting' };
      mockWorkspaceService.restartTerminal.mockReturnValue(terminal);

      const result = await ipcMain._invoke(
        'workspace:restart-terminal',
        'term-1',
        'preset-1',
        'plan'
      );

      expect(mockWorkspaceService.restartTerminal).toHaveBeenCalledWith(
        'term-1',
        'preset-1',
        'plan',
        undefined,
        undefined
      );
      expect(result).toEqual(terminal);
    });

    it('accepts a restart with only the preset provided', async () => {
      const ipcMain = await setup();
      const terminal = { id: 'term-1', status: 'starting' };
      mockWorkspaceService.restartTerminal.mockReturnValue(terminal);

      const result = await ipcMain._invoke('workspace:restart-terminal', 'term-1', 'preset-1');

      expect(mockWorkspaceService.restartTerminal).toHaveBeenCalledWith(
        'term-1',
        'preset-1',
        undefined,
        undefined,
        undefined
      );
      expect(result).toEqual(terminal);
    });

    it('accepts a restart with only the column dimension provided', async () => {
      const ipcMain = await setup();
      const terminal = { id: 'term-1', status: 'starting' };
      mockWorkspaceService.restartTerminal.mockReturnValue(terminal);

      const result = await ipcMain._invoke(
        'workspace:restart-terminal',
        'term-1',
        'preset-1',
        'plan',
        120
      );

      expect(mockWorkspaceService.restartTerminal).toHaveBeenCalledWith(
        'term-1',
        'preset-1',
        'plan',
        120,
        undefined
      );
      expect(result).toEqual(terminal);
    });

    it('accepts a restart with explicitly undefined dimensions', async () => {
      const ipcMain = await setup();
      const terminal = { id: 'term-1', status: 'starting' };
      mockWorkspaceService.restartTerminal.mockReturnValue(terminal);

      await ipcMain._invoke(
        'workspace:restart-terminal',
        'term-1',
        'preset-1',
        'plan',
        undefined,
        undefined
      );

      expect(mockWorkspaceService.restartTerminal).toHaveBeenCalledWith(
        'term-1',
        'preset-1',
        'plan',
        undefined,
        undefined
      );
    });

    it('delegates a plain-shell restart request', async () => {
      const ipcMain = await setup();
      const terminal = { id: 'term-1', status: 'starting' };
      mockWorkspaceService.restartTerminal.mockReturnValue(terminal);

      await ipcMain._invoke('workspace:restart-terminal', 'term-1', undefined, undefined, 120, 30, {
        plainShell: true,
      });

      expect(mockWorkspaceService.restartTerminal).toHaveBeenCalledWith(
        'term-1',
        undefined,
        undefined,
        120,
        30,
        { plainShell: true, sshAction: undefined }
      );
    });

    it('delegates an explicit remote session replacement', async () => {
      const ipcMain = await setup();
      mockWorkspaceService.restartTerminal.mockReturnValue({ id: 'term-1' });

      await ipcMain._invoke('workspace:restart-terminal', 'term-1', 'preset-1', 'plan', 120, 30, {
        plainShell: false,
        replaceSession: true,
      });

      expect(mockWorkspaceService.restartTerminal).toHaveBeenCalledWith(
        'term-1',
        'preset-1',
        'plan',
        120,
        30,
        { plainShell: false, sshAction: 'replace' }
      );
    });

    it('delegates a Local copy conversion request', async () => {
      const ipcMain = await setup();
      mockWorkspaceService.restartTerminal.mockReturnValue({ id: 'term-1' });

      await ipcMain._invoke('workspace:restart-terminal', 'term-1', undefined, undefined, 120, 30, {
        executionLocation: 'local-mirror',
      });

      expect(mockWorkspaceService.restartTerminal).toHaveBeenCalledWith(
        'term-1',
        undefined,
        undefined,
        120,
        30,
        { executionLocation: 'local-mirror', sshAction: undefined }
      );
    });

    it('rejects an unknown restart execution location', async () => {
      const ipcMain = await setup();

      await expect(
        ipcMain._invoke('workspace:restart-terminal', 'term-1', undefined, undefined, 120, 30, {
          executionLocation: 'remote',
        })
      ).rejects.toThrow();
      expect(mockWorkspaceService.restartTerminal).not.toHaveBeenCalled();
    });

    it('delegates an explicit command replacement to workspaceService', async () => {
      const ipcMain = await setup();
      const terminal = { id: 'term-1', status: 'starting' };
      mockWorkspaceService.restartTerminal.mockReturnValue(terminal);
      const options = {
        command: 'npm run dev',
        commandKind: 'host',
        replaceSession: true,
      };

      await ipcMain._invoke(
        'workspace:restart-terminal',
        'term-1',
        undefined,
        undefined,
        120,
        30,
        options
      );

      expect(mockWorkspaceService.restartTerminal).toHaveBeenCalledWith(
        'term-1',
        undefined,
        undefined,
        120,
        30,
        {
          command: 'npm run dev',
          commandKind: 'host',
          sshAction: 'replace',
        }
      );
    });
  });
});
