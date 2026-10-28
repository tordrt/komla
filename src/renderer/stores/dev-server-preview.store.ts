import { create } from 'zustand';

import { getBrowserIdOfTab, isPaneSurfaceId } from '../../shared/lib/pane-surface-id';

import { usePaneSurfacesStore } from './pane-surfaces.store';

import type { SshPreviewForward, SshPreviewScheme } from '../types';

// The SSH tunnel of the browser tab on screen. Each tab has its own, which keeps running while
// another tab is shown.
interface DevServerRemoteForwardSlot {
  status: 'pending' | 'starting' | 'active' | 'failed' | 'stopping' | 'stopped';
  /** The browser tab the tunnel serves. */
  tabId: string;
  forward?: SshPreviewForward;
  remotePort?: number;
  pathSuffix?: string;
  scheme?: SshPreviewScheme;
  error?: string;
  // The workspace's saved preview URL this tunnel belongs to. The preview
  // forwards the saved URL on its own only when it differs from this.
  savedUrl?: string;
  requestId: number;
}

let nextForwardRequestId = 0;

function stoppedForwardSlot(
  current: DevServerRemoteForwardSlot,
  requestId: number
): DevServerRemoteForwardSlot {
  const { tabId, remotePort, pathSuffix, scheme, savedUrl } = current;
  return { status: 'stopped', tabId, remotePort, pathSuffix, scheme, savedUrl, requestId };
}

interface DevServerPreviewState {
  // Reload keys, probe keys and tunnels belong to a browser pane, under its
  // surface id (see getBrowserIdOfTab).
  reloadKeyByWorkspace: Record<string, number>;
  probeKeyByWorkspace: Record<string, number>;
  autoReloadByWorkspace: Record<string, boolean>;
  remoteForwardByWorkspace: Record<string, DevServerRemoteForwardSlot>;
  /** The forward each tab's page last loaded through, by browser and tab. */
  tabForwardIdsByWorkspace: Record<string, Record<string, string>>;

  bumpReloadKey: (workspaceId: string) => void;
  bumpProbeKey: (workspaceId: string) => void;
  toggleAutoReload: (workspaceId: string, defaultEnabled?: boolean) => void;
  startSshPreviewForward: (
    workspaceId: string,
    tabId: string,
    remotePort: number,
    pathSuffix?: string,
    scheme?: SshPreviewScheme,
    savedUrl?: string
  ) => Promise<void>;
  requestSshPreviewForward: (
    workspaceId: string,
    tabId: string,
    remotePort: number,
    pathSuffix?: string,
    scheme?: SshPreviewScheme,
    savedUrl?: string
  ) => void;
  /** Stops the tunnel of `options.tabId`. */
  stopSshPreviewForward: (
    workspaceId: string,
    options?: { keepStopped?: boolean; tabId?: string }
  ) => Promise<void>;
  clearSshPreviewForwardState: (workspaceId: string, options?: { keepStopped?: boolean }) => void;
}

export const useDevServerPreviewStore = create<DevServerPreviewState>((set, get) => ({
  reloadKeyByWorkspace: {},
  probeKeyByWorkspace: {},
  autoReloadByWorkspace: {},
  remoteForwardByWorkspace: {},
  tabForwardIdsByWorkspace: {},

  bumpReloadKey: (workspaceId) => {
    set((state) => ({
      reloadKeyByWorkspace: {
        ...state.reloadKeyByWorkspace,
        [workspaceId]: (state.reloadKeyByWorkspace[workspaceId] ?? 0) + 1,
      },
    }));
  },

  bumpProbeKey: (workspaceId) => {
    set((state) => ({
      probeKeyByWorkspace: {
        ...state.probeKeyByWorkspace,
        [workspaceId]: (state.probeKeyByWorkspace[workspaceId] ?? 0) + 1,
      },
    }));
  },

  toggleAutoReload: (workspaceId, defaultEnabled = true) => {
    set((state) => ({
      autoReloadByWorkspace: {
        ...state.autoReloadByWorkspace,
        [workspaceId]: !(state.autoReloadByWorkspace[workspaceId] ?? defaultEnabled),
      },
    }));
  },

  startSshPreviewForward: async (
    workspaceId,
    tabId,
    remotePort,
    pathSuffix = '',
    scheme = 'http',
    savedUrl
  ) => {
    const requestId = ++nextForwardRequestId;
    const browserId = getBrowserIdOfTab(workspaceId, tabId);
    set((state) => ({
      remoteForwardByWorkspace: {
        ...state.remoteForwardByWorkspace,
        [browserId]: {
          status: 'starting',
          tabId,
          remotePort,
          pathSuffix,
          scheme,
          savedUrl,
          requestId,
        },
      },
    }));

    try {
      const forward = await window.api.startSshPreviewForward(
        workspaceId,
        tabId,
        remotePort,
        scheme
      );
      set((state) => {
        if (state.remoteForwardByWorkspace[browserId]?.requestId !== requestId) return state;
        const tabForwardIds = state.tabForwardIdsByWorkspace[browserId];
        // A tab shown again through the tunnel it had keeps its page.
        const reused = tabForwardIds?.[tabId] === forward.id;
        return {
          remoteForwardByWorkspace: {
            ...state.remoteForwardByWorkspace,
            [browserId]: {
              status: 'active',
              tabId,
              forward,
              remotePort,
              pathSuffix,
              scheme,
              savedUrl,
              requestId,
            },
          },
          tabForwardIdsByWorkspace: {
            ...state.tabForwardIdsByWorkspace,
            [browserId]: { ...tabForwardIds, [tabId]: forward.id },
          },
          reloadKeyByWorkspace: reused
            ? state.reloadKeyByWorkspace
            : {
                ...state.reloadKeyByWorkspace,
                [browserId]: (state.reloadKeyByWorkspace[browserId] ?? 0) + 1,
              },
        };
      });
    } catch (error) {
      set((state) => {
        if (state.remoteForwardByWorkspace[browserId]?.requestId !== requestId) return state;
        return {
          remoteForwardByWorkspace: {
            ...state.remoteForwardByWorkspace,
            [browserId]: {
              status: 'failed',
              tabId,
              remotePort,
              pathSuffix,
              scheme,
              error: error instanceof Error ? error.message : String(error),
              savedUrl,
              requestId,
            },
          },
        };
      });
    }
  },

  requestSshPreviewForward: (
    workspaceId,
    tabId,
    remotePort,
    pathSuffix = '',
    scheme = 'http',
    savedUrl
  ) => {
    const requestId = ++nextForwardRequestId;
    set((state) => ({
      remoteForwardByWorkspace: {
        ...state.remoteForwardByWorkspace,
        [getBrowserIdOfTab(workspaceId, tabId)]: {
          status: 'pending',
          tabId,
          remotePort,
          pathSuffix,
          scheme,
          savedUrl,
          requestId,
        },
      },
    }));
  },

  stopSshPreviewForward: async (workspaceId, options) => {
    const browserId = getBrowserIdOfTab(workspaceId, options?.tabId);
    const current = get().remoteForwardByWorkspace[browserId];
    const tabId = options?.tabId ?? current?.tabId;
    if (!tabId) return;
    set((state) => {
      const tabForwardIds = { ...state.tabForwardIdsByWorkspace[browserId] };
      delete tabForwardIds[tabId];
      return {
        tabForwardIdsByWorkspace: {
          ...state.tabForwardIdsByWorkspace,
          [browserId]: tabForwardIds,
        },
      };
    });
    // The tunnel of a tab out of sight runs apart from the tab on screen's.
    if (current?.tabId !== tabId) {
      if (typeof window !== 'undefined' && window.api) {
        await window.api.stopSshPreviewForward(workspaceId, tabId);
      }
      return;
    }
    const requestId = ++nextForwardRequestId;

    set((state) => ({
      remoteForwardByWorkspace: {
        ...state.remoteForwardByWorkspace,
        [browserId]: { ...current, status: 'stopping', requestId },
      },
    }));

    try {
      if (typeof window !== 'undefined' && window.api) {
        await window.api.stopSshPreviewForward(workspaceId, tabId);
      }
    } finally {
      set((state) => {
        if (state.remoteForwardByWorkspace[browserId]?.requestId !== requestId) return state;
        const remoteForwardByWorkspace = { ...state.remoteForwardByWorkspace };
        // Keep a user's stop so the preview doesn't forward again on its own.
        if (options?.keepStopped) {
          remoteForwardByWorkspace[browserId] = stoppedForwardSlot(current, requestId);
        } else {
          delete remoteForwardByWorkspace[browserId];
        }
        return { remoteForwardByWorkspace };
      });
    }
  },

  clearSshPreviewForwardState: (workspaceId, options) => {
    const requestId = ++nextForwardRequestId;
    set((state) => {
      // The workspace's browser panes.
      const { surfaces } = usePaneSurfacesStore.getState();
      const browserIds = Object.keys(state.remoteForwardByWorkspace).filter(
        (browserId) =>
          browserId === workspaceId ||
          (isPaneSurfaceId(browserId) && surfaces[browserId]?.workspaceId === workspaceId)
      );
      if (browserIds.length === 0) return state;
      const tabForwardIdsByWorkspace = { ...state.tabForwardIdsByWorkspace };
      const remoteForwardByWorkspace = { ...state.remoteForwardByWorkspace };
      for (const browserId of browserIds) {
        delete tabForwardIdsByWorkspace[browserId];
        // A stopped workspace keeps its tunnels stopped until it restarts.
        if (options?.keepStopped) {
          remoteForwardByWorkspace[browserId] = stoppedForwardSlot(
            state.remoteForwardByWorkspace[browserId],
            requestId
          );
        } else {
          delete remoteForwardByWorkspace[browserId];
        }
      }
      return { remoteForwardByWorkspace, tabForwardIdsByWorkspace };
    });
  },
}));
