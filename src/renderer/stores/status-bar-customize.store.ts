import { create } from 'zustand';

type Point = { x: number; y: number };

interface StatusBarCustomizeState {
  open: boolean;
  /** Where on the bar the panel opens above; null for the bar's right end. */
  anchor: Point | null;
  show: (anchor?: Point) => void;
  close: () => void;
}

// Lives outside the components that open it, so the bar's and the sidebar footer's right-click
// menus and Tips all reach one panel.
export const useStatusBarCustomizeStore = create<StatusBarCustomizeState>((set) => ({
  open: false,
  anchor: null,
  show: (anchor) => set({ open: true, anchor: anchor ?? null }),
  close: () => set({ open: false }),
}));
