import { create } from 'zustand';

import type {
  Automation,
  AutomationHostReads,
  AutomationRun,
  AutomationTarget,
  AutomationTargetSnapshot,
  SaveAutomationParams,
} from '../../shared/types/automation';

interface AutomationsState {
  snapshots: AutomationTargetSnapshot[];
  /** The name of the automation whose recent run started each workspace, by workspace id. */
  automationNameByWorkspace: Record<string, string>;
  hasLoaded: boolean;
  error: string | null;

  /** Reads every stale SSH host unless `readHosts` says otherwise. */
  loadAutomations: (options?: { readHosts?: AutomationHostReads }) => Promise<void>;
  saveAutomation: (params: SaveAutomationParams) => Promise<Automation>;
  setAutomationEnabled: (target: AutomationTarget, id: string, enabled: boolean) => Promise<void>;
  deleteAutomation: (target: AutomationTarget, id: string) => Promise<void>;
  runAutomationNow: (target: AutomationTarget, id: string) => Promise<AutomationRun>;
  /** Lists again on every change, reading only the SSH hosts with workspaces here. */
  subscribeToChanges: () => () => void;
}

function indexAutomationNameByWorkspace(
  snapshots: AutomationTargetSnapshot[]
): Record<string, string> {
  const index: Record<string, string> = {};
  for (const snapshot of snapshots) {
    for (const automation of snapshot.automations) {
      for (const run of snapshot.runs[automation.id] ?? []) {
        if (run.workspaceId) index[run.workspaceId] = automation.name;
      }
    }
  }
  return index;
}

// Counts loads, so one that overlapped a later load can't replace the later one's listing.
let latestLoad = 0;

export const useAutomationsStore = create<AutomationsState>((set, get) => ({
  snapshots: [],
  automationNameByWorkspace: {},
  hasLoaded: false,
  error: null,

  loadAutomations: async (options = {}) => {
    const load = ++latestLoad;
    try {
      const snapshots = await window.api.listAutomations(options);
      if (load !== latestLoad) return;
      set({
        snapshots,
        automationNameByWorkspace: indexAutomationNameByWorkspace(snapshots),
        hasLoaded: true,
        error: null,
      });
    } catch (error) {
      if (load !== latestLoad) return;
      set({ hasLoaded: true, error: (error as Error).message });
    }
  },

  saveAutomation: async (params) => {
    const saved = await window.api.saveAutomation(params);
    await get().loadAutomations();
    return saved;
  },

  setAutomationEnabled: async (target, id, enabled) => {
    await window.api.setAutomationEnabled(target, id, enabled);
    await get().loadAutomations();
  },

  deleteAutomation: async (target, id) => {
    await window.api.deleteAutomation(target, id);
    await get().loadAutomations();
  },

  runAutomationNow: async (target, id) => {
    const run = await window.api.runAutomationNow(target, id);
    await get().loadAutomations();
    return run;
  },

  subscribeToChanges: () =>
    window.api.onAutomationsChange(() => {
      void get().loadAutomations({ readHosts: 'in-use' });
    }),
}));
