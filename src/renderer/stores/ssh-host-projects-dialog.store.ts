import { create } from 'zustand';

interface SshHostProjectsDialogState {
  open: boolean;
  /** The SSH host whose projects the dialog offers. */
  hostId: string | null;
  openFor: (hostId: string) => void;
  close: () => void;
}

// Lives outside the SSH host dialog and settings, which may close as it opens.
export const useSshHostProjectsDialogStore = create<SshHostProjectsDialogState>((set) => ({
  open: false,
  hostId: null,
  openFor: (hostId) => set({ open: true, hostId }),
  close: () => set({ open: false }),
}));
