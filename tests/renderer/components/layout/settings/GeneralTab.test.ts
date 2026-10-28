import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isValidTerminalBackgroundColor,
  paletteOverridesTerminalBackground,
} from '../../../../../src/renderer/lib/terminal-background-settings';
import { DEFAULT_PALETTE_ID } from '../../../../../src/renderer/lib/palette-presets';
import { useConfigStore } from '../../../../../src/renderer/stores/config.store';

/**
 * Tests for GeneralTab settings behavior.
 *
 * These verify at the store level that config updates used by GeneralTab
 * keep file-tree defaults independent — toggling one setting must not
 * implicitly mutate another.
 */

function resetStore(): void {
  useConfigStore.setState(useConfigStore.getInitialState(), true);
}

function mockApi(configOverrides: Record<string, unknown> = {}): Record<string, any> {
  const baseConfig = {
    defaultFileTreeOpen: true,
    defaultFileTreeMode: 'diff' as const,
    defaultLiveFollow: true,
    defaultCompareTargetBranch: true,
    scrollbackLines: 10000,
    theme: 'system',
    notificationsEnabled: false,
    utilityProvider: 'komla-managed',
    openRouterModel: 'openrouter/openai/gpt-4.1-mini',
    remoteBranchesExpanded: false,
    diffHideUnchangedRegions: true,
    ...configOverrides,
  };

  let currentConfig = { ...baseConfig };

  const api = {
    getConfig: vi.fn().mockImplementation(() => Promise.resolve({ ...currentConfig })),
    updateConfig: vi.fn().mockImplementation(async (updates: Record<string, unknown>) => {
      currentConfig = { ...currentConfig, ...updates };
      return { ...currentConfig };
    }),
    hasProjects: vi.fn().mockResolvedValue(false),
    getOpenRouterKeyStatus: vi.fn().mockResolvedValue({ hasOpenRouterKey: false }),
  };
  (globalThis as any).window = { api };
  return api;
}

describe('GeneralTab settings behavior', () => {
  let api: Record<string, any>;

  beforeEach(() => {
    resetStore();
    api = mockApi();
  });

  describe('file tree defaults independence', () => {
    it('disabling defaultFileTreeOpen does not reset defaultLiveFollow', async () => {
      await useConfigStore.getState().loadConfig();

      // Simulate what GeneralTab does when toggling "Show file tree by default" off
      await useConfigStore.getState().updateConfig({ defaultFileTreeOpen: false });

      expect(api.updateConfig).toHaveBeenCalledWith({ defaultFileTreeOpen: false });
      // defaultLiveFollow must remain untouched
      const config = useConfigStore.getState().config;
      expect(config?.defaultLiveFollow).toBe(true);
    });
  });

  describe('privacy toggles independence', () => {
    it('usage telemetry can be toggled independently of error reporting', async () => {
      api = mockApi({ usageTelemetryEnabled: true, errorReportingEnabled: true });
      await useConfigStore.getState().loadConfig();

      await useConfigStore.getState().updateConfig({ usageTelemetryEnabled: false });

      expect(api.updateConfig).toHaveBeenCalledWith({ usageTelemetryEnabled: false });
      const config = useConfigStore.getState().config;
      expect(config?.usageTelemetryEnabled).toBe(false);
      expect(config?.errorReportingEnabled).toBe(true);
    });
  });

  describe('terminal background helpers', () => {
    it('accepts only six-digit hex terminal background colors', () => {
      expect(isValidTerminalBackgroundColor('#101010')).toBe(true);
      expect(isValidTerminalBackgroundColor('#0A0A0A')).toBe(true);
      expect(isValidTerminalBackgroundColor('#abc')).toBe(false);
      expect(isValidTerminalBackgroundColor('#zzzzzz')).toBe(false);
      expect(isValidTerminalBackgroundColor('101010')).toBe(false);
    });

    it('allows terminal background customization only on Komla Dark', () => {
      expect(paletteOverridesTerminalBackground(DEFAULT_PALETTE_ID)).toBe(false);
      expect(paletteOverridesTerminalBackground('frost')).toBe(true);
      expect(paletteOverridesTerminalBackground('nord')).toBe(true);
      expect(paletteOverridesTerminalBackground('github-light')).toBe(true);
      expect(paletteOverridesTerminalBackground('custom')).toBe(true);
    });
  });
});
