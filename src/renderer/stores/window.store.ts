import { create } from 'zustand';

export interface WindowInfo {
  id: string;
  displayNumber: number;
}

interface WindowState {
  windowId: string;
  availableWindows: WindowInfo[];
  isFullscreen: boolean;

  // Actions
  setAvailableWindows: (windows: WindowInfo[]) => void;
  setIsFullscreen: (isFullscreen: boolean) => void;
  refreshAvailableWindows: () => Promise<void>;
  subscribeToWindowEvents: () => () => void;
}

// Read windowId from URL query params (set by main process)
function getWindowIdFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('windowId') || 'unknown';
}

export const useWindowStore = create<WindowState>((set) => ({
  windowId: getWindowIdFromUrl(),
  availableWindows: [],
  isFullscreen: false,

  setAvailableWindows: (windows) => {
    set({ availableWindows: windows });
  },

  setIsFullscreen: (isFullscreen) => {
    set({ isFullscreen });
  },

  refreshAvailableWindows: async () => {
    const windows = await window.api.getAllWindowIds();
    set({ availableWindows: windows });
  },

  subscribeToWindowEvents: () => {
    let isActive = true;
    let hasReceivedWindowListUpdate = false;

    const refreshAvailableWindows = async (): Promise<void> => {
      const windows = await window.api.getAllWindowIds();
      if (!isActive) return;
      set({ availableWindows: windows });
    };

    const unsubWindowList = window.api.onWindowListUpdated((windows) => {
      hasReceivedWindowListUpdate = true;
      set({ availableWindows: windows });
    });

    const unsubFullscreen = window.api.onWindowFullscreenChange((isFullscreen) => {
      set({ isFullscreen });
    });

    const handleFocus = (): void => {
      void refreshAvailableWindows();
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void refreshAvailableWindows();
      }
    };

    window.addEventListener('focus', handleFocus);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    // Load initial window list
    void window.api.getAllWindowIds().then((windows) => {
      if (!isActive || hasReceivedWindowListUpdate) return;
      set({ availableWindows: windows });
    });

    void window.api.isWindowFullscreen().then((isFullscreen) => {
      if (!isActive) return;
      set({ isFullscreen });
    });

    return () => {
      isActive = false;
      unsubWindowList();
      unsubFullscreen();
      window.removeEventListener('focus', handleFocus);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  },
}));
