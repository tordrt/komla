import { create } from 'zustand';

import { useConfigStore } from './config.store';

import type { SshHost } from '@/types';

interface SshHostsState {
  hosts: SshHost[];
  isLoading: boolean;
  hasLoaded: boolean;
  error: string | null;
  pendingSetupDismissed: boolean;
  loadHosts: () => Promise<void>;
  saveHost: (host: SshHost) => Promise<{ ok: boolean; error: string | null }>;
  beginPendingSetup: () => void;
  completePendingSetup: () => Promise<void>;
  subscribeToChanges: () => () => void;
  deleteHost: (
    hostId: string,
    options?: { deleteRemoteData?: boolean }
  ) => Promise<{ deletedWorkspaceIds: string[] }>;
}

let hostsLoadPromise: Promise<void> | null = null;

export const useSshHostsStore = create<SshHostsState>((set, get) => ({
  hosts: [],
  isLoading: false,
  hasLoaded: false,
  error: null,
  pendingSetupDismissed: false,

  loadHosts: () => {
    if (hostsLoadPromise) return hostsLoadPromise;
    hostsLoadPromise = (async () => {
      set({ isLoading: true, error: null });
      try {
        const hosts = await window.api.listSshHosts();
        set({ hosts, isLoading: false, hasLoaded: true, error: null });
      } catch (error) {
        set({ isLoading: false, hasLoaded: false, error: (error as Error).message });
      } finally {
        hostsLoadPromise = null;
      }
    })();
    return hostsLoadPromise;
  },

  saveHost: async (host) => {
    try {
      const wasPending =
        host.setupPending ||
        get().hosts.some((candidate) => candidate.id === host.id && candidate.setupPending);
      let saved = await window.api.saveSshHost(host);
      if (saved.setupPending && get().pendingSetupDismissed) {
        saved = await window.api.saveSshHost({ ...saved, setupPending: false });
      }
      // New workspaces start on a host once its first-time setup completes.
      if (wasPending && !saved.setupPending) {
        void useConfigStore.getState().updateConfig({
          lastWorkspaceEnvironment: { kind: 'ssh', hostId: saved.id },
        });
      }
      set((state) => {
        const exists = state.hosts.some((candidate) => candidate.id === saved.id);
        return {
          hosts: exists
            ? state.hosts.map((candidate) => (candidate.id === saved.id ? saved : candidate))
            : [...state.hosts, saved],
          hasLoaded: true,
          error: null,
        };
      });
      return { ok: true, error: null };
    } catch (error) {
      const message = (error as Error).message;
      set({ error: message });
      return { ok: false, error: message };
    }
  },

  beginPendingSetup: () => {
    set({ pendingSetupDismissed: false });
  },

  completePendingSetup: async () => {
    set({ pendingSetupDismissed: true });
    const pendingHost = get().hosts.find((host) => host.setupPending);
    if (!pendingHost) return;
    await get().saveHost({ ...pendingHost, setupPending: false });
  },

  subscribeToChanges: () => {
    return window.api.onSshHostsChange((hosts) => {
      set({ hosts, hasLoaded: true, error: null });
    });
  },

  deleteHost: async (hostId, options) => {
    const result = await window.api.deleteSshHost(hostId, options);
    set((state) => ({
      hosts: state.hosts.filter((host) => host.id !== hostId),
      hasLoaded: true,
      error: null,
    }));
    return result;
  },
}));
