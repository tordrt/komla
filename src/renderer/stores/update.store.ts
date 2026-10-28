import { create } from 'zustand';

import { useToastStore } from './toast.store';

/** `manual`: a new version to download, where Komla can't update itself (some Linux installs). */
type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'manual'
  | 'error';

interface UpdateInfo {
  version: string;
  releaseNotes: string | null;
  releaseName: string | null;
  downloadUrl?: string;
}

interface UpdateState {
  status: UpdateStatus;
  version: string | null;
  releaseNotes: string | null;
  releaseName: string | null;
  downloadUrl: string | null;
  error: string | null;
  dismissed: boolean;

  // Actions
  setChecking: () => void;
  setAvailable: (info: UpdateInfo) => void;
  setNotAvailable: () => void;
  setDownloading: () => void;
  setReady: (version: string) => void;
  setError: (message: string) => void;
  checkForUpdates: () => void;
  downloadUpdate: () => void;
  installUpdate: () => void;
  /** Opens the new version's download, for the `manual` status. */
  openDownload: () => void;
  dismiss: () => void;
  /** Brings a dismissed notice back. */
  showNotice: () => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: 'idle',
  version: null,
  releaseNotes: null,
  releaseName: null,
  downloadUrl: null,
  error: null,
  dismissed: false,

  setChecking: () => {
    set({ status: 'checking', error: null });
  },

  setAvailable: (info) => {
    if (info.downloadUrl) {
      const { status, version, dismissed } = get();
      set({
        status: 'manual',
        version: info.version,
        releaseNotes: info.releaseNotes,
        releaseName: info.releaseName,
        downloadUrl: info.downloadUrl,
        // Checks repeat every few hours; a dismissed download notice stays away for that version.
        dismissed: status === 'manual' && version === info.version && dismissed,
        error: null,
      });
      return;
    }
    set({
      status: 'downloading',
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseName: info.releaseName,
      dismissed: false,
      error: null,
    });
  },

  setNotAvailable: () => {
    set({ status: 'idle', error: null });
  },

  setDownloading: () => {
    set({ status: 'downloading', error: null });
  },

  setReady: (version) => {
    set({ status: 'ready', version, dismissed: false, error: null });
  },

  setError: (message) => {
    // A later check that fails, as when offline, leaves the version to download offered.
    if (get().status === 'manual') return;
    set({ status: 'error', error: message });
  },

  checkForUpdates: async () => {
    set({ status: 'checking', error: null });
    try {
      await window.api.checkForUpdates();
    } catch {
      // IPC call failed
    }
    // If still checking after 10s (e.g. dev mode where no events fire), reset to idle
    setTimeout(() => {
      if (get().status === 'checking') {
        set({ status: 'idle', error: null });
      }
    }, 10_000);
  },

  downloadUpdate: () => {
    const { status } = get();
    if (status !== 'available') return;
    set({ status: 'downloading' });
    void window.api.downloadUpdate();
  },

  installUpdate: () => {
    void window.api.installUpdate();
  },

  openDownload: () => {
    const { downloadUrl } = get();
    if (!downloadUrl) return;
    window.api.openExternal(downloadUrl).catch(() => {
      useToastStore.getState().addToast(`Couldn't open ${downloadUrl}`, 'error');
    });
  },

  dismiss: () => {
    set({ dismissed: true });
  },

  showNotice: () => {
    set({ dismissed: false });
  },
}));
