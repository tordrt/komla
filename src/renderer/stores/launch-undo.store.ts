import { create } from 'zustand';

/** How long a launch can be taken back, not counting time spent hovering or focusing its row. */
export const LAUNCH_UNDO_MS = 8000;

interface LaunchUndoOffer {
  workspaceIds: string[];
  undo: () => void;
}

interface LaunchUndoState {
  offer: LaunchUndoOffer | null;
}

export const useLaunchUndoStore = create<LaunchUndoState>(() => ({ offer: null }));

/** A new workspace's row offering Undo, which reports whether it is in sight. */
export interface LaunchUndoRow {
  setVisible: (visible: boolean) => void;
  release: () => void;
}

let fallback: (() => void) | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let remainingMs = 0;
let countdownStartedAt = 0;
let holds = 0;
// Rows mounted for the offer, how many of those have said whether they are in sight, and how
// many are. Undecided until the first check after the rows mount.
let mountedRows = 0;
let reportedRows = 0;
let visibleRows = 0;
let decided = false;
// Bumped per offer, so a row letting go of an older one doesn't touch the counts.
let generation = 0;

function startCountdown(): void {
  countdownStartedAt = Date.now();
  expiryTimer = setTimeout(dismissLaunchUndo, remainingMs);
}

// With no row in sight, the offer moves to the fallback for good: at the first check when
// no row mounted or none came into view, or later when the last one goes out of sight.
function checkRows(): void {
  if (!decided || !useLaunchUndoStore.getState().offer) return;
  if (visibleRows > 0 || reportedRows < mountedRows) return;
  const showFallback = fallback;
  dismissLaunchUndo();
  showFallback?.();
}

/**
 * Offers to undo a launch on the new workspaces' sidebar rows, while one of them is in sight.
 * Otherwise (sidebar collapsed, group folded, scrolled away, another screen), `showFallback`
 * shows the offer some other way. A newer launch replaces the offer.
 */
export function offerLaunchUndo(
  workspaceIds: string[],
  undo: () => void,
  showFallback: () => void
): void {
  dismissLaunchUndo();
  fallback = showFallback;
  remainingMs = LAUNCH_UNDO_MS;
  useLaunchUndoStore.setState({ offer: { workspaceIds, undo } });
  startCountdown();
  // The new workspaces are in the store already, so their rows have mounted by the next task.
  const offeredGeneration = generation;
  setTimeout(() => {
    if (offeredGeneration !== generation) return;
    decided = true;
    checkRows();
  }, 0);
}

export function dismissLaunchUndo(): void {
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
  generation += 1;
  fallback = undefined;
  holds = 0;
  mountedRows = 0;
  reportedRows = 0;
  visibleRows = 0;
  decided = false;
  if (useLaunchUndoStore.getState().offer) useLaunchUndoStore.setState({ offer: null });
}

export function takeLaunchUndo(): void {
  const { offer } = useLaunchUndoStore.getState();
  dismissLaunchUndo();
  offer?.undo();
}

/** Called as a row offering Undo mounts (in a layout effect, before the first check). */
export function registerLaunchUndoRow(): LaunchUndoRow {
  const rowGeneration = generation;
  const current = () => rowGeneration === generation;
  let reported = false;
  let visible = false;
  mountedRows += 1;
  return {
    setVisible: (next) => {
      if (!current() || (reported && visible === next)) return;
      if (!reported) reportedRows += 1;
      reported = true;
      visibleRows += (next ? 1 : 0) - (visible ? 1 : 0);
      visible = next;
      checkRows();
    },
    release: () => {
      if (!current()) return;
      mountedRows -= 1;
      if (reported) reportedRows -= 1;
      if (visible) visibleRows -= 1;
      checkRows();
    },
  };
}

/** Pauses the countdown, as while a row offering Undo is hovered or focused. Returns the release. */
export function holdLaunchUndo(): () => void {
  if (holds === 0 && expiryTimer !== undefined) {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    remainingMs = Math.max(0, remainingMs - (Date.now() - countdownStartedAt));
  }
  holds += 1;
  const heldGeneration = generation;
  let released = false;
  return () => {
    if (released || heldGeneration !== generation) return;
    released = true;
    holds -= 1;
    if (holds === 0 && useLaunchUndoStore.getState().offer) startCountdown();
  };
}
