import { create } from 'zustand';

interface WorktreeEventsState {
  lastEventByWorkspace: Record<string, number>;
  recordEvent: (workspaceId: string, at?: number) => void;
  clearWorkspace: (workspaceId: string) => void;
}

export const useWorktreeEventsStore = create<WorktreeEventsState>((set) => ({
  lastEventByWorkspace: {},

  recordEvent: (workspaceId, at) => {
    set((state) => ({
      lastEventByWorkspace: {
        ...state.lastEventByWorkspace,
        [workspaceId]: at ?? Date.now(),
      },
    }));
  },

  clearWorkspace: (workspaceId) => {
    set((state) => {
      const next = { ...state.lastEventByWorkspace };
      delete next[workspaceId];
      return { lastEventByWorkspace: next };
    });
  },
}));
