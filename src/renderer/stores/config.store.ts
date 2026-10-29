import { create } from 'zustand';

import { DEFAULT_ACTIVITY_SPINNER } from '../../shared/lib/activity-spinner';
import { DEFAULT_REMOTE_PASSKEY_WINDOW_MINUTES } from '../../shared/lib/remote-passkey-window';

import type { AppConfig, UtilityOpenRouterKeyStatus } from '../types';

interface ConfigState {
  config: AppConfig | null;
  isLoading: boolean;
  error: string | null;
  hasProjects: boolean;
  openRouterKeyStatus: UtilityOpenRouterKeyStatus | null;
  openRouterKeyStatusLoading: boolean;
  openRouterKeyStatusError: string | null;

  // Actions
  loadConfig: () => Promise<void>;
  updateConfig: (updates: Partial<AppConfig>) => Promise<{ ok: boolean; error: string | null }>;
  subscribeToChanges: () => () => void;
  loadOpenRouterKeyStatus: () => Promise<void>;
  saveOpenRouterApiKey: (apiKey: string) => Promise<boolean>;
  clearOpenRouterApiKey: () => Promise<boolean>;
  setDiffHideUnchangedRegions: (value: boolean) => Promise<void>;
  selectDirectory: () => Promise<string | null>;
}

const DEFAULT_CONFIG: AppConfig = {
  agentSetupComplete: false,
  scrollbackLines: 10000,
  theme: 'system',
  defaultProjectId: null,
  notificationsEnabled: false,
  notificationPort: 53724,
  utilityProvider: 'komla-managed',
  openRouterModel: 'anthropic/claude-haiku-5.5',
  openRouterBaseUrl: 'https://openrouter.ai/api/v1',
  defaultFileTreeOpen: false,
  defaultFileTreeMode: 'diff',
  defaultLiveFollow: false,
  defaultCompareTargetBranch: false,
  defaultDevServerPreviewAutoReload: true,
  webLinkOpenTarget: 'external',
  directRemoteKeepAwake: false,
  directRemoteLocalAccess: true,
  directRemotePasskeyWindowMinutes: DEFAULT_REMOTE_PASSKEY_WINDOW_MINUTES,
  workspaceGrouping: 'project',
  hideStoppedWorkspaces: false,
  hideWorkingWorkspaces: false,
  remoteBranchesExpanded: false,
  diffHideUnchangedRegions: true,
  anonymousTelemetryEnabled: true,
  usageTelemetryEnabled: false,
  usageTelemetryConsentAnswered: false,
  errorReportingEnabled: true,
  hideBranchNameInWorkspaceCards: false,
  compactWorkspaceList: false,
  showAgentSpinner: true,
  activitySpinner: DEFAULT_ACTIVITY_SPINNER,
  reduceEffects: false,
  holdToQuit: false,
  selfIntegrationTipCreated: false,
  selfIntegrationTipCompleted: false,
  notificationsNudgePending: false,
  selfSetupNudgePending: false,
  tipsIntroPending: false,
};

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  isLoading: true,
  error: null,
  hasProjects: false,
  openRouterKeyStatus: null,
  openRouterKeyStatusLoading: false,
  openRouterKeyStatusError: null,

  loadConfig: async () => {
    const isInitialLoad = get().config === null;
    set({
      isLoading: isInitialLoad,
      error: null,
      openRouterKeyStatusLoading: true,
      openRouterKeyStatusError: null,
    });
    try {
      const [config, hasProjects, openRouterKeyStatusResult] = await Promise.all([
        window.api.getConfig(),
        window.api.hasProjects(),
        window.api
          .getOpenRouterKeyStatus()
          .then((status) => ({ error: null, status }))
          .catch((error) => ({
            error: (error as Error).message,
            status: null,
          })),
      ]);
      set({
        config,
        isLoading: false,
        hasProjects,
        openRouterKeyStatus: openRouterKeyStatusResult.status,
        openRouterKeyStatusLoading: false,
        openRouterKeyStatusError: openRouterKeyStatusResult.error,
      });
    } catch (error) {
      set({
        error: (error as Error).message,
        isLoading: false,
        config: DEFAULT_CONFIG,
        openRouterKeyStatus: null,
        openRouterKeyStatusLoading: false,
        openRouterKeyStatusError: null,
      });
    }
  },

  updateConfig: async (updates) => {
    try {
      const config = await window.api.updateConfig(updates);
      // Clear any stale error from a previous failed update so the store's
      // `error` field always reflects the latest state, never a carry-over.
      set({ config, error: null });
      return { ok: true, error: null };
    } catch (error) {
      const message = (error as Error).message;
      set({ error: message });
      return { ok: false, error: message };
    }
  },

  subscribeToChanges: () => {
    return window.api.onConfigChanged((config) => set({ config }));
  },

  loadOpenRouterKeyStatus: async () => {
    set({
      openRouterKeyStatusLoading: true,
      openRouterKeyStatusError: null,
    });
    try {
      const openRouterKeyStatus = await window.api.getOpenRouterKeyStatus();
      set({
        openRouterKeyStatus,
        openRouterKeyStatusLoading: false,
        openRouterKeyStatusError: null,
      });
    } catch (error) {
      set({
        openRouterKeyStatus: null,
        openRouterKeyStatusLoading: false,
        openRouterKeyStatusError: (error as Error).message,
      });
    }
  },

  saveOpenRouterApiKey: async (apiKey) => {
    try {
      await window.api.saveOpenRouterApiKey(apiKey);
      await get().loadOpenRouterKeyStatus();
      return true;
    } catch (error) {
      set({ error: (error as Error).message });
      return false;
    }
  },

  clearOpenRouterApiKey: async () => {
    try {
      await window.api.clearOpenRouterApiKey();
      await get().loadOpenRouterKeyStatus();
      return true;
    } catch (error) {
      set({ error: (error as Error).message });
      return false;
    }
  },

  setDiffHideUnchangedRegions: async (value: boolean) => {
    await get().updateConfig({ diffHideUnchangedRegions: value });
  },

  selectDirectory: async () => {
    try {
      return await window.api.selectDirectory();
    } catch (err) {
      const message = (err as Error).message;
      // Electron wraps thrown IPC handler errors as:
      //   "Error invoking remote method 'X': Error: <original>"
      // Strip that wrapper so the original message can be displayed as-is.
      const match = message.match(/^Error invoking remote method '[^']+': (?:Error: )?(.+)$/s);
      throw new Error(match ? match[1] : message);
    }
  },
}));
