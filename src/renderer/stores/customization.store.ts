import { create } from 'zustand';

import type { ThemeConfig, TerminalConfig } from '../types';

interface CustomizationState {
  theme: ThemeConfig | null;
  terminalConfig: TerminalConfig | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadCustomization: () => Promise<void>;
  updateTheme: (updates: Partial<ThemeConfig>) => Promise<void>;
  updateTerminalConfig: (updates: Partial<TerminalConfig>) => Promise<void>;
  resetTheme: () => Promise<void>;
  subscribeToChanges: () => () => void;
}

export const useCustomizationStore = create<CustomizationState>((set, _get) => ({
  theme: null,
  terminalConfig: null,
  isLoading: false,
  error: null,

  loadCustomization: async () => {
    set({ isLoading: true, error: null });
    try {
      const [theme, terminalConfig] = await Promise.all([
        window.api.getTheme(),
        window.api.getTerminalConfig(),
      ]);
      set({
        theme,
        terminalConfig,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: (error as Error).message,
        isLoading: false,
      });
    }
  },

  updateTheme: async (updates) => {
    try {
      const theme = await window.api.updateTheme(updates);
      set({ theme });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  updateTerminalConfig: async (updates) => {
    try {
      const terminalConfig = await window.api.updateTerminalConfig(updates);
      set({ terminalConfig });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  resetTheme: async () => {
    try {
      const theme = await window.api.resetTheme();
      set({ theme });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  subscribeToChanges: () => {
    const unsubTheme = window.api.onThemeChange((theme) => {
      set({ theme });
    });

    const unsubTerminal = window.api.onTerminalConfigChange((terminalConfig) => {
      set({ terminalConfig });
    });

    return () => {
      unsubTheme();
      unsubTerminal();
    };
  },
}));
