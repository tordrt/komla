import { create } from 'zustand';

export interface RebaseWorkspace {
  id: string;
  workingDirectory: string;
  projectId?: string | null;
}

interface RebaseAbortState {
  /** The workspace whose paused rebase the user asked to abort, waiting for confirmation. */
  pending: RebaseWorkspace | null;
  requestAbort: (workspace: RebaseWorkspace) => void;
  dismiss: () => void;
}

export const useRebaseAbortStore = create<RebaseAbortState>((set) => ({
  pending: null,

  requestAbort: ({ id, workingDirectory, projectId }) => {
    set({ pending: { id, workingDirectory, projectId } });
  },

  dismiss: () => {
    set({ pending: null });
  },
}));
