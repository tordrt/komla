import { create } from 'zustand';

import type { WorkspaceObservationProjection } from '@/types';

interface WorkspaceObservationState {
  projections: Map<string, WorkspaceObservationProjection>;
  applyProjection: (projection: WorkspaceObservationProjection) => void;
}

export const useWorkspaceObservationStore = create<WorkspaceObservationState>((set) => ({
  projections: new Map(),
  applyProjection: (projection) => {
    set((state) => {
      const current = state.projections.get(projection.workspaceId);
      if (current && current.revision >= projection.revision) return state;
      const projections = new Map(state.projections);
      projections.set(projection.workspaceId, projection);
      return { projections };
    });
  },
}));
