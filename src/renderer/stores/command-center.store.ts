import { create } from 'zustand';

export type CommandCenterMode = 'workspaces' | 'files' | 'content';
export type CommandCenterFileMode = Exclude<CommandCenterMode, 'workspaces'>;

interface CommandCenterState {
  open: boolean;
  mode: CommandCenterMode;
  /** The file search mode last shown, which the file search shortcut opens again. */
  fileMode: CommandCenterFileMode;
  /**
   * Counts the searches a shortcut opened or switched to, each of which starts afresh.
   * Switching modes inside the dialog keeps the search going.
   */
  session: number;
  /**
   * Opens on workspaces, or on file search in the file mode last shown. Showing that
   * already, it closes instead, so each shortcut toggles its own search.
   */
  toggle: (search: 'workspaces' | 'files') => void;
  setMode: (mode: CommandCenterMode) => void;
  close: () => void;
}

export function isFileMode(mode: CommandCenterMode): mode is CommandCenterFileMode {
  return mode !== 'workspaces';
}

// One dialog serves workspaces, commands and file search, so its shortcuts,
// the title bar and the close-pane shortcut all reach it here.
export const useCommandCenterStore = create<CommandCenterState>((set) => ({
  open: false,
  mode: 'workspaces',
  fileMode: 'files',
  session: 0,
  toggle: (search) =>
    set((state) => {
      const showing = search === 'files' ? isFileMode(state.mode) : state.mode === 'workspaces';
      if (state.open && showing) return { open: false };
      return {
        open: true,
        mode: search === 'files' ? state.fileMode : 'workspaces',
        session: state.session + 1,
      };
    }),
  setMode: (mode) => set(isFileMode(mode) ? { mode, fileMode: mode } : { mode }),
  close: () => set({ open: false }),
}));
