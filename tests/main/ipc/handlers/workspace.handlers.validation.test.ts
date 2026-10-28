import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mockWorkspaceService = {
  create: vi.fn(),
  addTerminal: vi.fn(),
  addAgentTab: vi.fn(),
  removeTerminal: vi.fn(),
  stop: vi.fn(),
  stopStepsSettled: vi.fn(),
  stopTerminal: vi.fn(),
  restartTerminal: vi.fn(),
  reconnectSshTerminal: vi.fn(),
  recoverSshSessions: vi.fn(),
  sshSync: { removeMissing: vi.fn() },
  retryLocalMirrorSync: vi.fn(),
  retrySetupStep: vi.fn(),
  dismissSetupActivity: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(() => []),
  get: vi.fn(),
  update: vi.fn(),
  updateTerminal: vi.fn(),
  restart: vi.fn(),
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
  sshWorkspaceService: {
    runTrashCleanup: vi.fn(),
  },
}));

vi.mock('../../../../src/main/services/local-mirror.service', () => ({
  localMirrorService: { remove: vi.fn() },
}));

vi.mock('../../../../src/main/services/config.service', () => ({
  configService: {
    get: vi.fn(() => ({})),
    update: vi.fn(),
  },
}));

vi.mock('../../../../src/main/services/project.service', () => ({
  projectService: {
    get: vi.fn(),
  },
}));

describe('workspace IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('preserves the source workspace ID for SSH workspace creation', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();
    await ipcMain._invoke('workspace:create', {
      mode: 'worktree',
      projectId: 'project-1',
      sourceWorkspaceId: 'ssh-source',
      environment: { kind: 'ssh', hostId: 'ssh-dev' },
    });

    expect(mockWorkspaceService.create).toHaveBeenCalledWith(
      expect.objectContaining({ sourceWorkspaceId: 'ssh-source' })
    );
  });

  it('passes prompt attachments through workspace creation', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();
    await ipcMain._invoke('workspace:create', {
      mode: 'worktree',
      projectId: 'project-1',
      attachments: ['/tmp/shot.png', '/tmp/notes '],
    });

    // A trailing space is part of the file's name, so it isn't trimmed off.
    expect(mockWorkspaceService.create).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: ['/tmp/shot.png', '/tmp/notes '] })
    );
  });

  it.each([
    ['a path with a null byte', ['/tmp/shot\0.png']],
    ['an empty path', ['  ']],
    ['more files than a prompt carries', Array.from({ length: 21 }, (_, i) => `/tmp/${i}.png`)],
  ])('rejects prompt attachments with %s', async (_case, attachments) => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(
      ipcMain._invoke('workspace:create', { mode: 'worktree', projectId: 'project-1', attachments })
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockWorkspaceService.create).not.toHaveBeenCalled();
  });

  it('rejects invalid workspace ID input', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(ipcMain._invoke('workspace:stop', 123)).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockWorkspaceService.stop).not.toHaveBeenCalled();
  });

  it('passes the option to keep the workspace agent to an agent tab', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();
    await ipcMain._invoke('workspace:add-agent-tab', 'ws-1', 'prompt', undefined, 'preset-1', {
      keepWorkspaceAgent: true,
    });

    expect(mockWorkspaceService.addAgentTab).toHaveBeenCalledWith(
      'ws-1',
      'prompt',
      undefined,
      'preset-1',
      { keepWorkspaceAgent: true }
    );
  });

  it('rejects invalid agent tab options', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    for (const options of [{ keepWorkspaceAgent: 'yes' }, { keepWorkspaceAgent: true, extra: 1 }]) {
      await expect(
        ipcMain._invoke(
          'workspace:add-agent-tab',
          'ws-1',
          'prompt',
          undefined,
          'preset-1',
          undefined,
          options
        )
      ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    }
    expect(mockWorkspaceService.addAgentTab).not.toHaveBeenCalled();
  });

  it('rejects invalid restart terminal ID input', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(ipcMain._invoke('workspace:restart-terminal', '')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockWorkspaceService.restartTerminal).not.toHaveBeenCalled();
  });

  it('rejects an invalid restart terminal command kind', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(
      ipcMain._invoke('workspace:restart-terminal', 'term-1', undefined, undefined, 120, 30, {
        command: 'npm run dev',
        commandKind: 'invalid',
      })
    ).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockWorkspaceService.restartTerminal).not.toHaveBeenCalled();
  });

  it('rejects an invalid command session replacement flag', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(
      ipcMain._invoke('workspace:restart-terminal', 'term-1', undefined, undefined, 120, 30, {
        command: 'npm run dev',
        commandKind: 'host',
        replaceSession: 'yes',
      })
    ).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockWorkspaceService.restartTerminal).not.toHaveBeenCalled();
  });

  it('moves a terminal back to the SSH host, but to no other execution location', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(
      ipcMain._invoke('workspace:restart-terminal', 'term-1', undefined, undefined, 120, 30, {
        plainShell: true,
        replaceSession: true,
        executionLocation: 'elsewhere',
      })
    ).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockWorkspaceService.restartTerminal).not.toHaveBeenCalled();

    await ipcMain._invoke('workspace:restart-terminal', 'term-1', undefined, undefined, 120, 30, {
      plainShell: true,
      replaceSession: true,
      executionLocation: 'workspace',
    });
    expect(mockWorkspaceService.restartTerminal).toHaveBeenCalledWith(
      'term-1',
      undefined,
      undefined,
      120,
      30,
      { plainShell: true, executionLocation: 'workspace', sshAction: 'replace' }
    );
  });

  it('rejects invalid reconnect SSH terminal dimensions', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(
      ipcMain._invoke('workspace:reconnect-ssh-terminal', 'term-1', 0, 30)
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockWorkspaceService.reconnectSshTerminal).not.toHaveBeenCalled();
  });

  it('rejects an invalid SSH session recovery workspace ID', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(ipcMain._invoke('workspace:recover-ssh-sessions', '')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockWorkspaceService.recoverSshSessions).not.toHaveBeenCalled();
  });

  it('rejects an invalid workspace ID when removing one missing from its host', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerWorkspaceHandlers();

    await expect(ipcMain._invoke('workspace:remove-missing-ssh', '')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockWorkspaceService.sshSync.removeMissing).not.toHaveBeenCalled();
  });

  it('rejects invalid Setup activity identifiers', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerWorkspaceHandlers();

    await expect(ipcMain._invoke('workspace:retry-setup-step', 'ws-1', '')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    await expect(
      ipcMain._invoke('workspace:dismiss-setup-activity', '', 'activity-1')
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockWorkspaceService.retrySetupStep).not.toHaveBeenCalled();
    expect(mockWorkspaceService.dismissSetupActivity).not.toHaveBeenCalled();
  });

  it('rejects an invalid local mirror retry workspace ID', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerWorkspaceHandlers();

    await expect(ipcMain._invoke('workspace:retry-local-mirror-sync', '')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockWorkspaceService.retryLocalMirrorSync).not.toHaveBeenCalled();
  });

  it('rejects an invalid plain-shell restart option', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(
      ipcMain._invoke('workspace:restart-terminal', 'term-1', undefined, undefined, 120, 30, 'yes')
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockWorkspaceService.restartTerminal).not.toHaveBeenCalled();
  });

  it('rejects invalid SSH preview forward port input', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(
      ipcMain._invoke('workspace:start-ssh-preview-forward', 'ws-1', 'tab-1', 70000, 'http')
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockSshPortForwardService.startPreviewForward).not.toHaveBeenCalled();
  });

  it('rejects invalid SSH link forward input', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(
      ipcMain._invoke('workspace:start-ssh-link-forward', 'ws-1', 70000, 'http')
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    await expect(
      ipcMain._invoke('workspace:start-ssh-link-forward', 'ws-1', 3000, 'ftp')
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    await expect(ipcMain._invoke('workspace:stop-ssh-link-forward', 'ws-1')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockSshPortForwardService.startLinkForward).not.toHaveBeenCalled();
    expect(mockSshPortForwardService.stopLinkForward).not.toHaveBeenCalled();
  });

  it('rejects SSH preview forward requests without their browser tab', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(
      ipcMain._invoke('workspace:start-ssh-preview-forward', 'ws-1', 3000, 'http')
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    await expect(
      ipcMain._invoke('workspace:stop-ssh-preview-forward', 'ws-1')
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockSshPortForwardService.startPreviewForward).not.toHaveBeenCalled();
    expect(mockSshPortForwardService.stopPreviewForward).not.toHaveBeenCalled();
  });
  it('stops watcher when workspace transitions to trashed', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    mockWorkspaceService.get.mockReturnValue({ id: 'ws-1', status: 'active' });
    mockWorkspaceService.update.mockReturnValue({
      id: 'ws-1',
      status: 'trashed',
      workingDirectory: '/tmp/repo',
    });

    registerWorkspaceHandlers();

    await ipcMain._invoke('workspace:update', 'ws-1', { status: 'trashed' });

    expect(mockWorktreeWatcherService.stopWatching).toHaveBeenCalledWith('ws-1');
    expect(mockWorktreeWatcherService.startWatching).not.toHaveBeenCalled();
  });

  it('starts watcher when workspace transitions from trashed to active', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    mockWorkspaceService.get.mockReturnValue({
      id: 'ws-1',
      status: 'trashed',
    });
    mockWorkspaceService.update.mockReturnValue({
      id: 'ws-1',
      status: 'active',
      workingDirectory: '/tmp/repo',
    });

    registerWorkspaceHandlers();

    await ipcMain._invoke('workspace:update', 'ws-1', { status: 'active' });

    expect(mockWorktreeWatcherService.startWatching).toHaveBeenCalledWith('ws-1', '/tmp/repo');
    expect(mockWorktreeWatcherService.stopWatching).not.toHaveBeenCalled();
  });

  it('accepts valid HSL color in workspace update', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    mockWorkspaceService.get.mockReturnValue({ id: 'ws-1', status: 'active' });
    mockWorkspaceService.update.mockReturnValue({ id: 'ws-1', color: 'hsl(200, 75%, 50%)' });

    registerWorkspaceHandlers();

    await ipcMain._invoke('workspace:update', 'ws-1', { color: 'hsl(200, 75%, 50%)' });

    expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', {
      color: 'hsl(200, 75%, 50%)',
    });
  });

  it('accepts null color to clear workspace color', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    mockWorkspaceService.get.mockReturnValue({
      id: 'ws-1',
      status: 'active',
      color: 'hsl(200, 75%, 50%)',
    });
    mockWorkspaceService.update.mockReturnValue({ id: 'ws-1', color: null });

    registerWorkspaceHandlers();

    await ipcMain._invoke('workspace:update', 'ws-1', { color: null });

    expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', { color: null });
  });

  it('rejects the stashed status, which was folded into trashed', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(
      ipcMain._invoke('workspace:update', 'ws-1', { status: 'stashed' })
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockWorkspaceService.update).not.toHaveBeenCalled();
  });

  it('rejects invalid color format in workspace update', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(
      ipcMain._invoke('workspace:update', 'ws-1', { color: 'red' })
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockWorkspaceService.update).not.toHaveBeenCalled();
  });

  it('rejects script injection in color field', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerWorkspaceHandlers();

    await expect(
      ipcMain._invoke('workspace:update', 'ws-1', { color: '<script>alert(1)</script>' })
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockWorkspaceService.update).not.toHaveBeenCalled();
  });

  it('passes a default action id through workspace create and update', async () => {
    const { registerWorkspaceHandlers } =
      await import('../../../../src/main/ipc/handlers/workspace.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    mockWorkspaceService.get.mockReturnValue({ id: 'ws-1', status: 'active' });
    mockWorkspaceService.update.mockReturnValue({ id: 'ws-1', defaultActionId: 'action-1' });

    registerWorkspaceHandlers();

    await ipcMain._invoke('workspace:create', {
      mode: 'directory',
      directoryPath: '/tmp/dir',
      defaultActionId: 'action-1',
    });
    await ipcMain._invoke('workspace:update', 'ws-1', { defaultActionId: 'action-1' });
    await ipcMain._invoke('workspace:update', 'ws-1', { paneDefaultActionId: 'action-2' });

    expect(mockWorkspaceService.create).toHaveBeenCalledWith(
      expect.objectContaining({ defaultActionId: 'action-1' })
    );
    expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', {
      defaultActionId: 'action-1',
    });
    expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', {
      paneDefaultActionId: 'action-2',
    });
  });

  it.each(['', '   ', 'a'.repeat(257), 42, null])(
    'rejects %j as a default action id',
    async (defaultActionId) => {
      const { registerWorkspaceHandlers } =
        await import('../../../../src/main/ipc/handlers/workspace.handlers');
      const { ipcMain } = (await import('electron')) as unknown as {
        ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      };

      registerWorkspaceHandlers();

      await expect(
        ipcMain._invoke('workspace:update', 'ws-1', { defaultActionId })
      ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
      await expect(
        ipcMain._invoke('workspace:update', 'ws-1', { paneDefaultActionId: defaultActionId })
      ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
      await expect(
        ipcMain._invoke('workspace:create', {
          mode: 'directory',
          directoryPath: '/tmp/dir',
          defaultActionId,
        })
      ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
      expect(mockWorkspaceService.create).not.toHaveBeenCalled();
    }
  );

  describe('browserPanes', () => {
    const loadHandlers = async (): Promise<{
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }> => {
      const { registerWorkspaceHandlers } =
        await import('../../../../src/main/ipc/handlers/workspace.handlers');
      registerWorkspaceHandlers();
      return (await import('electron')) as unknown as {
        ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      };
    };

    it('accepts local and remote http(s) pages and empty new tabs', async () => {
      mockWorkspaceService.get.mockReturnValue({ id: 'ws-1', status: 'active' });
      mockWorkspaceService.update.mockReturnValue({ id: 'ws-1' });
      const { ipcMain } = await loadHandlers();
      const updates = {
        browserPanes: [
          {
            browserTabs: [
              { id: 'a', url: 'http://localhost:5173', urlExecutionLocation: 'local-mirror' },
              { id: 'b', url: 'https://example.com/docs', title: 'Docs' },
              { id: 'c', url: '' },
            ],
            activeBrowserTabId: 'b',
          },
        ],
      };

      await ipcMain._invoke('workspace:update', 'ws-1', updates);

      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', updates);
    });

    it.each(['javascript:alert(1)', 'file:///etc/passwd', 'localhost:3000'])(
      'rejects %s',
      async (url) => {
        const { ipcMain } = await loadHandlers();

        await expect(
          ipcMain._invoke('workspace:update', 'ws-1', {
            browserPanes: [{ browserTabs: [{ id: 'a', url }] }],
          })
        ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
        expect(mockWorkspaceService.update).not.toHaveBeenCalled();
      }
    );

    it('accepts browser panes of web pages, and rejects other pages or too many panes', async () => {
      mockWorkspaceService.get.mockReturnValue({ id: 'ws-1', status: 'active' });
      mockWorkspaceService.update.mockReturnValue({ id: 'ws-1' });
      const { ipcMain } = await loadHandlers();
      const pane = (url: string) => ({ browserTabs: [{ id: 'a', url }], activeBrowserTabId: 'a' });

      await ipcMain._invoke('workspace:update', 'ws-1', {
        browserPanes: [pane('http://localhost:5173'), pane('')],
      });
      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', {
        browserPanes: [pane('http://localhost:5173'), pane('')],
      });
      mockWorkspaceService.update.mockClear();

      for (const browserPanes of [
        [pane('javascript:alert(1)')],
        [{ ...pane('https://example.com/'), extra: true }],
        Array.from({ length: 13 }, () => pane('')),
      ]) {
        await expect(
          ipcMain._invoke('workspace:update', 'ws-1', { browserPanes })
        ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
      }
      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
    });

    it('rejects more tabs than a browser can hold', async () => {
      const { ipcMain } = await loadHandlers();
      const browserTabs = Array.from({ length: 31 }, (_, index) => ({ id: `t${index}`, url: '' }));

      await expect(
        ipcMain._invoke('workspace:update', 'ws-1', { browserPanes: [{ browserTabs }] })
      ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
    });

    it("drops the removed browser panel's tabs", async () => {
      mockWorkspaceService.get.mockReturnValue({ id: 'ws-1', status: 'active' });
      mockWorkspaceService.update.mockReturnValue({ id: 'ws-1' });
      const { ipcMain } = await loadHandlers();

      await ipcMain._invoke('workspace:update', 'ws-1', {
        browserTabs: [{ id: 'a', url: '' }],
        activeBrowserTabId: 'a',
      });

      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', {});
    });
  });

  describe('recentLinks', () => {
    const loadHandlers = async (): Promise<{
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }> => {
      const { registerWorkspaceHandlers } =
        await import('../../../../src/main/ipc/handlers/workspace.handlers');
      registerWorkspaceHandlers();
      return (await import('electron')) as unknown as {
        ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      };
    };

    it('accepts printed and opened links', async () => {
      mockWorkspaceService.get.mockReturnValue({ id: 'ws-1', status: 'active' });
      mockWorkspaceService.update.mockReturnValue({ id: 'ws-1' });
      const { ipcMain } = await loadHandlers();
      const updates = {
        recentLinks: [
          { url: 'https://github.com/acme/app/pull/1', openedAt: 1_700_000_000_000 },
          { url: 'https://example.com/docs' },
        ],
      };

      await ipcMain._invoke('workspace:update', 'ws-1', updates);

      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', updates);
    });

    it.each(['javascript:alert(1)', 'file:///etc/passwd', ''])('rejects %s', async (url) => {
      const { ipcMain } = await loadHandlers();

      await expect(
        ipcMain._invoke('workspace:update', 'ws-1', { recentLinks: [{ url }] })
      ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
    });

    it('rejects more links than a workspace keeps', async () => {
      const { ipcMain } = await loadHandlers();
      const recentLinks = Array.from({ length: 51 }, (_, i) => ({ url: `https://x.example/${i}` }));

      await expect(
        ipcMain._invoke('workspace:update', 'ws-1', { recentLinks })
      ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
    });
  });
});
