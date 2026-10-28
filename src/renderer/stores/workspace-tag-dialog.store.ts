import { create } from 'zustand';

interface WorkspaceTagDialogState {
  open: boolean;
  /** The workspaces the new tag goes on. */
  workspaceIds: readonly string[];
  openFor: (workspaceIds: readonly string[]) => void;
  close: () => void;
}

// Lives outside the menus, which close as the dialog opens, so every Tag ▸ New Tag... reaches
// one dialog.
export const useWorkspaceTagDialogStore = create<WorkspaceTagDialogState>((set) => ({
  open: false,
  workspaceIds: [],
  openFor: (workspaceIds) => set({ open: true, workspaceIds }),
  close: () => set({ open: false }),
}));
