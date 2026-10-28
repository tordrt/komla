import { create } from 'zustand';

import { moveItem } from '../../shared/lib/move-item';

import type { Action, ActionSshExecutionLocation } from '../types';

interface ActionsState {
  actions: Action[];
  isLoading: boolean;
  error: string | null;

  loadActions: () => Promise<void>;
  createAction: (params: {
    title: string;
    content: string;
    type?: 'prompt' | 'command';
    projectIds?: string[];
    presetId?: string;
    launchModeId?: string;
    sshExecutionLocation?: ActionSshExecutionLocation;
    background?: boolean;
  }) => Promise<Action>;
  updateAction: (
    id: string,
    updates: {
      title?: string;
      content?: string;
      type?: 'prompt' | 'command';
      projectIds?: string[];
      presetId?: string | null;
      launchModeId?: string | null;
      sshExecutionLocation?: ActionSshExecutionLocation | null;
      background?: boolean | null;
    }
  ) => Promise<Action>;
  reorderAction: (id: string, newOrder: number) => Promise<void>;
  deleteAction: (id: string) => Promise<void>;
  /** `pasted` leaves the last use as it was, so the run button's default doesn't move. */
  recordActionUsage: (id: string, userInput?: string, pasted?: boolean) => Promise<Action>;
  subscribeToChanges: () => () => void;
}

export const useActionsStore = create<ActionsState>((set, get) => ({
  actions: [],
  isLoading: false,
  error: null,

  loadActions: async () => {
    set({ isLoading: true, error: null });
    try {
      const actions = await window.api.listActions();
      set({ actions, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  createAction: async (params) => {
    try {
      const created = await window.api.createAction(params);
      set((state) => ({ actions: [...state.actions, created] }));
      return created;
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  updateAction: async (id, updates) => {
    try {
      const updated = await window.api.updateAction(id, updates);
      set((state) => ({
        actions: state.actions.map((action) => (action.id === id ? updated : action)),
      }));
      return updated;
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  reorderAction: async (id, newOrder) => {
    const sourceActions = get().actions;
    const sourceIndex = sourceActions.findIndex((action) => action.id === id);
    const reordered = moveItem(sourceActions, sourceIndex, newOrder);
    if (reordered === sourceActions) return;

    set({ actions: reordered });
    try {
      await window.api.reorderAction(id, newOrder);
    } catch (error) {
      set({ actions: sourceActions, error: (error as Error).message });
      throw error;
    }
  },

  deleteAction: async (id) => {
    try {
      await window.api.deleteAction(id);
      set((state) => ({
        actions: state.actions.filter((action) => action.id !== id),
      }));
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  recordActionUsage: async (id, userInput, pasted) => {
    try {
      const updated = await window.api.recordActionUsage(id, userInput, pasted);
      set((state) => ({
        actions: state.actions.map((action) => (action.id === id ? updated : action)),
      }));
      return updated;
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  subscribeToChanges: () => {
    const unsubscribe = window.api.onActionsChange((actions) => {
      set({ actions });
    });
    return unsubscribe;
  },
}));
