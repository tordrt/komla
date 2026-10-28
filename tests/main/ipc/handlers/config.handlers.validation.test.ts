import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mockConfigService = {
  get: vi.fn(),
  update: vi.fn(() => ({
    agentSetupComplete: true,
    scrollbackLines: 10000,
    theme: 'dark',
    defaultProjectId: null,
    notificationsEnabled: true,
    notificationPort: 52863,
  })),
};

vi.mock('../../../../src/main/services/agents-menu-bar.service', () => ({
  agentsMenuBarService: { setEnabled: vi.fn() },
}));
vi.mock('../../../../src/main/services/config.service', () => ({
  configService: mockConfigService,
}));

vi.mock('../../../../src/main/services/category.service', () => ({
  categoryService: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getSettingsPath: vi.fn(),
  },
}));
vi.mock('../../../../src/main/services/utility-secret.service', () => ({
  utilitySecretService: {
    setOpenRouterApiKey: vi.fn(),
    clearOpenRouterApiKey: vi.fn(),
    getStatus: vi.fn(),
  },
}));
vi.mock('../../../../src/main/services/project.service', () => ({
  projectService: {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    validateRepository: vi.fn(),
    hasProjects: vi.fn(),
    getSettingsPath: vi.fn(),
    createFromRemote: vi.fn(),
    createFromNew: vi.fn(),
  },
}));
vi.mock('../../../../src/main/services/agent-preset.service', () => ({
  agentPresetService: {
    list: vi.fn(),
    get: vi.fn(),
    getActive: vi.fn(),
    setActive: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getSettingsPath: vi.fn(),
    resolveCommand: vi.fn(),
  },
}));
vi.mock('../../../../src/main/services/claude-settings.service', () => ({
  claudeSettingsService: {
    enableNotificationHook: vi.fn(),
    disableNotificationHook: vi.fn(),
    getHookCommand: vi.fn(),
    getNotificationConfigJson: vi.fn(),
    getSettingsPath: vi.fn(),
    isNotificationHookEnabled: vi.fn(),
    getMcpStatus: vi.fn(),
    enableMcpServer: vi.fn(),
    disableMcpServer: vi.fn(),
    loginShellCommand: vi.fn(),
    getMcpCliCommand: vi.fn(),
    getMcpRemoveCliCommand: vi.fn(),
  },
}));
vi.mock('../../../../src/main/services/customization.service', () => ({
  customizationService: {
    getTheme: vi.fn(),
    getTerminal: vi.fn(),
    updateTheme: vi.fn(),
    updateTerminal: vi.fn(),
    getSettingsPath: vi.fn(),
    resetTheme: vi.fn(),
  },
}));
vi.mock('../../../../src/main/services/error-reporting.service', () => ({
  errorReportingService: { report: vi.fn() },
}));
vi.mock('../../../../src/main/services/feedback.service', () => ({
  feedbackService: { selectScreenshots: vi.fn(), sendFeedback: vi.fn() },
}));
vi.mock('../../../../src/main/services/http-server.service', () => ({
  httpServerService: { getPort: vi.fn(() => 52863) },
}));
vi.mock('../../../../src/main/services/paths', () => ({
  getKomlaBasePath: vi.fn(() => '/tmp/.komla'),
  ensureKomlaBasePath: vi.fn(() => '/tmp/.komla'),
}));
vi.mock('../../../../src/main/services/metrics-collector.service', () => ({
  metricsCollectorService: { onConfigChange: vi.fn() },
}));
vi.mock('../../../../src/main/services/pty.service', () => ({ ptyService: { killAll: vi.fn() } }));
vi.mock('../../../../src/main/services/shortcuts.service', () => ({
  shortcutsService: { getConfig: vi.fn(), updateConfig: vi.fn(), resetConfig: vi.fn() },
}));
const mockActionService = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  recordUsage: vi.fn(),
};
vi.mock('../../../../src/main/services/action.service', () => ({
  actionService: mockActionService,
}));
vi.mock('../../../../src/main/services/update.service', () => ({
  updateService: { installUpdate: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn() },
}));
vi.mock('../../../../src/main/services/workspace.service', () => ({
  workspaceService: {
    propagateProjectBaseBranch: vi.fn(),
    deleteAll: vi.fn(),
    assertSshHostConnectionUpdateAllowed: vi.fn(),
  },
}));
vi.mock('../../../../src/main/services/ssh-host.service', () => ({
  sshHostService: {
    list: vi.fn(() => []),
    get: vi.fn((id: string) =>
      id === 'ssh-devbox'
        ? { id, name: 'Devbox', hostname: 'devbox.example.com', basePath: '~/.komla' }
        : undefined
    ),
    save: vi.fn((host) => host),
  },
}));
const mockCheckHost = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
vi.mock('../../../../src/main/services/ssh-connection.service', () => ({
  sshConnectionService: { checkHost: mockCheckHost },
}));
vi.mock('../../../../src/main/services/ssh-port-forward.service', () => ({
  sshPortForwardService: {
    reconcileHostPortForwards: vi.fn(),
    stopHostPortForwards: vi.fn(),
    getHostPortForwardStatus: vi.fn(() => ({ hostId: 'ssh-devbox', state: 'stopped' })),
  },
}));
vi.mock('../../../../src/main/services/worktree-watcher.service', () => ({
  worktreeWatcherService: { stopAll: vi.fn(async () => undefined) },
}));
vi.mock('../../../../src/main/services/background-process.service', () => ({
  backgroundProcessService: { killAll: vi.fn() },
}));
vi.mock('../../../../src/main/services/window.service', () => ({
  windowService: { setZoomLevelAll: vi.fn() },
}));
const mockRemoteControlHostAccessService = { passkeyWindowChanged: vi.fn() };
vi.mock('../../../../src/main/services/remote-control-host-access.service', () => ({
  remoteControlHostAccessService: mockRemoteControlHostAccessService,
}));

describe('config IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('strips unknown keys from config:update payload', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();

    await ipcMain._invoke('config:update', {
      theme: 'dark',
      scrollbackLines: 12000,
      workspaceGrouping: 'none',
      injected: 'malicious',
    });

    expect(mockConfigService.update).toHaveBeenCalledWith({
      theme: 'dark',
      scrollbackLines: 12000,
      workspaceGrouping: 'none',
    });
  });

  it('takes saved utility prompts up to the length cap', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();

    await ipcMain._invoke('config:update', {
      workspaceNamingPrompt: 'Name it',
      commitMessagePrompt: '',
    });
    expect(mockConfigService.update).toHaveBeenCalledWith({
      workspaceNamingPrompt: 'Name it',
      commitMessagePrompt: '',
    });
    for (const key of ['workspaceNamingPrompt', 'commitMessagePrompt']) {
      await expect(
        ipcMain._invoke('config:update', { [key]: 'x'.repeat(20_001) })
      ).rejects.toThrow();
    }
  });

  it('accepts only the offered passkey windows', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();

    await ipcMain._invoke('config:update', { directRemotePasskeyWindowMinutes: 60 });
    expect(mockConfigService.update).toHaveBeenCalledWith({ directRemotePasskeyWindowMinutes: 60 });
    expect(mockRemoteControlHostAccessService.passkeyWindowChanged).toHaveBeenCalledTimes(1);
    await expect(
      ipcMain._invoke('config:update', { directRemotePasskeyWindowMinutes: 10_000 })
    ).rejects.toThrow();
  });

  it('checks an SSH host by its id', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();

    await ipcMain._invoke('ssh:host-check', 'ssh-devbox');
    expect(mockCheckHost).toHaveBeenCalledWith(expect.objectContaining({ id: 'ssh-devbox' }));
    await expect(ipcMain._invoke('ssh:host-check', { id: 'ssh-devbox' })).rejects.toThrow();
  });

  it('rejects invalid SSH port forward ports', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();

    await expect(
      ipcMain._invoke('ssh:save-host', {
        id: 'ssh-devbox',
        name: 'Devbox',
        hostname: 'devbox.example.com',
        basePath: '~/.komla',
        portForwards: [
          {
            id: 'postgres',
            name: 'PostgreSQL',
            localPort: 5432,
            remotePort: 70_000,
            enabled: true,
          },
        ],
      })
    ).rejects.toThrow();
  });
});
