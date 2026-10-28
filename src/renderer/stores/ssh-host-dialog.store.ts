import { create } from 'zustand';

import { useSshHostsStore } from './ssh-hosts.store';

import type { SshConfigHost, SshHostAddedSource } from '../../shared/types/ssh';

/** What the SSH host dialog opens for. */
export type SshHostDialogRequest =
  | {
      kind: 'add';
      /** Where adding started, reported with `ssh_host_added`. */
      source: SshHostAddedSource;
      /** Called once the host is set up, e.g. to pick it for the workspace being created. */
      onAdded?: (hostId: string) => void;
      /** A ~/.ssh/config entry the form starts from. */
      configHost?: SshConfigHost;
    }
  | { kind: 'edit'; hostId: string }
  /** The agent integrations step of a host whose first-time setup was interrupted. */
  | { kind: 'ready'; hostId: string };

interface SshHostDialogState {
  open: boolean;
  request: SshHostDialogRequest | null;
  /** Counts requests, so each one starts the dialog afresh. */
  requestId: number;
  openAdd: (
    source: SshHostAddedSource,
    options?: { onAdded?: (hostId: string) => void; configHost?: SshConfigHost }
  ) => void;
  openEdit: (hostId: string) => void;
  openReady: (hostId: string) => void;
  close: () => void;
}

// Lives outside the components that open it, so the status bar, New Workspace, Tips and
// Settings all reach one dialog.
export const useSshHostDialogStore = create<SshHostDialogState>((set) => {
  const show = (request: SshHostDialogRequest) =>
    set((state) => ({ open: true, request, requestId: state.requestId + 1 }));
  return {
    open: false,
    request: null,
    requestId: 0,
    openAdd: (source, options) =>
      show({ kind: 'add', source, onAdded: options?.onAdded, configHost: options?.configHost }),
    openEdit: (hostId) => show({ kind: 'edit', hostId }),
    openReady: (hostId) => show({ kind: 'ready', hostId }),
    close: () => {
      // The closed dialog stays mounted, but no longer needs its opener's callback.
      set((state) => ({
        open: false,
        request:
          state.request?.kind === 'add' ? { ...state.request, onAdded: undefined } : state.request,
      }));
      // However the dialog closes, a first host's setup is over.
      void useSshHostsStore.getState().completePendingSetup();
    },
  };
});
