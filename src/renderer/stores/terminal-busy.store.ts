import { create } from 'zustand';

/** What a Terminal is busy with, so its pane can label the control that started it. */
export type TerminalBusyReason = 'reconnect' | 'remote-agent' | 'remote-shell';

interface TerminalBusyState {
  busyTerminals: ReadonlyMap<string, TerminalBusyReason>;
}

export const useTerminalBusyStore = create<TerminalBusyState>(() => ({
  busyTerminals: new Map(),
}));

/** Marks a Terminal busy unless it already is, and reports whether this call claimed it. */
export function claimTerminal(terminalId: string, reason: TerminalBusyReason): boolean {
  if (useTerminalBusyStore.getState().busyTerminals.has(terminalId)) return false;
  useTerminalBusyStore.setState((state) => ({
    busyTerminals: new Map(state.busyTerminals).set(terminalId, reason),
  }));
  return true;
}

export function releaseTerminal(terminalId: string): void {
  useTerminalBusyStore.setState((state) => {
    const busyTerminals = new Map(state.busyTerminals);
    busyTerminals.delete(terminalId);
    return { busyTerminals };
  });
}
