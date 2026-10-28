import { create } from 'zustand';

import { moveItem } from '../../shared/lib/move-item';

import type { ActivePresetEntry, AgentPreset } from '../types';

interface AgentPresetsState {
  presets: AgentPreset[];
  templates: Omit<AgentPreset, 'id'>[];
  activePreset: AgentPreset | null;
  activePresets: ActivePresetEntry[];
  isLoading: boolean;
  error: string | null;

  // Actions
  loadPresets: () => Promise<void>;
  loadTemplates: () => Promise<void>;
  getPreset: (id: string) => Promise<AgentPreset | undefined>;
  setActivePreset: (id: string, launchModeId?: string | null) => Promise<void>;
  addActivePreset: (id: string) => Promise<void>;
  removeActivePreset: (id: string) => Promise<void>;
  createPreset: (preset: Omit<AgentPreset, 'id'>) => Promise<AgentPreset>;
  // Creates and activates the presets, the first as the most recently used.
  createActivePresets: (presets: Omit<AgentPreset, 'id'>[]) => Promise<AgentPreset[]>;
  updatePreset: (id: string, updates: Partial<Omit<AgentPreset, 'id'>>) => Promise<AgentPreset>;
  deletePreset: (id: string) => Promise<void>;
  reorderPreset: (id: string, newOrder: number) => Promise<void>;
  subscribeToChanges: () => () => void;
}

export const useAgentPresetsStore = create<AgentPresetsState>((set, get) => ({
  presets: [],
  templates: [],
  activePreset: null,
  activePresets: [],
  isLoading: false,
  error: null,

  loadTemplates: async () => {
    try {
      const templates = await window.api.getPresetTemplates();
      set({ templates });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  loadPresets: async () => {
    set({ isLoading: true, error: null });
    try {
      const [presets, activePreset, activePresets] = await Promise.all([
        window.api.getPresets(),
        window.api.getActivePreset(),
        window.api.getActivePresets(),
      ]);
      set({
        presets,
        activePreset: activePreset || null,
        activePresets,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: (error as Error).message,
        isLoading: false,
      });
    }
  },

  getPreset: async (id: string) => {
    try {
      return await window.api.getPreset(id);
    } catch (error) {
      set({ error: (error as Error).message });
      return undefined;
    }
  },

  setActivePreset: async (id: string, launchModeId?: string | null) => {
    try {
      await window.api.setActivePreset(id, launchModeId);
      const preset = get().presets.find((p) => p.id === id);
      const now = Date.now();
      set((state) => {
        const existing = state.activePresets.find((entry) => entry.presetId === id);
        return {
          activePreset: preset || null,
          activePresets: existing
            ? state.activePresets.map((entry) =>
                entry.presetId === id
                  ? {
                      ...entry,
                      lastUsedAt: now,
                      ...(launchModeId !== undefined ? { lastLaunchModeId: launchModeId } : {}),
                    }
                  : entry
              )
            : [
                ...state.activePresets,
                {
                  presetId: id,
                  lastUsedAt: now,
                  ...(launchModeId !== undefined ? { lastLaunchModeId: launchModeId } : {}),
                },
              ],
        };
      });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  addActivePreset: async (id: string) => {
    try {
      await window.api.addActivePreset(id);
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  removeActivePreset: async (id: string) => {
    try {
      await window.api.removeActivePreset(id);
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  createPreset: async (preset) => {
    try {
      const newPreset = await window.api.createPreset(preset);
      set((state) => ({
        presets: [...state.presets, newPreset],
      }));
      return newPreset;
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  createActivePresets: async (presets) => {
    try {
      const created = await window.api.createActivePresets(presets);
      await get().loadPresets();
      return created;
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  updatePreset: async (id, updates) => {
    try {
      const updatedPreset = await window.api.updatePreset(id, updates);
      set((state) => ({
        presets: state.presets.map((p) => (p.id === id ? updatedPreset : p)),
        activePreset: state.activePreset?.id === id ? updatedPreset : state.activePreset,
      }));
      return updatedPreset;
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  deletePreset: async (id) => {
    try {
      await window.api.deletePreset(id);
      set((state) => {
        const presets = state.presets.filter((preset) => preset.id !== id);
        const activePresets = state.activePresets.filter((entry) => entry.presetId !== id);
        const fallbackEntry = activePresets.reduce<ActivePresetEntry | undefined>(
          (latest, entry) => (!latest || entry.lastUsedAt > latest.lastUsedAt ? entry : latest),
          undefined
        );
        return {
          presets,
          activePresets,
          activePreset:
            state.activePreset?.id === id
              ? (presets.find((preset) => preset.id === fallbackEntry?.presetId) ?? null)
              : state.activePreset,
        };
      });
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  reorderPreset: async (id, newOrder) => {
    const state = get();
    const sourceIndex = state.presets.findIndex((preset) => preset.id === id);
    const reordered = moveItem(state.presets, sourceIndex, newOrder);
    if (reordered === state.presets) return;
    set({ presets: reordered });

    try {
      await window.api.reorderPreset(id, newOrder);
    } catch (error) {
      set({ presets: state.presets, error: (error as Error).message });
      throw error;
    }
  },

  subscribeToChanges: () => {
    // Subscribe to external changes (file watcher hot-reload)
    const unsubscribe = window.api.onAgentPresetsChange((data) => {
      set({
        presets: data.presets,
        activePreset: data.activePreset,
        activePresets: data.activePresets ?? [],
      });
    });
    return unsubscribe;
  },
}));
