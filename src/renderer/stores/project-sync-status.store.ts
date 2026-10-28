import { create } from 'zustand';

export interface ProjectSyncStatus {
  projectId: string;
  hasRemote: boolean;
  behindRemote: number;
  aheadRemote: number;
  lastFetched: number | null;
  mainBranch: string;
  defaultBranch: string;
  isFetching: boolean;
}

interface ProjectSyncStatusState {
  statuses: Map<string, ProjectSyncStatus>;
  isLoading: boolean;

  // Actions
  loadAllStatuses: () => Promise<void>;
  refreshStatus: (projectId: string, skipFetch?: boolean) => Promise<void>;
  getStatus: (projectId: string) => ProjectSyncStatus | undefined;
  updateFromWorkspaceStatus: (
    projectId: string,
    data: {
      hasRemote: boolean;
      aheadRemote: number;
      behindRemote: number;
      mainBranch: string;
      defaultBranch: string;
    }
  ) => void;
}

export const useProjectSyncStatusStore = create<ProjectSyncStatusState>((set, get) => ({
  statuses: new Map(),
  isLoading: false,

  loadAllStatuses: async () => {
    set({ isLoading: true });
    try {
      const results = await window.api.getAllProjectSyncStatuses();
      const newStatuses = new Map<string, ProjectSyncStatus>();

      for (const result of results) {
        newStatuses.set(result.projectId, {
          ...result,
          defaultBranch: result.mainBranch,
          isFetching: false,
        });
      }

      set({ statuses: newStatuses, isLoading: false });
    } catch (error) {
      console.error('Failed to load project sync statuses:', error);
      set({ isLoading: false });
    }
  },

  refreshStatus: async (projectId: string, skipFetch?: boolean) => {
    // Mark as fetching
    set((state) => {
      const newStatuses = new Map(state.statuses);
      const existing = newStatuses.get(projectId);
      if (existing) {
        newStatuses.set(projectId, { ...existing, isFetching: true });
      } else {
        newStatuses.set(projectId, {
          projectId,
          hasRemote: false,
          behindRemote: 0,
          aheadRemote: 0,
          lastFetched: null,
          mainBranch: 'main',
          defaultBranch: 'main',
          isFetching: true,
        });
      }
      return { statuses: newStatuses };
    });

    try {
      const result = await window.api.refreshProjectSyncStatus(projectId, skipFetch);
      if (result) {
        set((state) => {
          const newStatuses = new Map(state.statuses);
          const existing = newStatuses.get(projectId);
          newStatuses.set(result.projectId, {
            ...result,
            defaultBranch: existing?.defaultBranch ?? result.mainBranch,
            isFetching: false,
          });
          return { statuses: newStatuses };
        });
      } else {
        // Clear fetching state on null result
        set((state) => {
          const newStatuses = new Map(state.statuses);
          const existing = newStatuses.get(projectId);
          if (existing) {
            newStatuses.set(projectId, { ...existing, isFetching: false });
          }
          return { statuses: newStatuses };
        });
      }
    } catch (error) {
      console.error(`Failed to refresh sync status for project ${projectId}:`, error);
      // Clear fetching state on error
      set((state) => {
        const newStatuses = new Map(state.statuses);
        const existing = newStatuses.get(projectId);
        if (existing) {
          newStatuses.set(projectId, { ...existing, isFetching: false });
        }
        return { statuses: newStatuses };
      });
    }
  },

  getStatus: (projectId: string) => {
    return get().statuses.get(projectId);
  },

  updateFromWorkspaceStatus: (projectId, data) => {
    set((state) => {
      const newStatuses = new Map(state.statuses);
      const existing = newStatuses.get(projectId);
      newStatuses.set(projectId, {
        projectId,
        aheadRemote: data.aheadRemote,
        behindRemote: data.behindRemote,
        hasRemote: data.hasRemote,
        mainBranch: data.mainBranch,
        defaultBranch: data.defaultBranch,
        lastFetched: existing?.lastFetched ?? null,
        isFetching: existing?.isFetching ?? false,
      });
      return { statuses: newStatuses };
    });
  },
}));
