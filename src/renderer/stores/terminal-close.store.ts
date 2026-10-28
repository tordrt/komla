import { create } from 'zustand';

interface TerminalCloseState {
  closingTerminalIds: ReadonlySet<string>;
}

export const useTerminalCloseStore = create<TerminalCloseState>(() => ({
  closingTerminalIds: new Set(),
}));

export function setTerminalClosing(terminalId: string, closing: boolean): void {
  useTerminalCloseStore.setState((state) => {
    const closingTerminalIds = new Set(state.closingTerminalIds);
    if (closing) {
      closingTerminalIds.add(terminalId);
    } else {
      closingTerminalIds.delete(terminalId);
    }
    return { closingTerminalIds };
  });
}
