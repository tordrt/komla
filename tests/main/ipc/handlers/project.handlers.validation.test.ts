import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mockProjectService = {
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  update: vi.fn(async (_id: string, updates: Record<string, unknown>) => ({
    id: 'p1',
    ...updates,
  })),
  setSshWorkspaceModeIfUnset: vi.fn(),
  delete: vi.fn(),
  validateRepository: vi.fn(),
  findForFolder: vi.fn(),
  hasProjects: vi.fn(),
  getSettingsPath: vi.fn(),
  createFromRemote: vi.fn(),
  createFromNew: vi.fn(),
  clearPresetReferences: vi.fn(),
  clearLaunchModeReferences: vi.fn(),
};

const mockWorkspaceService = {
  propagateProjectBaseBranch: vi.fn(),
  assignSshWorkspaceProjects: vi.fn().mockResolvedValue(undefined),
};

const mockAgentPresetService = {
  list: vi.fn(),
  get: vi.fn(),
  getActive: vi.fn(),
  setActive: vi.fn(),
  create: vi.fn(),
  createActive: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  reorder: vi.fn(),
  getSettingsPath: vi.fn(),
  resolveCommand: vi.fn(),
  getPresetForWorkspace: vi.fn(),
  getActivePresets: vi.fn(),
  addActivePreset: vi.fn(),
  removeActivePreset: vi.fn(),
};

vi.mock('../../../../src/main/services/project.service', () => ({
  projectService: mockProjectService,
}));

const mockRecordOpenedFolder = vi.fn();
vi.mock('../../../../src/main/services/recent-folders.service', () => ({
  recordOpenedFolder: mockRecordOpenedFolder,
  refreshRecentFolders: vi.fn(),
}));
vi.mock('../../../../src/main/services/dev-preview.service', () => ({
  devPreviewService: { clearProjectData: vi.fn(async () => undefined) },
}));

vi.mock('../../../../src/main/services/workspace.service', () => ({
  workspaceService: mockWorkspaceService,
}));

vi.mock('../../../../src/main/services/workspace-file.service', () => ({
  workspaceFileService: {},
}));

vi.mock('../../../../src/main/services/agent-preset.service', () => ({
  agentPresetService: mockAgentPresetService,
}));

vi.mock('../../../../src/main/services/agent-detection.service', () => ({
  detectInstalledAgents: vi.fn(),
}));

vi.mock('../../../../src/main/services/action.service', () => ({
  actionService: {
    clearPresetReferences: vi.fn(),
    clearLaunchModeReferences: vi.fn(),
  },
}));

const mockSshProjectSync = {
  listOnHost: vi.fn(async () => []),
  importFromHost: vi.fn(async () => []),
};
vi.mock('../../../../src/main/services/ssh-project-sync.service', () => ({
  sshProjectSync: mockSshProjectSync,
}));

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe('project IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('project:create strips unknown keys from params', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await ipcMain._invoke('project:create', {
      repositoryPath: '/tmp/repo',
      color: '#ff0000',
      injected: 'malicious',
    });

    expect(mockProjectService.create).toHaveBeenCalledWith({
      repositoryPath: '/tmp/repo',
      color: '#ff0000',
    });
  });

  it('project:import-from-ssh-host takes manifest ids and known parts only', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();
    const manifestId = '0123456789abcdef0123456789abcdef';

    await ipcMain._invoke('project:import-from-ssh-host', 'host-1', [
      { manifestId, parts: ['appearance', 'quickCommands'], keepInSync: true, injected: true },
    ]);
    expect(mockSshProjectSync.importFromHost).toHaveBeenCalledWith('host-1', [
      { manifestId, parts: ['appearance', 'quickCommands'], keepInSync: true },
    ]);

    for (const imports of [
      [],
      [{ manifestId: '../../etc/passwd', parts: [] }],
      [{ manifestId, parts: ['everything'] }],
      [{ manifestId, parts: [], keepInSync: 'yes' }],
    ]) {
      await expect(
        ipcMain._invoke('project:import-from-ssh-host', 'host-1', imports)
      ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    }
    await expect(ipcMain._invoke('project:list-on-ssh-host', '')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockSshProjectSync.importFromHost).toHaveBeenCalledTimes(1);
    expect(mockSshProjectSync.listOnHost).not.toHaveBeenCalled();
  });

  it('project:get rejects empty id', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await expect(ipcMain._invoke('project:get', '')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockProjectService.get).not.toHaveBeenCalled();
  });

  it('project:update strips unknown keys from updates', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await ipcMain._invoke('project:update', 'p1', {
      name: 'Updated',
      baseBranch: 'develop',
      injected: 'malicious',
    });

    expect(mockProjectService.update).toHaveBeenCalledWith('p1', {
      name: 'Updated',
      baseBranch: 'develop',
    });
  });

  it('project:update takes an image data URL or empty as the icon, nothing else', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    await ipcMain._invoke('project:update', 'p1', { icon });
    await ipcMain._invoke('project:update', 'p1', { icon: '' });
    expect(mockProjectService.update).toHaveBeenNthCalledWith(1, 'p1', { icon });
    expect(mockProjectService.update).toHaveBeenNthCalledWith(2, 'p1', { icon: '' });

    for (const invalid of [
      'https://example.com/favicon.ico',
      'data:text/html;base64,PHNjcmlwdD4=',
      `data:image/png;base64,${'A'.repeat(70_000)}`,
    ]) {
      await expect(
        ipcMain._invoke('project:update', 'p1', { icon: invalid })
      ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    }
    expect(mockProjectService.update).toHaveBeenCalledTimes(2);
  });

  it('project:create-from-remote takes only an image data URL as the icon', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    const remoteUrl = 'https://github.com/org/repo.git';
    const icon = 'data:image/svg+xml;base64,PHN2Zy8+';
    await ipcMain._invoke('project:create-from-remote', { remoteUrl, icon });
    expect(mockProjectService.createFromRemote).toHaveBeenCalledWith(
      { remoteUrl, icon },
      expect.any(Function)
    );
    await expect(
      ipcMain._invoke('project:create-from-remote', { remoteUrl, icon: 'file:///etc/passwd' })
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
  });

  it('project:find-icons takes a folder or a project, not both', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    for (const invalid of [{}, { folder: '' }, { folder: '/repo', projectId: 'p1' }]) {
      await expect(ipcMain._invoke('project:find-icons', invalid)).rejects.toMatchObject({
        code: 'IPC_VALIDATION_ERROR',
      });
    }
  });

  it('project:choose-icon-file takes no arguments', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await expect(ipcMain._invoke('project:choose-icon-file', '/etc/passwd')).rejects.toMatchObject(
      { code: 'IPC_VALIDATION_ERROR' }
    );
  });

  it('project:update accepts unconfigured aheadTargetAction', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await ipcMain._invoke('project:update', 'p1', {
      aheadTargetAction: 'unconfigured',
    });

    expect(mockProjectService.update).toHaveBeenCalledWith('p1', {
      aheadTargetAction: 'unconfigured',
    });
  });

  it('project:set-ssh-workspace-mode-if-unset rejects an invalid mode', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await expect(
      ipcMain._invoke('project:set-ssh-workspace-mode-if-unset', 'p1', 'somewhere-else')
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    expect(mockProjectService.setSshWorkspaceModeIfUnset).not.toHaveBeenCalled();
  });

  it.each(['/tmp/repo\0evil', '', 42])(
    'project:find-for-folder rejects %j without looking anything up',
    async (path) => {
      const { registerProjectHandlers } =
        await import('../../../../src/main/ipc/handlers/project.handlers');
      const { ipcMain } = (await import('electron')) as unknown as {
        ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      };

      registerProjectHandlers();

      await expect(ipcMain._invoke('project:find-for-folder', path)).rejects.toMatchObject({
        code: 'IPC_VALIDATION_ERROR',
      });
      expect(mockProjectService.findForFolder).not.toHaveBeenCalled();
    }
  );

  it('project:validate-repo rejects path with null bytes', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await expect(ipcMain._invoke('project:validate-repo', '/tmp/repo\0evil')).rejects.toMatchObject(
      {
        code: 'IPC_VALIDATION_ERROR',
      }
    );
    expect(mockProjectService.validateRepository).not.toHaveBeenCalled();
  });

  it('project:folder-opened records the folder and rejects one that is not a path', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await ipcMain._invoke('project:folder-opened', ' /notes ');
    expect(mockRecordOpenedFolder).toHaveBeenCalledWith('/notes');
    for (const invalid of ['/notes\0evil', '', 42]) {
      await expect(ipcMain._invoke('project:folder-opened', invalid)).rejects.toMatchObject({
        code: 'IPC_VALIDATION_ERROR',
      });
    }
    expect(mockRecordOpenedFolder).toHaveBeenCalledOnce();
  });

  it('project:create-from-remote strips unknown keys', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await ipcMain._invoke('project:create-from-remote', {
      remoteUrl: 'https://github.com/test/repo.git',
      color: '#00ff00',
      injected: 'malicious',
    });

    expect(mockProjectService.createFromRemote).toHaveBeenCalledWith(
      { remoteUrl: 'https://github.com/test/repo.git', color: '#00ff00' },
      expect.any(Function)
    );
  });

  it('project:create-from-new strips unknown keys', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await ipcMain._invoke('project:create-from-new', {
      name: 'New Project',
      color: '#0000ff',
      injected: 'malicious',
    });

    expect(mockProjectService.createFromNew).toHaveBeenCalledWith({
      name: 'New Project',
      color: '#0000ff',
    });
  });

  it('project:create-from-new accepts unconfigured aheadTargetAction', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await ipcMain._invoke('project:create-from-new', {
      name: 'New Project',
      aheadTargetAction: 'unconfigured',
    });

    expect(mockProjectService.createFromNew).toHaveBeenCalledWith({
      name: 'New Project',
      aheadTargetAction: 'unconfigured',
    });
  });

  it('preset:create strips unknown keys', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await ipcMain._invoke('preset:create', {
      name: 'Custom',
      openCommand: 'claude',
      continueCommand: 'claude --continue',
      promptCommand: 'claude {{prompt}}',
      launchModes: [
        { id: 'plan', name: 'Plan', arguments: '--permission-mode plan', injected: 'remove-me' },
      ],
      isBuiltin: false,
      injected: 'malicious',
    });

    expect(mockAgentPresetService.create).toHaveBeenCalledWith({
      name: 'Custom',
      openCommand: 'claude',
      continueCommand: 'claude --continue',
      promptCommand: 'claude {{prompt}}',
      launchModes: [{ id: 'plan', name: 'Plan', arguments: '--permission-mode plan' }],
      isBuiltin: false,
    });
  });

  it('preset:create-active strips unknown keys from each preset', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    const preset = {
      name: 'Codex',
      openCommand: 'codex',
      continueCommand: 'codex resume --last',
      promptCommand: 'codex {{prompt}}',
      launchModes: [],
      isBuiltin: false,
    };

    registerProjectHandlers();

    await ipcMain._invoke('preset:create-active', [{ ...preset, injected: 'malicious' }]);

    expect(mockAgentPresetService.createActive).toHaveBeenCalledWith([preset]);
  });

  it('preset:create-active rejects an empty list', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await expect(ipcMain._invoke('preset:create-active', [])).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockAgentPresetService.createActive).not.toHaveBeenCalled();
  });

  it('preset:update strips unknown keys from updates', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await ipcMain._invoke('preset:update', 'pr1', {
      name: 'Updated',
      injected: 'malicious',
    });

    expect(mockAgentPresetService.update).toHaveBeenCalledWith('pr1', {
      name: 'Updated',
    });
  });

  it('preset:build-prompt-command accepts prompt with presetId', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    mockAgentPresetService.get.mockReturnValue(undefined);

    const result = await ipcMain._invoke('preset:build-prompt-command', 'hello', 'preset-1');

    expect(mockAgentPresetService.get).toHaveBeenCalledWith('preset-1');
    expect(result).toBeNull();
  });

  it('preset:build-prompt-command accepts undefined presetId (falls back to active)', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    mockAgentPresetService.getPresetForWorkspace.mockReturnValue(undefined);

    const result = await ipcMain._invoke('preset:build-prompt-command', 'hello', undefined);

    expect(mockAgentPresetService.getPresetForWorkspace).toHaveBeenCalledWith(undefined);
    expect(result).toBeNull();
  });

  it('preset:delete rejects empty id', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await expect(ipcMain._invoke('preset:delete', '')).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockAgentPresetService.delete).not.toHaveBeenCalled();
  });

  it('preset:reorder rejects negative order', async () => {
    const { registerProjectHandlers } =
      await import('../../../../src/main/ipc/handlers/project.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerProjectHandlers();

    await expect(ipcMain._invoke('preset:reorder', 'preset-1', -1)).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(mockAgentPresetService.reorder).not.toHaveBeenCalled();
  });
});
