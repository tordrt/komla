import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockBrowserWindow, mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mockConfig = {
  agentSetupComplete: true,
  scrollbackLines: 10000,
  theme: 'dark' as const,
  defaultProjectId: null,
  lastUsedProjectId: null,
  notificationsEnabled: true,
  notificationPort: 52863,
  utilityProvider: 'komla-managed' as const,
  openRouterModel: 'anthropic/claude-haiku-5.5',
};

const mockConfigService = {
  get: vi.fn(() => mockConfig),
  update: vi.fn((updates: Record<string, unknown>) => ({
    ...mockConfig,
    ...updates,
  })),
};

const mockUtilitySecretService = {
  setOpenRouterApiKey: vi.fn(async () => ({ storage: 'secure' as const })),
  clearOpenRouterApiKey: vi.fn(async () => undefined),
  getStatus: vi.fn(async () => ({ hasKey: false, storage: 'none' as const })),
};

const mockWindowService = {
  setZoomLevelAll: vi.fn(),
};

const mockMetricsCollectorService = {
  discard: vi.fn(),
};

const mockRemoteControlHostAccessService = {
  passkeyWindowChanged: vi.fn(),
};

const mockRemoteControlKeepAwakeService = {
  sync: vi.fn(),
};

const mockKeepAwakeService = {
  setMode: vi.fn(),
};

const mockSshWorkspaceService = {
  checkHostCapabilities: vi.fn(async () => ({
    ok: true as const,
    prepared: false,
    resolvedBasePath: '/home/devuser/.komla',
    git: { status: 'available' as const, version: 'git version 2.43.0' },
    localMirror: {
      platform: 'supported' as const,
      localRsync: 'available' as const,
      remoteRsync: 'available' as const,
    },
    tmux: { status: 'available' as const, version: 'tmux 3.4' },
    gitIdentity: {
      configured: true,
      userName: 'Tordrt',
      userEmail: 'devuser@example.com',
    },
  })),
  verifyAndPrepareHost: vi.fn(async () => ({
    ok: true as const,
    prepared: true,
    resolvedBasePath: '/home/devuser/.komla',
    notifyScriptPath: '/home/devuser/.komla/helpers/notify.sh',
    git: { status: 'available' as const, version: 'git version 2.43.0' },
    localMirror: {
      platform: 'supported' as const,
      localRsync: 'available' as const,
      remoteRsync: 'available' as const,
    },
    tmux: { status: 'available' as const, version: 'tmux 3.4' },
    gitIdentity: {
      configured: true,
      userName: 'Tordrt',
      userEmail: 'devuser@example.com',
    },
  })),
  getIntegrationStatus: vi.fn(async () => ({
    claude: { notifications: true, mcp: false },
    codex: { notifications: false, mcp: false },
    antigravity: { notifications: false, mcp: false },
    opencode: { notifications: false, mcp: false },
  })),
  getCachedIntegrationUpdates: vi.fn(() => ({ 'ssh-devbox': { claude: 'hooks' } })),
  onIntegrationUpdatesChanged: vi.fn(),
  enableIntegration: vi.fn(async () => undefined),
  disableIntegration: vi.fn(async () => undefined),
  forgetHost: vi.fn(),
};

const mockWorkspaceService = {
  deleteSshHost: vi.fn(async () => ({ deletedWorkspaceIds: [] })),
  assertSshHostConnectionUpdateAllowed: vi.fn(),
  sshSync: { syncSoon: vi.fn(async () => undefined) },
};
const mockSshHostService = {
  list: vi.fn(() => []),
  save: vi.fn((host) => host),
};
const mockSshPortForwardService = {
  reconcileHostPortForwards: vi.fn(async () => undefined),
  stopHostPortForwards: vi.fn(async () => undefined),
  getHostPortForwardStatus: vi.fn(() => ({
    hostId: 'ssh-devbox',
    state: 'connected' as const,
  })),
  listForwardedPorts: vi.fn(() => [
    {
      id: 'desktop:ssh-devbox:5901',
      hostId: 'ssh-devbox',
      kind: 'desktop',
      direction: 'remote-to-local',
      localPort: 5901,
      remotePort: 5901,
    },
  ]),
  stopDesktopForward: vi.fn(async () => undefined),
};

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
  utilitySecretService: mockUtilitySecretService,
}));

vi.mock('../../../../src/main/services/window.service', () => ({
  windowService: mockWindowService,
}));

vi.mock('../../../../src/main/services/metrics-collector.service', () => ({
  metricsCollectorService: mockMetricsCollectorService,
}));

vi.mock('../../../../src/main/services/remote-control-host-access.service', () => ({
  remoteControlHostAccessService: mockRemoteControlHostAccessService,
}));

vi.mock('../../../../src/main/services/remote-control-keep-awake.service', () => ({
  remoteControlKeepAwakeService: mockRemoteControlKeepAwakeService,
}));

vi.mock('../../../../src/main/services/keep-awake.service', () => ({
  keepAwakeService: mockKeepAwakeService,
}));

const mockAgentsMenuBarService = vi.hoisted(() => ({
  setEnabled: vi.fn(),
  setInBackgroundOnly: vi.fn(),
  setDoneClearedAt: vi.fn(),
}));
vi.mock('../../../../src/main/services/agents-menu-bar.service', () => ({
  agentsMenuBarService: mockAgentsMenuBarService,
}));

const mockRemoteWorkspaceObservationService = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock('../../../../src/main/services/remote-workspace-observation.service', () => ({
  remoteWorkspaceObservationService: mockRemoteWorkspaceObservationService,
}));

vi.mock('../../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: mockSshWorkspaceService,
}));

vi.mock('../../../../src/main/services/workspace.service', () => ({
  workspaceService: mockWorkspaceService,
}));
vi.mock('../../../../src/main/services/ssh-host.service', () => ({
  sshHostService: mockSshHostService,
}));
vi.mock('../../../../src/main/services/ssh-port-forward.service', () => ({
  sshPortForwardService: mockSshPortForwardService,
}));

describe('config IPC handlers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockConfigService.get.mockReturnValue(mockConfig);
    mockConfigService.update.mockImplementation((updates: Record<string, unknown>) => ({
      ...mockConfig,
      ...updates,
    }));
    mockUtilitySecretService.getStatus.mockResolvedValue({ hasKey: false, storage: 'none' });
    mockSshWorkspaceService.verifyAndPrepareHost.mockResolvedValue({
      ok: true,
      prepared: true,
      resolvedBasePath: '/home/devuser/.komla',
      notifyScriptPath: '/home/devuser/.komla/helpers/notify.sh',
      git: { status: 'available', version: 'git version 2.43.0' },
      localMirror: {
        platform: 'supported',
        localRsync: 'available',
        remoteRsync: 'available',
      },
      tmux: { status: 'available', version: 'tmux 3.4' },
      gitIdentity: {
        configured: true,
        userName: 'Tordrt',
        userEmail: 'devuser@example.com',
      },
    });
    mockSshWorkspaceService.getIntegrationStatus.mockResolvedValue({
      claude: { notifications: true, mcp: false },
      codex: { notifications: false, mcp: false },
      antigravity: { notifications: false, mcp: false },
      opencode: { notifications: false, mcp: false },
    });
    mockSshWorkspaceService.enableIntegration.mockResolvedValue(undefined);
    mockSshWorkspaceService.disableIntegration.mockResolvedValue(undefined);
    mockWorkspaceService.deleteSshHost.mockResolvedValue({ deletedWorkspaceIds: [] });
  });

  it('discards collected usage metrics when analytics is disabled through config:update', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();

    await ipcMain._invoke('config:update', {
      usageTelemetryEnabled: false,
    });

    expect(mockConfigService.update).toHaveBeenCalledWith({
      usageTelemetryEnabled: false,
      usageTelemetryConsentAnswered: true,
    });
    expect(mockMetricsCollectorService.discard).toHaveBeenCalledOnce();
  });

  it('reads utility config from config:get', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();

    const result = await ipcMain._invoke('config:get');

    expect(mockConfigService.get).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      utilityProvider: 'komla-managed',
      openRouterModel: 'anthropic/claude-haiku-5.5',
    });
  });

  it('updates utility config through config:update', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();

    const result = await ipcMain._invoke('config:update', {
      utilityProvider: 'custom',
      openRouterModel: 'openrouter/openai/gpt-4.1',
    });

    expect(mockConfigService.update).toHaveBeenCalledWith({
      utilityProvider: 'custom',
      openRouterModel: 'openrouter/openai/gpt-4.1',
    });
    expect(result).toMatchObject({
      utilityProvider: 'custom',
      openRouterModel: 'openrouter/openai/gpt-4.1',
    });
  });

  it('sends a saved config to the other windows, which keep their own copy', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { BrowserWindow, ipcMain } = (await import('electron')) as unknown as {
      BrowserWindow: { getAllWindows: ReturnType<typeof vi.fn> };
      ipcMain: { _getHandler: (channel: string) => (...args: unknown[]) => Promise<unknown> };
    };
    const savingWindow = createMockBrowserWindow();
    const otherWindow = createMockBrowserWindow();
    BrowserWindow.getAllWindows.mockReturnValue([savingWindow, otherWindow]);

    registerConfigHandlers();
    const config = await ipcMain._getHandler('config:update')(
      { sender: savingWindow.webContents },
      { keepAwakeMode: 'always' }
    );

    expect(otherWindow.webContents.send).toHaveBeenCalledWith('config:changed', config);
    // The saving window gets the config as the reply.
    expect(savingWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('lists and saves SSH hosts through dedicated IPC', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { BrowserWindow, ipcMain } = (await import('electron')) as unknown as {
      BrowserWindow: { getAllWindows: ReturnType<typeof vi.fn> };
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    const host = {
      id: 'ssh-dev',
      name: 'Devbox',
      hostname: 'dev.example.com',
      basePath: '~/.komla',
    };
    const firstWindow = createMockBrowserWindow();
    const secondWindow = createMockBrowserWindow();
    mockSshHostService.list.mockReturnValue([host]);
    BrowserWindow.getAllWindows.mockReturnValue([firstWindow, secondWindow]);

    registerConfigHandlers();
    expect(await ipcMain._invoke('ssh:list-hosts')).toEqual([host]);
    expect(await ipcMain._invoke('ssh:save-host', host)).toEqual(host);

    expect(mockWorkspaceService.assertSshHostConnectionUpdateAllowed).toHaveBeenCalledWith(host);
    expect(mockSshHostService.save).toHaveBeenCalledWith(host);
    expect(mockSshWorkspaceService.forgetHost).toHaveBeenCalledWith(host.id);
    expect(mockSshPortForwardService.reconcileHostPortForwards).toHaveBeenCalledWith(host);
    // Saving a host picks up the workspaces other devices started there.
    expect(mockWorkspaceService.sshSync.syncSoon).toHaveBeenCalledWith(host.id, { now: true });
    expect(firstWindow.webContents.send).toHaveBeenCalledWith('ssh:hosts-changed', [host]);
    expect(secondWindow.webContents.send).toHaveBeenCalledWith('ssh:hosts-changed', [host]);
  });

  it('saves an OpenRouter API key through config IPC', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();

    await ipcMain._invoke('config:save-openrouter-api-key', 'sk-or-test');

    expect(mockUtilitySecretService.setOpenRouterApiKey).toHaveBeenCalledWith('sk-or-test');
  });

  it('clears an OpenRouter API key through config IPC', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();

    await ipcMain._invoke('config:clear-openrouter-api-key');

    expect(mockUtilitySecretService.clearOpenRouterApiKey).toHaveBeenCalledOnce();
  });

  it('reads utility provider status without returning the raw key', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    mockUtilitySecretService.getStatus.mockResolvedValueOnce({ hasKey: true, storage: 'file' });
    registerConfigHandlers();

    const result = await ipcMain._invoke('config:get-openrouter-key-status');

    expect(mockUtilitySecretService.getStatus).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hasOpenRouterKey: true,
      isUsingFallbackStorage: true,
    });
    expect(result).not.toHaveProperty('openRouterApiKey');
  });

  it('verifies an SSH host through config IPC', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();

    const host = {
      id: 'ssh-devbox',
      name: 'Devbox',
      hostname: '192.168.1.50',
      basePath: '~/.komla',
    };
    const result = await ipcMain._invoke('config:verify-ssh-host', host);

    expect(mockSshWorkspaceService.checkHostCapabilities).toHaveBeenCalledWith(host);
    expect(result).toMatchObject({
      ok: true,
      prepared: false,
      git: { status: 'available', version: 'git version 2.43.0' },
    });

    await ipcMain._invoke('config:verify-ssh-host', host, { prepare: true });
    expect(mockSshWorkspaceService.verifyAndPrepareHost).toHaveBeenCalledWith(host);
  });

  it('manages SSH host integrations through config IPC', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();

    const status = await ipcMain._invoke('ssh:get-integration-status', 'ssh-devbox');
    const cachedUpdates = await ipcMain._invoke('ssh:get-cached-integration-updates');
    await ipcMain._invoke('ssh:enable-integration', 'ssh-devbox', 'codex', 'notifications');
    await ipcMain._invoke('ssh:disable-integration', 'ssh-devbox', 'codex', 'notifications');

    expect(mockSshWorkspaceService.getIntegrationStatus).toHaveBeenCalledWith('ssh-devbox');
    expect(status).toMatchObject({ claude: { notifications: true } });
    expect(cachedUpdates).toEqual({ 'ssh-devbox': { claude: 'hooks' } });
    expect(mockSshWorkspaceService.enableIntegration).toHaveBeenCalledWith(
      'ssh-devbox',
      'codex',
      'notifications'
    );
    expect(mockSshWorkspaceService.disableIntegration).toHaveBeenCalledWith(
      'ssh-devbox',
      'codex',
      'notifications'
    );
  });

  it('returns configured SSH port forward status through validated IPC', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();

    await expect(ipcMain._invoke('ssh:get-port-forward-status', '')).rejects.toThrow();
    await expect(ipcMain._invoke('ssh:get-port-forward-status', 'ssh-devbox')).resolves.toEqual({
      hostId: 'ssh-devbox',
      state: 'connected',
    });
    expect(mockSshPortForwardService.getHostPortForwardStatus).toHaveBeenCalledWith('ssh-devbox');
  });

  it('lists forwarded ports and stops a desktop forward through validated IPC', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();

    await expect(ipcMain._invoke('ssh:list-forwarded-ports')).resolves.toEqual([
      expect.objectContaining({ id: 'desktop:ssh-devbox:5901', kind: 'desktop' }),
    ]);
    await expect(ipcMain._invoke('ssh:stop-desktop-forward', 'ssh-devbox', 0)).rejects.toThrow();
    await expect(ipcMain._invoke('ssh:stop-desktop-forward', 'ssh-devbox')).rejects.toThrow();
    expect(mockSshPortForwardService.stopDesktopForward).not.toHaveBeenCalled();
    await ipcMain._invoke('ssh:stop-desktop-forward', 'ssh-devbox', 5901);
    expect(mockSshPortForwardService.stopDesktopForward).toHaveBeenCalledWith('ssh-devbox', 5901);
  });

  it('deletes SSH hosts through config IPC', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { BrowserWindow, ipcMain } = (await import('electron')) as unknown as {
      BrowserWindow: { getAllWindows: ReturnType<typeof vi.fn> };
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    const liveWindow = createMockBrowserWindow();
    const destroyedWindow = createMockBrowserWindow({
      isDestroyed: vi.fn(() => true),
    });
    mockWorkspaceService.deleteSshHost.mockResolvedValueOnce({
      deletedWorkspaceIds: ['ws-1'],
    });
    mockSshHostService.list.mockReturnValue([]);
    BrowserWindow.getAllWindows.mockReturnValue([liveWindow, destroyedWindow]);

    registerConfigHandlers();

    const result = await ipcMain._invoke('ssh:delete-host', 'ssh-devbox', {
      deleteRemoteData: true,
    });

    expect(mockWorkspaceService.deleteSshHost).toHaveBeenCalledWith('ssh-devbox', {
      deleteRemoteData: true,
    });
    expect(mockSshPortForwardService.stopHostPortForwards).toHaveBeenCalledWith('ssh-devbox');
    expect(result).toEqual({ deletedWorkspaceIds: ['ws-1'] });
    expect(liveWindow.webContents.send).toHaveBeenCalledWith('ssh:hosts-changed', []);
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('tells every window when the cached SSH integration updates change', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { BrowserWindow } = (await import('electron')) as unknown as {
      BrowserWindow: { getAllWindows: ReturnType<typeof vi.fn> };
    };
    const liveWindow = createMockBrowserWindow();
    const destroyedWindow = createMockBrowserWindow({ isDestroyed: vi.fn(() => true) });
    BrowserWindow.getAllWindows.mockReturnValue([liveWindow, destroyedWindow]);

    registerConfigHandlers();
    const [listener] = mockSshWorkspaceService.onIntegrationUpdatesChanged.mock.calls[0];
    listener({ 'ssh-devbox': { claude: 'hooks' } });

    expect(liveWindow.webContents.send).toHaveBeenCalledWith('ssh:integration-updates-changed', {
      'ssh-devbox': { claude: 'hooks' },
    });
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('tells SSH hosts which agent commands are turned off', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerConfigHandlers();
    await ipcMain._invoke('config:update', { agentDisabledCapabilities: ['preview.open'] });
    expect(mockRemoteWorkspaceObservationService.reconcile).not.toHaveBeenCalled();
    await ipcMain._invoke('config:update', { agentDisabledCapabilities: ['workspace.tag'] });

    expect(mockRemoteWorkspaceObservationService.reconcile).toHaveBeenCalledTimes(1);
  });

  it('applies a new keep-awake mode', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    mockConfigService.update.mockReturnValue({ ...mockConfig, keepAwakeMode: 'agents' });

    registerConfigHandlers();

    await ipcMain._invoke('config:update', { keepAwakeMode: 'agents' });

    expect(mockKeepAwakeService.setMode).toHaveBeenCalledWith('agents');
  });

  it('shows or hides the agents in the menu bar as the setting changes', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    mockConfigService.update.mockReturnValue({ ...mockConfig, showAgentsInMenuBar: true });

    registerConfigHandlers();

    await ipcMain._invoke('config:update', { showAgentsInMenuBar: true });

    expect(mockAgentsMenuBarService.setEnabled).toHaveBeenCalledWith(true);
  });

  it("passes the menu bar item's other settings to it as they change", async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    const updates = { agentsMenuBarInBackgroundOnly: true, agentsDoneClearedAt: 1_000 };
    mockConfigService.update.mockReturnValue({ ...mockConfig, ...updates });

    registerConfigHandlers();

    await ipcMain._invoke('config:update', updates);

    expect(mockAgentsMenuBarService.setInBackgroundOnly).toHaveBeenCalledWith(true);
    expect(mockAgentsMenuBarService.setDoneClearedAt).toHaveBeenCalledWith(1_000);
    expect(mockAgentsMenuBarService.setEnabled).not.toHaveBeenCalled();
  });

  it('syncs remote keep-awake when direct remote sleep settings change', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    mockConfigService.update.mockReturnValue({
      ...mockConfig,
      directRemoteEnabled: true,
      directRemoteKeepAwake: false,
    });

    registerConfigHandlers();

    await ipcMain._invoke('config:update', {
      directRemoteKeepAwake: false,
    });

    expect(mockRemoteControlKeepAwakeService.sync).toHaveBeenCalledWith(true, false);
  });

  it('tells SSH hosts when the passkey window changes', async () => {
    const { registerConfigHandlers } =
      await import('../../../../src/main/ipc/handlers/config.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    mockConfigService.update.mockReturnValue({
      ...mockConfig,
      directRemotePasskeyWindowMinutes: 60,
    });

    registerConfigHandlers();

    await ipcMain._invoke('config:update', { directRemoteKeepAwake: true });
    expect(mockRemoteControlHostAccessService.passkeyWindowChanged).not.toHaveBeenCalled();
    await ipcMain._invoke('config:update', { directRemotePasskeyWindowMinutes: 60 });
    expect(mockRemoteControlHostAccessService.passkeyWindowChanged).toHaveBeenCalledTimes(1);
  });
});
