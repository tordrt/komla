import { create } from 'zustand';

import { useProjectSyncStatusStore } from './project-sync-status.store';

import type { GitBranchQuickStatus } from '../types';

interface CachedStatus {
  status: GitBranchQuickStatus;
  lastFetched: number;
  isLoading: boolean;
  targetStatusScope?: string;
  requestId?: symbol;
  requestScope?: string;
}

interface GitStatusState {
  statusMap: Map<string, CachedStatus>;

  // Actions
  fetchStatus: (
    workspaceId: string,
    workingDir: string,
    projectId?: string | null,
    targetStatusScope?: string
  ) => Promise<GitBranchQuickStatus | undefined>;
  fetchStatusIfStale: (
    workspaceId: string,
    workingDir: string,
    projectId?: string | null,
    maxAgeMs?: number,
    targetStatusScope?: string
  ) => Promise<void>;
  registerTargetStatusScope: (workspaceId: string, targetStatusScope: string) => void;
  invalidateStatus: (workspaceId: string) => void;
  clearBehindTargetBranch: (workspaceId: string, targetBranch: string) => void;
  hydrateStatus: (workspaceId: string, status: GitBranchQuickStatus) => void;
  applyPushedStatus: (
    workspaceId: string,
    status: GitBranchQuickStatus,
    projectId?: string | null,
    targetStatusScope?: string
  ) => void;
  getStatus: (workspaceId: string) => CachedStatus | undefined;
  cleanup: (workspaceId: string) => void;
}

const DEFAULT_MAX_AGE_MS = 10000; // 10 seconds

const DEFAULT_STATUS: GitBranchQuickStatus = {
  behindTargetBranch: 0,
  aheadTargetBranch: 0,
  mainBranch: 'main',
  defaultBranch: 'main',
  hasRemote: false,
  hasOriginRemote: false,
  unpushedCommits: 0,
  behindRemote: 0,
  currentBranch: '',
  targetBranchHasRemote: false,
  targetBranchAheadRemote: 0,
  targetBranchBehindRemote: 0,
};

function applySharedTargetStatus(
  statusMap: Map<string, CachedStatus>,
  workspaceId: string,
  status: GitBranchQuickStatus,
  targetStatusScope: string | undefined
): void {
  if (!targetStatusScope) return;
  for (const [cachedWorkspaceId, cached] of statusMap) {
    if (
      cachedWorkspaceId === workspaceId ||
      cached.targetStatusScope !== targetStatusScope ||
      cached.status.mainBranch !== status.mainBranch
    ) {
      continue;
    }
    statusMap.set(cachedWorkspaceId, {
      ...cached,
      status: {
        ...cached.status,
        targetBranchHasRemote: status.targetBranchHasRemote,
        targetBranchAheadRemote: status.targetBranchAheadRemote,
        targetBranchBehindRemote: status.targetBranchBehindRemote,
      },
    });
  }
}

export const useGitStatusStore = create<GitStatusState>((set, get) => ({
  statusMap: new Map(),

  fetchStatus: async (workspaceId, _workingDir, projectId, targetStatusScope) => {
    const requestId = Symbol(workspaceId);
    // Mark as loading
    set((state) => {
      const newMap = new Map(state.statusMap);
      const existing = newMap.get(workspaceId);
      const resolvedScope = targetStatusScope ?? existing?.targetStatusScope;
      newMap.set(workspaceId, {
        status: existing?.status ?? DEFAULT_STATUS,
        lastFetched: existing?.lastFetched ?? 0,
        isLoading: true,
        targetStatusScope: resolvedScope,
        requestId,
        requestScope: resolvedScope,
      });
      return { statusMap: newMap };
    });

    try {
      const status = await window.api.getWorkspaceGitBranchStatus(
        workspaceId,
        projectId ?? undefined
      );
      let accepted = false;
      set((state) => {
        const newMap = new Map(state.statusMap);
        const existing = newMap.get(workspaceId);
        if (existing?.requestId !== requestId) return state;
        if (existing.targetStatusScope !== existing.requestScope) {
          newMap.set(workspaceId, {
            ...existing,
            isLoading: false,
            requestId: undefined,
            requestScope: undefined,
          });
          return { statusMap: newMap };
        }
        accepted = true;
        const resolvedScope = existing.targetStatusScope;
        newMap.set(workspaceId, {
          status,
          lastFetched: Date.now(),
          isLoading: false,
          targetStatusScope: resolvedScope,
        });

        applySharedTargetStatus(newMap, workspaceId, status, resolvedScope);
        return { statusMap: newMap };
      });

      if (!accepted) return undefined;

      // Feed project-level fields to the project sync status store.
      // These values are shared across all workspaces of the same project.
      if (projectId) {
        useProjectSyncStatusStore.getState().updateFromWorkspaceStatus(projectId, {
          hasRemote: status.targetBranchHasRemote,
          aheadRemote: status.targetBranchAheadRemote,
          behindRemote: status.targetBranchBehindRemote,
          mainBranch: status.mainBranch,
          defaultBranch: status.defaultBranch,
        });
      }

      return status;
    } catch (error) {
      console.error('Failed to fetch git status:', error);
      set((state) => {
        const newMap = new Map(state.statusMap);
        const existing = newMap.get(workspaceId);
        if (existing?.requestId === requestId) {
          newMap.set(workspaceId, {
            ...existing,
            isLoading: false,
            requestId: undefined,
            requestScope: undefined,
          });
        }
        return { statusMap: newMap };
      });
      return undefined;
    }
  },

  fetchStatusIfStale: async (workspaceId, workingDir, projectId, maxAgeMs, targetStatusScope) => {
    const state = get();
    const cached = state.statusMap.get(workspaceId);
    const requestedScope = targetStatusScope ?? cached?.targetStatusScope;

    // A target-scope change supersedes an older in-flight request.
    if (cached?.isLoading && cached.requestScope === requestedScope) {
      return;
    }

    // Remote Companion observations are push-based. Once an SSH workspace has a
    // snapshot, automatic UI refreshes must not turn into direct SSH polling.
    if (cached && workingDir.startsWith('ssh://')) return;

    // Fetch if no cache or stale
    const effectiveMaxAgeMs = maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (
      !cached ||
      (targetStatusScope !== undefined && cached.targetStatusScope !== targetStatusScope) ||
      Date.now() - cached.lastFetched > effectiveMaxAgeMs
    ) {
      await state.fetchStatus(workspaceId, workingDir, projectId, targetStatusScope);
    }
  },

  registerTargetStatusScope: (workspaceId, targetStatusScope) => {
    set((state) => {
      const existing = state.statusMap.get(workspaceId);
      if (!existing || existing.targetStatusScope === targetStatusScope) return state;

      const newMap = new Map(state.statusMap);
      newMap.set(workspaceId, {
        ...existing,
        lastFetched: existing.targetStatusScope === undefined ? existing.lastFetched : 0,
        targetStatusScope,
      });
      let freshest = newMap.get(workspaceId)!;
      let freshestWorkspaceId = workspaceId;
      for (const [candidateWorkspaceId, candidate] of newMap) {
        if (
          candidate.targetStatusScope === targetStatusScope &&
          candidate.status.mainBranch === existing.status.mainBranch &&
          candidate.lastFetched > freshest.lastFetched
        ) {
          freshest = candidate;
          freshestWorkspaceId = candidateWorkspaceId;
        }
      }
      applySharedTargetStatus(newMap, freshestWorkspaceId, freshest.status, targetStatusScope);
      return { statusMap: newMap };
    });
  },

  invalidateStatus: (workspaceId) => {
    set((state) => {
      const newMap = new Map(state.statusMap);
      const existing = newMap.get(workspaceId);
      if (existing) {
        newMap.set(workspaceId, {
          ...existing,
          lastFetched: 0,
          isLoading: false,
          requestId: undefined,
          requestScope: undefined,
        });
      }
      return { statusMap: newMap };
    });
  },

  clearBehindTargetBranch: (workspaceId, targetBranch) => {
    set((state) => {
      const existing = state.statusMap.get(workspaceId);
      if (!existing || existing.status.mainBranch !== targetBranch) return state;

      const newMap = new Map(state.statusMap);
      newMap.set(workspaceId, {
        ...existing,
        status: { ...existing.status, behindTargetBranch: 0 },
        // Discard pre-sync requests; the next refresh or observation reconciles the count.
        isLoading: false,
        requestId: undefined,
        requestScope: undefined,
      });
      return { statusMap: newMap };
    });
  },

  hydrateStatus: (workspaceId, status) => {
    set((state) => {
      if (state.statusMap.has(workspaceId)) return state;
      const newMap = new Map(state.statusMap);
      // Give a reconnecting Remote Companion time to replace the persisted snapshot
      // before stale-cache polling falls back to a direct SSH Git probe.
      newMap.set(workspaceId, { status, lastFetched: Date.now(), isLoading: false });
      return { statusMap: newMap };
    });
  },

  applyPushedStatus: (workspaceId, status, projectId, targetStatusScope) => {
    set((state) => {
      const newMap = new Map(state.statusMap);
      const existing = newMap.get(workspaceId);
      const resolvedScope = targetStatusScope ?? existing?.targetStatusScope;
      newMap.set(workspaceId, {
        status,
        lastFetched: Date.now(),
        isLoading: false,
        targetStatusScope: resolvedScope,
        requestId: undefined,
        requestScope: undefined,
      });

      applySharedTargetStatus(newMap, workspaceId, status, resolvedScope);
      return { statusMap: newMap };
    });

    if (projectId) {
      useProjectSyncStatusStore.getState().updateFromWorkspaceStatus(projectId, {
        hasRemote: status.targetBranchHasRemote,
        aheadRemote: status.targetBranchAheadRemote,
        behindRemote: status.targetBranchBehindRemote,
        mainBranch: status.mainBranch,
        defaultBranch: status.defaultBranch,
      });
    }
  },

  getStatus: (workspaceId) => {
    return get().statusMap.get(workspaceId);
  },

  cleanup: (workspaceId) => {
    set((state) => {
      const newMap = new Map(state.statusMap);
      newMap.delete(workspaceId);
      return { statusMap: newMap };
    });
  },
}));
