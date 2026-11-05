import { create } from 'zustand';

import { createPaneSurfaceId } from '../../shared/lib/pane-surface-id';

import type { BrowserTabsState } from '../../shared/lib/browser-tabs';
import type { WorkspaceBrowserTab } from '../../shared/types';

export type PaneSurface =
  | {
      kind: 'browser';
      workspaceId: string;
      browserTabs: WorkspaceBrowserTab[];
      activeBrowserTabId: string | undefined;
    }
  | { kind: 'note'; workspaceId: string; name: string }
  | {
      kind: 'file';
      workspaceId: string;
      /** Relative to the workspace's directory. */
      path: string;
      /** Whether the pane's editor has unsaved edits. */
      dirty?: boolean;
      /** The unsaved text, carried only while the workspace moves to another window. */
      draft?: string;
    };

interface PaneSurfacesState {
  /** What each non-terminal pane shows, by surface id. Not saved across restarts. */
  surfaces: Record<string, PaneSurface>;
  /** The surface whose editor takes keyboard focus once its tab shows, until it has. */
  editorFocusRequest: string | null;
  requestEditorFocus: (id: string) => void;
  /** Drops the surface's focus request, leaving another surface's. */
  clearEditorFocusRequest: (id: string) => void;
  /** Adds a surface under a new id, or under `id` when its pane is laid out already. */
  addSurface: (surface: PaneSurface, id?: string) => string;
  setBrowserTabs: (id: string, tabs: BrowserTabsState) => void;
  setFileDirty: (id: string, dirty: boolean) => void;
  setFilePath: (id: string, path: string) => void;
  removeSurface: (id: string) => void;
}

export const usePaneSurfacesStore = create<PaneSurfacesState>((set) => ({
  surfaces: {},
  editorFocusRequest: null,

  requestEditorFocus: (id) => set({ editorFocusRequest: id }),

  clearEditorFocusRequest: (id) => {
    set((state) => (state.editorFocusRequest === id ? { editorFocusRequest: null } : state));
  },

  addSurface: (surface, givenId) => {
    const id = givenId ?? createPaneSurfaceId(surface.kind);
    set((state) => ({ surfaces: { ...state.surfaces, [id]: surface } }));
    return id;
  },

  setBrowserTabs: (id, tabs) => {
    set((state) => {
      const surface = state.surfaces[id];
      if (surface?.kind !== 'browser') return state;
      return { surfaces: { ...state.surfaces, [id]: { ...surface, ...tabs } } };
    });
  },

  setFileDirty: (id, dirty) => {
    set((state) => {
      const surface = state.surfaces[id];
      if (surface?.kind !== 'file' || !!surface.dirty === dirty) return state;
      return { surfaces: { ...state.surfaces, [id]: { ...surface, dirty } } };
    });
  },

  setFilePath: (id, path) => {
    set((state) => {
      const surface = state.surfaces[id];
      if (surface?.kind !== 'file' || surface.path === path) return state;
      return { surfaces: { ...state.surfaces, [id]: { ...surface, path } } };
    });
  },

  removeSurface: (id) => {
    set((state) => {
      if (!state.surfaces[id]) return state;
      const { [id]: _, ...surfaces } = state.surfaces;
      return { surfaces };
    });
  },
}));
