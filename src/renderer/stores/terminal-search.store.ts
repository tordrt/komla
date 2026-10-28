import { create } from 'zustand';

interface TerminalSearchState {
  activeSearchTerminalId: string | null;
  /** Counts opens, so opening the bar that's already open focuses it again. */
  openCount: number;
  searchQueryByTerminal: Record<string, string>;
  /** Shared by every terminal's search bar for the session, like an editor's find widget. */
  caseSensitive: boolean;
  openSearch: (terminalId: string) => void;
  closeSearch: () => void;
  setSearchQuery: (terminalId: string, query: string) => void;
  toggleCaseSensitive: () => void;
}

export const useTerminalSearchStore = create<TerminalSearchState>((set) => ({
  activeSearchTerminalId: null,
  openCount: 0,
  searchQueryByTerminal: {},
  caseSensitive: false,

  openSearch: (terminalId) => {
    set((state) => ({ activeSearchTerminalId: terminalId, openCount: state.openCount + 1 }));
  },

  closeSearch: () => {
    set((state) => {
      // Clear decorations when closing search
      if (state.activeSearchTerminalId) {
        return {
          activeSearchTerminalId: null,
        };
      }
      return state;
    });
  },

  setSearchQuery: (terminalId, query) => {
    set((state) => ({
      searchQueryByTerminal: {
        ...state.searchQueryByTerminal,
        [terminalId]: query,
      },
    }));
  },

  toggleCaseSensitive: () => {
    set((state) => ({ caseSensitive: !state.caseSensitive }));
  },
}));
