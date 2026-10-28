import { useLayoutEffect, useSyncExternalStore } from 'react';

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'komla.sidebarCollapsed';

function readStoredSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

let collapsed = readStoredSidebarCollapsed();
// Collapsed only counts while a sidebar is mounted (it stays mounted, hidden, while collapsed),
// so screens without one, such as Overview, never show the Expand button.
let mountedSidebars = 0;
// A window without workspaces collapses its sidebar until one arrives. Expanding or collapsing it
// there stays in this window: the stored choice, shared by all windows, applies once one arrives.
// Expanding it shows it until the window next has none.
let windowEmpty = false;
let shownWhileEmpty = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

// Other windows share the stored choice; follow theirs so all windows stay alike.
window.addEventListener('storage', (event) => {
  if (event.key !== SIDEBAR_COLLAPSED_STORAGE_KEY) return;
  collapsed = event.newValue === 'true';
  notify();
});

function isCollapsed(): boolean {
  return windowEmpty ? !shownWhileEmpty : collapsed;
}

export function setSidebarCollapsed(next: boolean): void {
  if (isCollapsed() === next) return;
  if (windowEmpty) {
    shownWhileEmpty = !next;
  } else {
    collapsed = next;
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
    } catch {
      // Storage unavailable — the sidebar just opens again after a restart.
    }
  }
  notify();
}

/** Does nothing without a sidebar to collapse, so the choice isn't changed out of sight. */
export function toggleSidebarCollapsed(): void {
  if (mountedSidebars === 0) return;
  setSidebarCollapsed(!isCollapsed());
}

/** Called with whether this window has workspaces: without any, the sidebar collapses. */
export function useSidebarWindowEmpty(empty: boolean): void {
  useLayoutEffect(() => {
    if (windowEmpty === empty) return;
    windowEmpty = empty;
    shownWhileEmpty = false;
    notify();
  }, [empty]);
}

/** Called by the sidebar: while it's mounted, the collapsed choice applies. */
export function useSidebarMounted(): void {
  useLayoutEffect(() => {
    mountedSidebars += 1;
    notify();
    return () => {
      mountedSidebars -= 1;
      notify();
    };
  }, []);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether the sidebar is collapsed, from its button in the top row (kept across restarts) or
 * because the window has no workspaces.
 */
export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, () => isCollapsed() && mountedSidebars > 0);
}
