import { exec, execFile } from 'child_process';
import { join } from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { refusingExecFile } from '../../../helpers/windows-refusal';
import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

vi.mock('child_process', () => ({ exec: vi.fn(), execFile: vi.fn(), spawn: vi.fn() }));

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

const mockClaudeSettingsService = {
  getClaudeVersion: vi.fn(async () => '2.1.296' as string | undefined),
  hasNotificationHooks: vi.fn(() => true),
  getNotificationUpdate: vi.fn(() => undefined as { files: { path: string; description: string }[] } | undefined),
  enableNotificationHook: vi.fn(),
  disableNotificationHook: vi.fn(),
  getHookCommand: vi.fn(() => 'curl -s http://localhost:52863/api/v1/notify'),
  getNotificationConfigJson: vi.fn(() => '{"hooks":{"PostToolUse":"curl ..."}}'),
  getSettingsPath: vi.fn(() => '/mock/home/.claude.json'),
  isNotificationHookEnabled: vi.fn(() => true),
  getMcpStatus: vi.fn(async () => ({
    isConfigured: true,
    mcpServerUrl: 'http://localhost:52863/api/v1/mcp',
    cliCommand:
      'claude mcp add --scope user --transport http komla http://localhost:52863/api/v1/mcp',
    configJson:
      '{"mcpServers":{"komla":{"type":"http","url":"http://localhost:52863/api/v1/mcp"}}}',
  })),
  enableMcpServer: vi.fn(() => ({ success: true })),
  disableMcpServer: vi.fn(() => ({ success: true })),
  loginShellCommand: vi.fn((cmd: string) => cmd),
  getMcpCliCommand: vi.fn(() => 'claude mcp add komla'),
  getMcpRemoveCliCommand: vi.fn(() => 'claude mcp remove komla'),
  isMcpServerInConfig: vi.fn(() => false),
};
const mockCodexSettingsService = {
  getNotificationUpdate: vi.fn(() => undefined as { files: { path: string; description: string }[] } | undefined),
  enableNotificationHook: vi.fn(),
  disableNotificationHook: vi.fn(),
  enableNotificationHookForce: vi.fn(() => ({ success: true })),
  getMcpStatus: vi.fn(() => ({ isConfigured: false })),
  getMcpCliCommand: vi.fn(() => 'codex mcp add komla --url http://localhost:52863/api/v1/mcp'),
  getMcpRemoveCliCommand: vi.fn(() => 'codex mcp remove komla'),
  enableMcpServer: vi.fn(() => ({ success: true })),
  getMcpConfigToml: vi.fn(() => '[mcp_servers.komla]\nurl = "http://localhost:52863/api/v1/mcp"'),
  getSettingsPath: vi.fn(() => '/mock/home/.codex/config.toml'),
  getHooksPath: vi.fn(() => '/mock/home/.codex/hooks.json'),
  getNotifyCommand: vi.fn(() => 'notify.js --source codex --event Stop # komla-notification-hook'),
  getNotificationConfigJson: vi.fn(
    () => '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"notify"}]}]}}'
  ),
  getNotificationStatus: vi.fn(() => ({
    isConfigured: false,
    hasConflict: false,
    canAutoConfigure: true,
    conflictMessage: null,
    isKomlaManaged: false,
  })),
  disableMcpServer: vi.fn(),
};
const mockAntigravitySettingsService = {
  getNotificationUpdate: vi.fn(() => undefined as { files: { path: string; description: string }[] } | undefined),
  enableNotificationHook: vi.fn(),
  disableNotificationHook: vi.fn(),
  getMcpStatus: vi.fn(() => ({ isConfigured: false })),
  getMcpCliCommand: vi.fn(() => 'agy mcp add komla'),
  getMcpRemoveCliCommand: vi.fn(() => 'agy mcp remove komla'),
  enableMcpServer: vi.fn(() => ({ success: true })),
  getSettingsPath: vi.fn(() => '/mock/home/.gemini/config/hooks.json'),
  getMcpSettingsPath: vi.fn(() => '/mock/home/.gemini/config/mcp_config.json'),
  getHookCommand: vi.fn(() => 'curl -s http://localhost:52863/api/v1/notify'),
  getNotificationConfigJson: vi.fn(() => '{"hooks":{"PostToolUse":"curl ..."}}'),
  isNotificationHookEnabled: vi.fn(() => false),
  disableMcpServer: vi.fn(),
};
const mockOpencodeSettingsService = {
  getNotificationUpdate: vi.fn(() => undefined as { files: { path: string; description: string }[] } | undefined),
  enableNotificationPlugin: vi.fn(),
  disableNotificationPlugin: vi.fn(),
  getPluginContent: vi.fn(() => 'plugin content here'),
  getPluginPath: vi.fn(() => '/mock/home/.opencode/plugins/komla.lua'),
  isNotificationPluginEnabled: vi.fn(() => false),
  getMcpStatus: vi.fn(() => ({ isConfigured: false })),
  getMcpCliCommand: vi.fn(() => 'npx add-mcp http://localhost:52863/api/v1/mcp -g -n komla'),
  getMcpConfigJson: vi.fn(() => '{}'),
  getSettingsPath: vi.fn(() => '/mock/home/.opencode/config.json'),
};
const mockConfigService = {
  update: vi.fn(),
};
const mockHttpServerService = {
  getPort: vi.fn(() => 52863),
  // Default: server already bound — fire the callback synchronously.
  onStarted: vi.fn((cb: () => void) => cb()),
};
const mockExec = vi.mocked(exec);

vi.mock('../../../../src/main/services/claude-settings.service', () => ({
  claudeSettingsService: mockClaudeSettingsService,
}));
vi.mock('../../../../src/main/services/codex-settings.service', () => ({
  codexSettingsService: mockCodexSettingsService,
}));
vi.mock('../../../../src/main/services/antigravity-settings.service', () => ({
  antigravitySettingsService: mockAntigravitySettingsService,
}));
vi.mock('../../../../src/main/services/opencode-settings.service', () => ({
  opencodeSettingsService: mockOpencodeSettingsService,
}));
vi.mock('../../../../src/main/services/config.service', () => ({
  configService: mockConfigService,
}));
vi.mock('../../../../src/main/services/http-server.service', () => ({
  httpServerService: mockHttpServerService,
}));
vi.mock('../../../../src/main/services/ssh-workspace.service', () => ({
  remoteKomlaDataPort: vi.fn(() => 63123),
  sshWorkspaceService: {
    getHost: vi.fn(() => ({ id: 'ssh-dev', name: 'Devbox', hostname: 'dev.example.com' })),
  },
}));

describe('agent-settings IPC behavior', () => {
  it('returns an update preview without enabling notifications', async () => {
    const update = { files: [{ path: '/mock/home/.codex/config.toml', description: 'Enable hooks and remove the legacy Komla block.' }] };
    mockCodexSettingsService.getNotificationUpdate.mockReturnValueOnce(update);
    const { registerAgentSettingsHandlers } = await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = await import('electron');
    registerAgentSettingsHandlers();
    const result = await (ipcMain as any)._invoke('codex-notifications:get-hook-details');
    expect(result.update).toEqual(update);
    expect(mockCodexSettingsService.enableNotificationHook).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockExec.mockReset();
    mockClaudeSettingsService.isMcpServerInConfig.mockReturnValue(false);
    mockCodexSettingsService.getMcpStatus.mockReturnValue({ isConfigured: false });
    mockAntigravitySettingsService.getMcpStatus.mockReturnValue({ isConfigured: false });
    mockOpencodeSettingsService.getMcpStatus.mockReturnValue({ isConfigured: false });
  });

  // --- Claude notifications ---

  it('notifications:enable calls enableNotificationHook and updates config', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    await ipcMain._invoke('notifications:enable');

    expect(mockClaudeSettingsService.enableNotificationHook).toHaveBeenCalledWith('2.1.296');
    expect(mockConfigService.update).toHaveBeenCalledWith({ notificationsEnabled: true });
  });

  it('notifications:disable calls disableNotificationHook and updates config', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    await ipcMain._invoke('notifications:disable');

    expect(mockClaudeSettingsService.disableNotificationHook).toHaveBeenCalledOnce();
    expect(mockConfigService.update).toHaveBeenCalledWith({ notificationsEnabled: false });
  });

  it('notifications:get-hook-details returns correct structure', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('notifications:get-hook-details')) as {
      command: string;
      configJson: string;
      settingsPath: string;
      port: number;
      isConfigured: boolean;
    };

    expect(result.command).toBe('curl -s http://localhost:52863/api/v1/notify');
    expect(result.configJson).toBe('{"hooks":{"PostToolUse":"curl ..."}}');
    expect(result.settingsPath).toBe('/mock/home/.claude.json');
    expect(result.port).toBe(52863);
    expect(result.isConfigured).toBe(true);
  });

  it('notifications:get-hook-details asks Claude for its version only for installed hooks', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };
    registerAgentSettingsHandlers();

    mockClaudeSettingsService.hasNotificationHooks.mockReturnValueOnce(false);
    await ipcMain._invoke('notifications:get-hook-details');
    expect(mockClaudeSettingsService.getClaudeVersion).not.toHaveBeenCalled();
    expect(mockClaudeSettingsService.getNotificationUpdate).toHaveBeenLastCalledWith(undefined);

    await ipcMain._invoke('notifications:get-hook-details');
    expect(mockClaudeSettingsService.getClaudeVersion).toHaveBeenCalledOnce();
    expect(mockClaudeSettingsService.getNotificationUpdate).toHaveBeenLastCalledWith('2.1.296');
  });

  // --- Codex notifications ---

  it('codex-notifications:enable calls enableNotificationHook and updates config', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    await ipcMain._invoke('codex-notifications:enable');

    expect(mockCodexSettingsService.enableNotificationHook).toHaveBeenCalled();
    expect(mockConfigService.update).toHaveBeenCalledWith({ notificationsEnabled: true });
  });

  it('codex-notifications:disable calls disableNotificationHook without updating config', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    await ipcMain._invoke('codex-notifications:disable');

    expect(mockCodexSettingsService.disableNotificationHook).toHaveBeenCalledOnce();
    expect(mockConfigService.update).not.toHaveBeenCalled();
  });

  it('codex-notifications:get-hook-details returns correct structure', async () => {
    mockCodexSettingsService.getNotificationStatus.mockReturnValue({
      isConfigured: false,
      hasConflict: false,
      canAutoConfigure: true,
      conflictMessage: null,
      isKomlaManaged: false,
    });

    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('codex-notifications:get-hook-details')) as {
      command: string;
      configJson: string;
      settingsPath: string;
      port: number;
      isConfigured: boolean;
      hasConflict: boolean;
      canAutoConfigure: boolean;
      conflictMessage: string | null;
    };

    expect(result.command).toContain('komla-notification-hook');
    expect(result.configJson).toContain('Stop');
    expect(result.settingsPath).toBe('/mock/home/.codex/hooks.json');
    expect(result.port).toBe(52863);
    expect(result.isConfigured).toBe(false);
    expect(result.hasConflict).toBe(false);
    expect(result.canAutoConfigure).toBe(true);
    expect(result.conflictMessage).toBeNull();
  });

  // --- Antigravity CLI notifications ---

  it('antigravity-notifications:enable calls enableNotificationHook and updates config', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    await ipcMain._invoke('antigravity-notifications:enable');

    expect(mockAntigravitySettingsService.enableNotificationHook).toHaveBeenCalled();
    expect(mockConfigService.update).toHaveBeenCalledWith({ notificationsEnabled: true });
  });

  it('antigravity-notifications:disable calls disableNotificationHook without updating config', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    await ipcMain._invoke('antigravity-notifications:disable');

    expect(mockAntigravitySettingsService.disableNotificationHook).toHaveBeenCalledOnce();
    expect(mockConfigService.update).not.toHaveBeenCalled();
  });

  it('antigravity-notifications:get-hook-details returns correct structure', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('antigravity-notifications:get-hook-details')) as {
      command: string;
      configJson: string;
      settingsPath: string;
      port: number;
      isConfigured: boolean;
    };

    expect(result.command).toBe('curl -s http://localhost:52863/api/v1/notify');
    expect(result.configJson).toBe('{"hooks":{"PostToolUse":"curl ..."}}');
    expect(result.settingsPath).toBe('/mock/home/.gemini/config/hooks.json');
    expect(result.port).toBe(52863);
    expect(result.isConfigured).toBe(false);
  });

  // --- OpenCode notifications ---

  it('opencode-notifications:enable calls enableNotificationPlugin and updates config', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    await ipcMain._invoke('opencode-notifications:enable');

    expect(mockOpencodeSettingsService.enableNotificationPlugin).toHaveBeenCalled();
    expect(mockConfigService.update).toHaveBeenCalledWith({ notificationsEnabled: true });
  });

  it('opencode-notifications:disable calls disableNotificationPlugin without updating config', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    await ipcMain._invoke('opencode-notifications:disable');

    expect(mockOpencodeSettingsService.disableNotificationPlugin).toHaveBeenCalledOnce();
    expect(mockConfigService.update).not.toHaveBeenCalled();
  });

  it('opencode-notifications:get-hook-details returns correct structure', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('opencode-notifications:get-hook-details')) as {
      pluginContent: string;
      pluginPath: string;
      port: number;
      isConfigured: boolean;
    };

    expect(result.pluginContent).toBe('plugin content here');
    expect(result.pluginPath).toBe('/mock/home/.opencode/plugins/komla.lua');
    expect(result.port).toBe(52863);
    expect(result.isConfigured).toBe(false);
  });

  // --- MCP ---

  it('mcp:get-status returns combined status from all services', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('mcp:get-status')) as {
      isConfigured: boolean;
      mcpServerUrl: string;
      cliCommand: string;
      configJson: string;
      codex: {
        isConfigured: boolean;
        cliCommand: string;
        removeCliCommand: string;
        configToml: string;
        settingsPath: string;
      };
      antigravity: {
        isConfigured: boolean;
        cliCommand: string;
        removeCliCommand: string;
        settingsPath: string;
      };
      opencode: {
        isConfigured: boolean;
        cliCommand: string;
        configJson: string;
        settingsPath: string;
      };
      generic: {
        cliCommand: string;
        configJson: string;
        notifyCommand: string;
      };
    };

    expect(mockClaudeSettingsService.getMcpStatus).toHaveBeenCalledWith(52863);
    expect(result.isConfigured).toBe(true);
    expect(result.mcpServerUrl).toBe('http://localhost:52863/api/v1/mcp');
    expect(result.codex.isConfigured).toBe(false);
    expect(result.codex.cliCommand).toBe(
      'codex mcp add komla --url http://localhost:52863/api/v1/mcp'
    );
    expect(result.codex.removeCliCommand).toBe('codex mcp remove komla');
    expect(result.codex.configToml).toBe(
      '[mcp_servers.komla]\nurl = "http://localhost:52863/api/v1/mcp"'
    );
    expect(result.codex.settingsPath).toBe('/mock/home/.codex/config.toml');
    expect(result.antigravity.isConfigured).toBe(false);
    expect(result.antigravity.cliCommand).toBe('agy mcp add komla');
    expect(result.antigravity.removeCliCommand).toBe('agy mcp remove komla');
    expect(result.antigravity.settingsPath).toBe('/mock/home/.gemini/config/mcp_config.json');
    expect(result.opencode.isConfigured).toBe(false);
    expect(result.opencode.cliCommand).toContain('npx add-mcp');
    expect(result.opencode.configJson).toBe('{}');
    expect(result.opencode.settingsPath).toBe('/mock/home/.opencode/config.json');
    expect(result.generic.cliCommand).toBe('komla mcp');
    expect(result.generic.notifyCommand).toBe('komla notify --source my-agent --event Stop');
    expect(result.generic.configJson).toContain('"command": "komla"');
    expect(result.generic.configJson).not.toContain('/api/v1/mcp');
    expect(result.generic).not.toHaveProperty('notifyScriptPath');
    expect(result.generic).not.toHaveProperty('notifyUrl');
  });

  it('mcp:get-status with Claude Code agent only calls claudeSettingsService.getMcpStatus', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('mcp:get-status', 'Claude Code')) as {
      isConfigured: boolean;
      mcpServerUrl: string;
      generic: { cliCommand: string };
    };

    expect(mockClaudeSettingsService.getMcpStatus).toHaveBeenCalledWith(52863);
    expect(mockCodexSettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(mockAntigravitySettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(mockOpencodeSettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(result.isConfigured).toBe(true);
    expect(result.generic.cliCommand).toBe('komla mcp');
  });

  it('mcp:get-status with Codex agent only calls codexSettingsService.getMcpStatus', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('mcp:get-status', 'Codex')) as {
      codex: { isConfigured: boolean; settingsPath: string };
      generic: { cliCommand: string };
    };

    expect(mockCodexSettingsService.getMcpStatus).toHaveBeenCalled();
    expect(mockClaudeSettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(mockAntigravitySettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(mockOpencodeSettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(result.codex.isConfigured).toBe(false);
    expect(result.generic.cliCommand).toBe('komla mcp');
  });

  it('mcp:get-status with Antigravity CLI agent only calls antigravitySettingsService.getMcpStatus', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('mcp:get-status', 'Antigravity CLI')) as {
      antigravity: { isConfigured: boolean; settingsPath: string };
      generic: { cliCommand: string };
    };

    expect(mockAntigravitySettingsService.getMcpStatus).toHaveBeenCalled();
    expect(mockClaudeSettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(mockCodexSettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(mockOpencodeSettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(result.antigravity.isConfigured).toBe(false);
    expect(result.generic.cliCommand).toBe('komla mcp');
  });

  it('mcp:get-status with OpenCode agent only calls opencodeSettingsService.getMcpStatus', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('mcp:get-status', 'OpenCode')) as {
      opencode: { isConfigured: boolean; settingsPath: string };
      generic: { cliCommand: string };
    };

    expect(mockOpencodeSettingsService.getMcpStatus).toHaveBeenCalled();
    expect(mockClaudeSettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(mockCodexSettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(mockAntigravitySettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(result.opencode.isConfigured).toBe(false);
    expect(result.generic.cliCommand).toBe('komla mcp');
  });

  it('mcp:get-status with generic agent skips all settings services and returns port-derived URLs', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('mcp:get-status', 'Amp')) as {
      isConfigured: boolean;
      mcpServerUrl: string;
      generic: { cliCommand: string; notifyCommand: string };
    };

    expect(mockClaudeSettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(mockCodexSettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(mockAntigravitySettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(mockOpencodeSettingsService.getMcpStatus).not.toHaveBeenCalled();
    expect(result.isConfigured).toBe(false);
    expect(result.generic.cliCommand).toBe('komla mcp');
    expect(result.generic.notifyCommand).toContain('komla notify');
  });

  it('mcp:get-status returns an SSH self-integration prompt', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('mcp:get-status', undefined, 'ssh-dev')) as {
      mcpServerUrl: string;
      generic: {
        integrationPrompt: string;
        notifyCommand: string;
      };
    };

    expect(result.mcpServerUrl).toBe('http://127.0.0.1:63123/api/v1/mcp');
    expect(result.generic.integrationPrompt).toContain(
      'komla skill self-integration'
    );
    expect(result.generic.integrationPrompt).not.toContain('127.0.0.1:63123/skills');
    expect(result.generic.integrationPrompt).not.toContain('Authorization');
    expect(result.generic.notifyCommand).toBe('komla notify --source my-agent --event Stop');
    expect(mockClaudeSettingsService.getMcpStatus).not.toHaveBeenCalled();
  });

  it('mcp:get-status points self-integration at notify.js when Windows blocks the CLI', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const { registerAgentSettingsHandlers } =
        await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
      const { probeKomlaCli } = await import('../../../../src/main/lib/komla-cli');
      const { getKomlaBasePath } = await import('../../../../src/main/services/paths');
      const { ipcMain } = (await import('electron')) as unknown as {
        ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      };
      type Status = { generic: { integrationPrompt: string; notifyCommand: string } };
      const base = getKomlaBasePath();
      const fallback = `If Windows refuses to run it, read \`${join(base, 'skills', 'komla-self-integration-instructions.md')}\` instead.`;

      registerAgentSettingsHandlers();
      const allowed = (await ipcMain._invoke('mcp:get-status', 'Amp')) as Status;
      vi.mocked(execFile).mockImplementationOnce(refusingExecFile());
      expect(probeKomlaCli('C:\\Users\\dev\\.komla\\bin\\komla.exe')).toBe(true);
      const blocked = (await ipcMain._invoke('mcp:get-status', 'Amp')) as Status;
      const ssh = (await ipcMain._invoke('mcp:get-status', undefined, 'ssh-dev')) as Status;

      expect(allowed.generic.integrationPrompt).not.toContain('Windows');
      expect(allowed.generic.notifyCommand).toBe('komla notify --source my-agent --event Stop');
      expect(blocked.generic.integrationPrompt).toContain('komla skill self-integration');
      expect(blocked.generic.integrationPrompt).toContain(fallback);
      expect(blocked.generic.notifyCommand).toBe(
        `"${join(base, 'komla-node.cmd')}" "${join(base, 'notify.js')}" --source my-agent --event Stop`
      );
      // SSH agents run their own CLI, which Windows doesn't police.
      expect(ssh.generic.integrationPrompt).not.toContain('Windows');
      expect(ssh.generic.notifyCommand).toBe('komla notify --source my-agent --event Stop');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('mcp:enable delegates to claudeSettingsService', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('mcp:enable')) as { success: boolean };

    expect(mockClaudeSettingsService.enableMcpServer).toHaveBeenCalledWith(52863);
    expect(result.success).toBe(true);
  });

  it('mcp:disable delegates to claudeSettingsService', async () => {
    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('mcp:disable')) as { success: boolean };

    expect(mockClaudeSettingsService.disableMcpServer).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
  });

  it('mcp:run-codex-cli falls back to file config when node runtime is missing', async () => {
    mockExec.mockImplementation(((...args: unknown[]) => {
      const callback = args[2] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(new Error('failed'), '', 'env: node: No such file or directory');
      return {} as never;
    }) as never);

    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('mcp:run-codex-cli')) as {
      success: boolean;
      output?: string;
      error?: string;
    };

    expect(result.success).toBe(true);
    expect(result.output).toContain('~/.codex/config.toml');
    expect(mockCodexSettingsService.enableMcpServer).toHaveBeenCalledWith(52863);
  });

  it('mcp:run-antigravity-cli falls back to file config when agy is missing', async () => {
    mockExec.mockImplementation(((...args: unknown[]) => {
      const callback = args[2] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(new Error('failed'), '', 'sh: agy: command not found');
      return {} as never;
    }) as never);

    const { registerAgentSettingsHandlers } =
      await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    };

    registerAgentSettingsHandlers();
    const result = (await ipcMain._invoke('mcp:run-antigravity-cli')) as {
      success: boolean;
      output?: string;
      error?: string;
    };

    expect(result.success).toBe(true);
    expect(result.output).toContain('~/.gemini/config/mcp_config.json');
    expect(mockAntigravitySettingsService.enableMcpServer).toHaveBeenCalledWith(52863);
  });

  describe('mcp:reconfigure-all', () => {
    it('reconfigures all agents that have MCP configured', async () => {
      mockClaudeSettingsService.isMcpServerInConfig.mockReturnValue(true);
      mockCodexSettingsService.getMcpStatus.mockReturnValue({ isConfigured: true });
      mockAntigravitySettingsService.getMcpStatus.mockReturnValue({ isConfigured: true });
      mockClaudeSettingsService.disableMcpServer.mockReturnValue({ success: true });
      mockClaudeSettingsService.enableMcpServer.mockReturnValue({ success: true });
      mockCodexSettingsService.disableMcpServer.mockReturnValue({ success: true });
      mockCodexSettingsService.enableMcpServer.mockReturnValue({ success: true });
      mockAntigravitySettingsService.disableMcpServer.mockReturnValue({ success: true });
      mockAntigravitySettingsService.enableMcpServer.mockReturnValue({ success: true });

      mockExec.mockImplementation(((...args: unknown[]) => {
        const callback = args[2] as (error: Error | null, stdout: string, stderr: string) => void;
        callback(null, 'ok', '');
        return {} as never;
      }) as never);

      const { registerAgentSettingsHandlers } =
        await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
      const { ipcMain } = (await import('electron')) as unknown as {
        ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      };

      registerAgentSettingsHandlers();
      const result = (await ipcMain._invoke('mcp:reconfigure-all')) as {
        success: boolean;
        results: { agent: string; success: boolean; error?: string }[];
      };

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(3);
      expect(result.results.every((r) => r.success)).toBe(true);
      expect(result.results.map((r) => r.agent)).toEqual(['claude', 'codex', 'antigravity']);
    });

    it('skips agents without MCP configured', async () => {
      // All defaults are false/not configured (set in beforeEach)

      const { registerAgentSettingsHandlers } =
        await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
      const { ipcMain } = (await import('electron')) as unknown as {
        ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      };

      registerAgentSettingsHandlers();
      const result = (await ipcMain._invoke('mcp:reconfigure-all')) as {
        success: boolean;
        results: { agent: string; success: boolean; error?: string }[];
      };

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(0);
      expect(mockExec).not.toHaveBeenCalled();
    });
  });

  describe('server:get-port', () => {
    it('resolves immediately with the port when the server is already bound', async () => {
      const { registerAgentSettingsHandlers } =
        await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
      const { ipcMain } = (await import('electron')) as unknown as {
        ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      };

      mockHttpServerService.getPort.mockReturnValue(52863);
      registerAgentSettingsHandlers();

      expect(await ipcMain._invoke('server:get-port')).toBe(52863);
    });

    it('waits for the server to bind before resolving the port', async () => {
      const { registerAgentSettingsHandlers } =
        await import('../../../../src/main/ipc/handlers/agent-settings.handlers');
      const { ipcMain } = (await import('electron')) as unknown as {
        ipcMain: { _invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
      };

      // Server not bound yet — hold the started callback instead of firing it.
      let fireStarted: (() => void) | null = null;
      mockHttpServerService.onStarted.mockImplementationOnce((cb: () => void) => {
        fireStarted = cb;
      });
      registerAgentSettingsHandlers();

      const portPromise = ipcMain._invoke('server:get-port');
      let resolved = false;
      void portPromise.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);

      // The server binds to a fallback port after the renderer already asked.
      mockHttpServerService.getPort.mockReturnValue(52864);
      fireStarted!();
      expect(await portPromise).toBe(52864);
    });
  });
});
