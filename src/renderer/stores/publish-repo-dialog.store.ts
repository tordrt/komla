import { create } from 'zustand';

import type { SshProjectNeedsRemote } from '../../shared/types/workspace';

/** A project that needs a Git remote before the workspace being created can start. */
export interface PublishRepoDialogRequest extends SshProjectNeedsRemote {
  /** Runs once the project has a remote, e.g. to create the SSH workspace again. */
  onPublished?: () => void;
}

interface PublishRepoDialogState {
  open: boolean;
  request: PublishRepoDialogRequest | null;
  /** Counts requests, so each one starts the dialog afresh. */
  requestId: number;
  openForProject: (request: PublishRepoDialogRequest) => void;
  close: () => void;
}

// Lives outside the components that create workspaces, so every create entry point reaches
// one dialog.
export const usePublishRepoDialogStore = create<PublishRepoDialogState>((set) => ({
  open: false,
  request: null,
  requestId: 0,
  openForProject: (request) =>
    set((state) => ({ open: true, request, requestId: state.requestId + 1 })),
  close: () => set({ open: false }),
}));
