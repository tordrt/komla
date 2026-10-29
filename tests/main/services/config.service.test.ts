import { existsSync, readFileSync, writeFileSync } from 'fs';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock electron's app module before importing the config service
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home'),
  },
}));

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  // Atomic write operations
  openSync: vi.fn(() => 42),
  closeSync: vi.fn(),
  fsyncSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

describe('ConfigService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset module cache to get fresh instance
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('load', () => {
    it('should return default config when config file does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const { configService } = await import('../../../src/main/services/config.service');
      const config = configService.get();

      expect(config).toEqual({
        agentSetupComplete: false,
        scrollbackLines: 10000,
        theme: 'system',
        defaultProjectId: null,
        notificationsEnabled: false,
        notificationPort: 53724,
        directRemoteEnabled: false,
        directRemotePort: 52864,
        directRemoteKeepAwake: false,
        directRemoteLocalAccess: true,
        directRemotePasskeyWindowMinutes: 15,
        defaultFileTreeOpen: false,
        defaultFileTreeMode: 'diff',
        defaultLiveFollow: false,
        defaultCompareTargetBranch: false,
        defaultDevServerPreviewAutoReload: true,
        webLinkOpenTarget: 'auto',
        workspaceGrouping: 'project',
        recentFolders: [],
        hideStoppedWorkspaces: false,
        hideWorkingWorkspaces: false,
        hiddenWorkspaceHostIds: [],
        hiddenWorkspaceTags: ['on hold'],
        tagsFromPullRequests: false,
        dashboardHiddenWorkspaceHostIds: [],
        telemetryPingSent: false,
        lastHeartbeatDate: undefined,
        telemetryDistinctId: undefined,
        workspaceSyncDeviceId: undefined,
        workspaceSyncDisabledHostIds: [],
        anonymousTelemetryEnabled: true,
        usageTelemetryEnabled: false,
        usageTelemetryConsentAnswered: false,
        reportedTelemetryMilestones: [],
        errorReportingEnabled: true,
        dismissedAnnouncementIds: [],
        zoomLevel: 0,
        autoNameWorkspaces: 'first-prompt',
        autoNameBranches: false,
        hideBranchNameInWorkspaceCards: false,
        compactWorkspaceList: false,
        defaultSearchOpenMode: 'current',
        hiddenProjectIds: [],
        utilityProvider: 'komla-managed',
        openRouterModel: 'anthropic/claude-haiku-5.5',
        openRouterBaseUrl: 'https://openrouter.ai/api/v1',
        showSystemMetrics: false,
        statusBarUsageResetTime: true,
        showAgentSpinner: true,
        showAgentsInMenuBar: true,
        agentsMenuBarInBackgroundOnly: true,
        activitySpinner: 'arc',
        reduceEffects: false,
        holdToQuit: false,
        selfIntegrationTipCreated: false,
        selfIntegrationTipCompleted: false,
        notificationsNudgePending: false,
        selfSetupNudgePending: false,
        tipsIntroPending: false,
        agentDisabledCapabilities: [],
        defaultSshWorkspaceMode: 'remote',
        voice: {
          modelId: 'parakeet-tdt-0.6b-v3-int8',
          modelPath: null,
          enabled: false,
          autoRecord: false,
          transcribeAction: 'fill',
        },
        notificationSounds: {
          enabled: true,
          volume: 0.5,
          turnComplete: true,
          turnCompleteSound: 'marimba',
          inputRequired: true,
          inputRequiredSound: 'bell',
        },
      });
    });

    it('should load existing config from file', async () => {
      const savedConfig = {
        agentSetupComplete: true,
        scrollbackLines: 5000,
        theme: 'dark',
        defaultProjectId: 'project-1',
        notificationsEnabled: true,
        notificationPort: 52864,
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(savedConfig));

      const { configService } = await import('../../../src/main/services/config.service');
      const config = configService.get();

      expect(config.agentSetupComplete).toBe(true);
      expect(config.scrollbackLines).toBe(5000);
      expect(config.theme).toBe('dark');
      expect(config.defaultProjectId).toBe('project-1');
      expect(config.notificationsEnabled).toBe(true);
      expect(config.notificationPort).toBe(52864);
      expect(config.utilityProvider).toBe('komla-managed');
      expect(config.openRouterModel).toBeDefined();
    });

    it('should use default values for missing config properties', async () => {
      const partialConfig = {
        theme: 'light',
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(partialConfig));

      const { configService } = await import('../../../src/main/services/config.service');
      const config = configService.get();

      expect(config.theme).toBe('light');
      expect(config.scrollbackLines).toBe(10000); // default
      expect(config.notificationPort).toBe(53724); // default
      expect(config.hideStoppedWorkspaces).toBe(false); // default
      expect(config.usageTelemetryEnabled).toBe(false); // default: opt-in
      expect(config.usageTelemetryConsentAnswered).toBe(false); // default
      expect(config.hideBranchNameInWorkspaceCards).toBe(false); // default
      expect(config.compactWorkspaceList).toBe(false); // default
      expect(config.activitySpinner).toBe('arc'); // default
      expect(config.utilityProvider).toBe('komla-managed'); // default
      expect(config.openRouterModel).toBe('anthropic/claude-haiku-5.5'); // default
      expect(config.showSystemMetrics).toBe(false); // default
    });

    it.each([
      [{ usageTelemetryEnabled: true }, false, false],
      [{ usageTelemetryEnabled: false }, false, false],
      [{ usageTelemetryEnabled: true, usageTelemetryConsentAnswered: true }, true, true],
      [{ usageTelemetryEnabled: false, usageTelemetryConsentAnswered: true }, false, true],
      // A saved-but-unanswered default must keep asking after a restart.
      [{ usageTelemetryEnabled: false, usageTelemetryConsentAnswered: false }, false, false],
    ])(
      'treats usage analytics as opted in only after an explicit answer (%o)',
      async (saved, expectedEnabled, expectedAnswered) => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(JSON.stringify(saved));

        const { configService } = await import('../../../src/main/services/config.service');
        const config = configService.get();

        expect(config.usageTelemetryEnabled).toBe(expectedEnabled);
        expect(config.usageTelemetryConsentAnswered).toBe(expectedAnswered);
      }
    );

    it('should persist showSystemMetrics when set to true', async () => {
      const savedConfig = {
        showSystemMetrics: true,
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(savedConfig));

      const { configService } = await import('../../../src/main/services/config.service');
      const config = configService.get();

      expect(config.showSystemMetrics).toBe(true);
    });

    it('should persist a hidden Tips button', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ showTipsInToolbar: false }));

      const { configService } = await import('../../../src/main/services/config.service');
      const config = configService.get();

      expect(config.showTipsInToolbar).toBe(false);
    });

    it('should persist a hidden status bar and its hidden, shown and placed items', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          showStatusBar: false,
          statusBarHiddenItems: ['agents', 7],
          statusBarShownItems: ['keep-awake', null],
          statusBarLeftItems: ['tips', false],
          statusBarRightItems: ['notes'],
        })
      );

      const { configService } = await import('../../../src/main/services/config.service');
      const config = configService.get();

      expect(config.showStatusBar).toBe(false);
      expect(config.statusBarHiddenItems).toEqual(['agents']);
      expect(config.statusBarShownItems).toEqual(['keep-awake']);
      expect(config.statusBarLeftItems).toEqual(['tips']);
      expect(config.statusBarRightItems).toEqual(['notes']);
    });

    it.each([
      [
        {
          branchPrefix: 'me/',
          aheadMainAction: 'merge',
          aheadOtherAction: 'pr',
          autoPushAfterMerge: false,
          behindTargetAction: 'rebase',
        },
        {
          branchPrefix: 'me/',
          aheadMainAction: 'merge',
          aheadOtherAction: 'pr',
          autoPushAfterMerge: false,
          behindTargetAction: 'rebase',
        },
      ],
      // A quick command keeps its id; an id without a quick command choice is dropped.
      [
        {
          aheadMainAction: 'agent-prompt',
          aheadMainActionId: 'pr-draft',
          aheadOtherAction: 'merge',
          aheadOtherActionId: 'stray',
        },
        {
          aheadMainAction: 'agent-prompt',
          aheadMainActionId: 'pr-draft',
          aheadOtherAction: 'merge',
        },
      ],
      // One ↑N choice alone or unknown values are dropped.
      [{ branchPrefix: '', aheadMainAction: 'merge', behindTargetAction: 'squash' }, {}],
      [{ aheadMainAction: 'agent-prompt', aheadMainActionId: 'pr-draft' }, {}],
      ['main', undefined],
    ])('should load git defaults %j as %j', async (stored, loaded) => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ gitDefaults: stored }));

      const { configService } = await import('../../../src/main/services/config.service');

      expect(configService.get().gitDefaults).toEqual(loaded);
    });

    it.each([
      [false, false],
      [true, true],
      ['no', undefined],
    ])('should load background fetch %j as %j', async (stored, loaded) => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ gitBackgroundFetch: stored }));

      const { configService } = await import('../../../src/main/services/config.service');

      expect(configService.get().gitBackgroundFetch).toBe(loaded);
    });

    it.each([
      ['braille', 'braille'],
      ['sparkle', 'arc'],
      [3, 'arc'],
    ])('should load activity spinner %j as %j', async (stored, loaded) => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ activitySpinner: stored }));

      const { configService } = await import('../../../src/main/services/config.service');

      expect(configService.get().activitySpinner).toBe(loaded);
    });

    it.each([
      ['agents', 'agents'],
      ['on', undefined],
      [true, undefined],
    ])('should load keep awake mode %j as %j', async (stored, loaded) => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ keepAwakeMode: stored }));

      const { configService } = await import('../../../src/main/services/config.service');

      expect(configService.get().keepAwakeMode).toBe(loaded);
    });

    it.each([
      ['computer', 'computer'],
      ['ssh-host-workspaces', 'ssh-host-workspaces'],
      ['gpu', undefined],
    ])('should load the status bar resource usage %j as %j', async (stored, loaded) => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ statusBarResourceUsage: stored }));

      const { configService } = await import('../../../src/main/services/config.service');

      expect(configService.get().statusBarResourceUsage).toBe(loaded);
    });

    it.each([
      ['weekly', 'weekly'],
      ['monthly', undefined],
    ])('should load the status bar usage limits %j as %j', async (stored, loaded) => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ statusBarUsageLimits: stored }));

      const { configService } = await import('../../../src/main/services/config.service');

      expect(configService.get().statusBarUsageLimits).toBe(loaded);
    });

    it.each([
      ['small', 'small'],
      ['huge', 'medium'],
      [32, 'medium'],
    ])('should load the status bar size %j as %j', async (stored, loaded) => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ statusBarSize: stored }));

      const { configService } = await import('../../../src/main/services/config.service');

      expect(configService.get().statusBarSize).toBe(loaded);
    });

    it.each([
      [undefined, true],
      [false, false],
    ])('should load the status bar usage reset time %j as %j', async (stored, loaded) => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ statusBarUsageResetTime: stored }));

      const { configService } = await import('../../../src/main/services/config.service');

      expect(configService.get().statusBarUsageResetTime).toBe(loaded);
    });

    it('should persist disabled browser preview auto reload', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ defaultDevServerPreviewAutoReload: false })
      );

      const { configService } = await import('../../../src/main/services/config.service');
      const config = configService.get();

      expect(config.defaultDevServerPreviewAutoReload).toBe(false);
    });

    it('should read where website links open, choosing automatically unless set otherwise', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ webLinkOpenTarget: 'external' }));
      const { configService } = await import('../../../src/main/services/config.service');
      expect(configService.get().webLinkOpenTarget).toBe('external');

      vi.resetModules();
      mockReadFileSync.mockReturnValue(JSON.stringify({ webLinkOpenTarget: 'komla' }));
      const komla = await import('../../../src/main/services/config.service');
      expect(komla.configService.get().webLinkOpenTarget).toBe('komla');

      vi.resetModules();
      mockReadFileSync.mockReturnValue(JSON.stringify({ webLinkOpenTarget: 'elsewhere' }));
      const reloaded = await import('../../../src/main/services/config.service');
      expect(reloaded.configService.get().webLinkOpenTarget).toBe('auto');
    });

    it('should persist stopped workspace visibility', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ hideStoppedWorkspaces: true }));

      const { configService } = await import('../../../src/main/services/config.service');
      const config = configService.get();

      expect(config.hideStoppedWorkspaces).toBe(true);
    });

    it('keeps the sidebar grouping, falling back to projects for anything else', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ workspaceGrouping: 'none' }));
      const { configService } = await import('../../../src/main/services/config.service');
      expect(configService.get().workspaceGrouping).toBe('none');

      vi.resetModules();
      mockReadFileSync.mockReturnValue(JSON.stringify({ workspaceGrouping: 'host' }));
      const { configService: reloaded } = await import('../../../src/main/services/config.service');
      expect(reloaded.get().workspaceGrouping).toBe('project');
    });

    it('should fall back to defaults for invalid persisted utility config', async () => {
      const invalidUtilityConfig = {
        utilityProvider: 'legacy-shell',
        openRouterModel: '',
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(invalidUtilityConfig));

      const { configService } = await import('../../../src/main/services/config.service');
      const config = configService.get();

      expect(config.utilityProvider).toBe('komla-managed');
      expect(config.openRouterModel).toBe('anthropic/claude-haiku-5.5');
    });

    it('loads saved utility prompts, capped, and none when invalid', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          workspaceNamingPrompt: `Name it${'x'.repeat(30_000)}`,
          commitMessagePrompt: 'Use gitmoji',
        })
      );
      const { configService } = await import('../../../src/main/services/config.service');
      const prompts = configService.getUtilityInferenceConfig();
      expect(prompts.workspaceNamingPrompt).toHaveLength(20_000);
      expect(prompts.commitMessagePrompt).toBe('Use gitmoji');

      vi.resetModules();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ workspaceNamingPrompt: 42, commitMessagePrompt: null })
      );
      const { configService: reloaded } = await import('../../../src/main/services/config.service');
      expect(reloaded.getUtilityInferenceConfig()).toMatchObject({
        workspaceNamingPrompt: '',
        commitMessagePrompt: '',
      });
    });

    it('replaces the retired default utility model with the current default', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ openRouterModel: 'google/gemini-2.5-flash-lite-preview-09-2025' })
      );
      const { configService } = await import('../../../src/main/services/config.service');
      expect(configService.get().openRouterModel).toBe('anthropic/claude-haiku-5.5');

      vi.resetModules();
      mockReadFileSync.mockReturnValue(JSON.stringify({ openRouterModel: 'openai/gpt-5-mini' }));
      const { configService: reloaded } = await import('../../../src/main/services/config.service');
      expect(reloaded.get().openRouterModel).toBe('openai/gpt-5-mini');
    });

    it('drops a last-used Lima sandbox environment on load', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ lastWorkspaceEnvironment: { kind: 'sandbox', methodId: 'lima' } })
      );

      const { configService } = await import('../../../src/main/services/config.service');

      expect(configService.get().lastWorkspaceEnvironment).toBeUndefined();
    });

    it('keeps a last-used SSH environment on load', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'host-1' } })
      );

      const { configService } = await import('../../../src/main/services/config.service');

      expect(configService.get().lastWorkspaceEnvironment).toEqual({
        kind: 'ssh',
        hostId: 'host-1',
      });
    });

    it('unpins the agent launch mode that was pinned for a Lima sandbox', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          agentLaunchDefaultPresetId: 'claude',
          agentLaunchDefaultLaunchModeId: 'dangerously-skip-permissions',
          agentLaunchDefaultSandboxMethodId: 'lima',
        })
      );

      const { configService } = await import('../../../src/main/services/config.service');
      const config = configService.get();

      expect(config.agentLaunchDefaultPresetId).toBe('claude');
      expect(config.agentLaunchDefaultLaunchModeId).toBeUndefined();
    });

    it('keeps the agent launch mode pinned for an SSH host over a Lima sandbox', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          agentLaunchDefaultLaunchModeId: 'dangerously-skip-permissions',
          agentLaunchDefaultSandboxMethodId: 'lima',
          agentLaunchDefaultSshHostId: 'host-1',
        })
      );

      const { configService } = await import('../../../src/main/services/config.service');

      expect(configService.get().agentLaunchDefaultLaunchModeId).toBe(
        'dangerously-skip-permissions'
      );
    });

    it('should return default config on parse error', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('invalid json{');

      const { configService } = await import('../../../src/main/services/config.service');
      const config = configService.get();

      expect(config.scrollbackLines).toBe(10000); // default
    });
  });

  describe('update', () => {
    it('should update config and save to file', async () => {
      mockExistsSync.mockReturnValue(false);

      const { configService } = await import('../../../src/main/services/config.service');

      const updated = configService.update({ theme: 'dark', scrollbackLines: 15000 });

      expect(updated.theme).toBe('dark');
      expect(updated.scrollbackLines).toBe(15000);

      // Fast-forward past debounce timer
      vi.advanceTimersByTime(600);

      expect(mockWriteFileSync).toHaveBeenCalled();
      const savedData = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(savedData.theme).toBe('dark');
      expect(savedData.scrollbackLines).toBe(15000);
    });

    it('tells listeners when the app-wide branch prefix changes', async () => {
      mockExistsSync.mockReturnValue(false);
      const { configService } = await import('../../../src/main/services/config.service');
      const listener = vi.fn();
      configService.onBranchPrefixChange(listener);

      configService.update({ gitDefaults: { branchPrefix: 'me/' } });
      configService.update({ gitDefaults: { branchPrefix: 'me/', aheadMainAction: 'pr' } });
      configService.update({ theme: 'dark' });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should debounce multiple rapid updates', async () => {
      mockExistsSync.mockReturnValue(false);

      const { configService } = await import('../../../src/main/services/config.service');

      configService.update({ theme: 'dark' });
      configService.update({ scrollbackLines: 5000 });
      configService.update({ notificationsEnabled: true });

      // Before debounce completes
      vi.advanceTimersByTime(400);
      expect(mockWriteFileSync).not.toHaveBeenCalled();

      // After debounce completes
      vi.advanceTimersByTime(200);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

      // Verify final state includes all updates
      const savedData = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(savedData.theme).toBe('dark');
      expect(savedData.scrollbackLines).toBe(5000);
      expect(savedData.notificationsEnabled).toBe(true);
    });

    it('round trips disabled agent capabilities through update + reload', async () => {
      mockExistsSync.mockReturnValue(false);

      const { configService } = await import('../../../src/main/services/config.service');

      const updated = configService.update({
        agentDisabledCapabilities: ['preview.open', 'agent.launch.tab'],
      });

      expect(updated.agentDisabledCapabilities).toEqual(['preview.open', 'agent.launch.tab']);

      vi.advanceTimersByTime(600);
      const savedData = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(savedData.agentDisabledCapabilities).toEqual(['preview.open', 'agent.launch.tab']);

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(savedData));
      vi.resetModules();

      const { configService: reloadedConfigService } =
        await import('../../../src/main/services/config.service');
      expect(reloadedConfigService.get().agentDisabledCapabilities).toEqual([
        'preview.open',
        'agent.launch.tab',
      ]);
    });

    it('defaults disabled agent capabilities to [] when missing from persisted config', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ theme: 'dark' }));

      const { configService } = await import('../../../src/main/services/config.service');
      expect(configService.get().agentDisabledCapabilities).toEqual([]);
    });

    it('filters non-string entries out of persisted agent capabilities', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          agentDisabledCapabilities: ['preview.open', 42, null, 'agent.launch.tab'],
        })
      );

      const { configService } = await import('../../../src/main/services/config.service');
      expect(configService.get().agentDisabledCapabilities).toEqual([
        'preview.open',
        'agent.launch.tab',
      ]);
    });

    it('should round trip utility config fields', async () => {
      mockExistsSync.mockReturnValue(false);

      const { configService } = await import('../../../src/main/services/config.service');

      const updated = configService.update({
        utilityProvider: 'custom',
        openRouterModel: 'openrouter/openai/gpt-4.1',
      });

      expect(updated.utilityProvider).toBe('custom');
      expect(updated.openRouterModel).toBe('openrouter/openai/gpt-4.1');

      vi.advanceTimersByTime(600);

      expect(mockWriteFileSync).toHaveBeenCalled();
      const savedData = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(savedData.utilityProvider).toBe('custom');
      expect(savedData.openRouterModel).toBe('openrouter/openai/gpt-4.1');

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(savedData));
      vi.resetModules();

      const { configService: reloadedConfigService } =
        await import('../../../src/main/services/config.service');
      const reloadedConfig = reloadedConfigService.get();

      expect(reloadedConfig.utilityProvider).toBe('custom');
      expect(reloadedConfig.openRouterModel).toBe('openrouter/openai/gpt-4.1');
    });
  });

  describe('get', () => {
    it('should return a copy of the config (immutable)', async () => {
      mockExistsSync.mockReturnValue(false);

      const { configService } = await import('../../../src/main/services/config.service');

      const config1 = configService.get();
      const config2 = configService.get();

      expect(config1).not.toBe(config2); // Different object references
      expect(config1).toEqual(config2); // Same content
    });
  });

  describe('wasLoadedFromDisk', () => {
    it('should return false on a fresh install (no config.json)', async () => {
      mockExistsSync.mockReturnValue(false);

      const { configService } = await import('../../../src/main/services/config.service');

      expect(configService.wasLoadedFromDisk()).toBe(false);
    });

    it('should return true when config.json loads successfully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ notificationPort: 52864 }));

      const { configService } = await import('../../../src/main/services/config.service');

      expect(configService.wasLoadedFromDisk()).toBe(true);
    });

    it('should return false when config.json exists but fails to parse (treated as fresh)', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('not valid json');

      const { configService } = await import('../../../src/main/services/config.service');

      // Parse error path returns DEFAULT_CONFIG without setting the flag — that
      // matches the spirit of "no usable prior state on disk".
      expect(configService.wasLoadedFromDisk()).toBe(false);
    });
  });
});
