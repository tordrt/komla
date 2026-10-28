import { create } from 'zustand';

/** How long a pane flash runs; it ends before a pane mounted later could replay it. */
export const PANE_FLASH_MS = 1500;

interface PaneFlashState {
  /** The terminals whose panes flash, and when, so a second jump flashes them again. */
  flash: { terminalIds: ReadonlySet<string>; at: number } | null;
}

export const usePaneFlashStore = create<PaneFlashState>(() => ({ flash: null }));

/** Flashes the terminals' panes once, as a jump lands on them, so the eye finds them. */
export function flashPanes(terminalIds: Iterable<string>): void {
  const ids = new Set(terminalIds);
  if (ids.size === 0) return;
  const flash = { terminalIds: ids, at: Date.now() };
  usePaneFlashStore.setState({ flash });
  setTimeout(() => {
    if (usePaneFlashStore.getState().flash === flash) usePaneFlashStore.setState({ flash: null });
  }, PANE_FLASH_MS);
}
