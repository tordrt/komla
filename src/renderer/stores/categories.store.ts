import { create } from 'zustand';

import type { Category } from '../types';

interface CategoriesState {
  categories: Category[];
  expandedIds: Set<string>;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadCategories: () => Promise<void>;
  createCategory: (name: string, parentId?: string) => Promise<Category>;
  updateCategory: (id: string, updates: Partial<Category>) => Promise<void>;
  deleteCategory: (id: string) => Promise<void>;
  toggleExpanded: (id: string) => void;
  setExpanded: (id: string, expanded: boolean) => void;
  subscribeToChanges: () => () => void;
}

export const useCategoriesStore = create<CategoriesState>((set, _get) => ({
  categories: [],
  expandedIds: new Set(),
  isLoading: false,
  error: null,

  loadCategories: async () => {
    set({ isLoading: true, error: null });
    try {
      const categories = await window.api.getCategories();
      set({ categories, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  createCategory: async (name, parentId) => {
    try {
      const category = await window.api.createCategory(name, parentId);
      set((state) => ({
        categories: [...state.categories, category],
      }));
      return category;
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  updateCategory: async (id, updates) => {
    try {
      const category = await window.api.updateCategory(id, updates);
      set((state) => ({
        categories: state.categories.map((c) => (c.id === id ? category : c)),
      }));
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  deleteCategory: async (id) => {
    try {
      await window.api.deleteCategory(id);
      set((state) => ({
        categories: state.categories.filter((c) => c.id !== id),
      }));
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  toggleExpanded: (id) => {
    set((state) => {
      const newExpanded = new Set(state.expandedIds);
      if (newExpanded.has(id)) {
        newExpanded.delete(id);
      } else {
        newExpanded.add(id);
      }
      return { expandedIds: newExpanded };
    });
  },

  setExpanded: (id, expanded) => {
    set((state) => {
      const newExpanded = new Set(state.expandedIds);
      if (expanded) {
        newExpanded.add(id);
      } else {
        newExpanded.delete(id);
      }
      return { expandedIds: newExpanded };
    });
  },

  subscribeToChanges: () => {
    // Subscribe to external changes (file watcher hot-reload)
    const unsubscribe = window.api.onCategoriesChange((categories) => {
      set({ categories });
    });
    return unsubscribe;
  },
}));
