import {
  MAX_SIDEBAR_PANEL_BADGE,
  type SidebarPanelBadge,
  type SidebarPanelData,
  type SidebarPanelState,
} from '../../shared/types/sidebar-panels';

import type { SidebarPanelBadgeInput } from '../../shared/ipc/schemas/sidebar-panels-ipc.schemas';

/**
 * The badge a value names, or undefined for none. Numbers show as they are, and 0 or empty text
 * clears the badge, so a count can be set as it is.
 */
export function sidebarPanelBadge(value: SidebarPanelBadgeInput): SidebarPanelBadge | undefined {
  if (value === null) return undefined;
  const { text, tone } = typeof value === 'object' ? value : { text: value, tone: undefined };
  if (text === 0) return undefined;
  const shown = String(text).trim().slice(0, MAX_SIDEBAR_PANEL_BADGE);
  return shown ? { text: shown, ...(tone && { tone }) } : undefined;
}

const key = (workspaceId: string, id: string) => `${workspaceId}\0${id}`;

/**
 * What pages and plugin code set for sidebar panels while Komla runs: each panel's badge, and the
 * data its plugin's code posts for its page. They aren't kept across restarts; the code that set
 * them sets them again. An empty workspace id stands for every workspace.
 */
export class SidebarPanelStates {
  private readonly states = new Map<string, SidebarPanelState>();
  private readonly listeners = new Set<(state: SidebarPanelState) => void>();

  /** Follows each change, with the panel's state after it. */
  onChange(listener: (state: SidebarPanelState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  all(): SidebarPanelState[] {
    return [...this.states.values()];
  }

  /** A panel's state in a workspace: its own, or else the one for every workspace. */
  get(workspaceId: string, id: string): SidebarPanelState | undefined {
    return this.states.get(key(workspaceId, id)) ?? this.states.get(key('', id));
  }

  setBadge(workspaceId: string, id: string, badge: SidebarPanelBadge | undefined): void {
    this.update(workspaceId, id, (state) => {
      const { badge: _badge, ...rest } = state;
      return badge ? { ...rest, badge } : rest;
    });
  }

  post(workspaceId: string, id: string, data: SidebarPanelData): void {
    const had = this.states.get(key(workspaceId, id));
    if (had?.data && JSON.stringify(had.data) === JSON.stringify(data)) return;
    this.update(workspaceId, id, (state) => ({
      ...state,
      data,
      revision: (state.revision ?? 0) + 1,
    }));
  }

  /** Forgets what was set for these panels, as when their plugin stops. */
  forget(ids: ReadonlySet<string>): void {
    for (const [stateKey, state] of this.states) {
      if (!ids.has(state.id)) continue;
      this.states.delete(stateKey);
      this.emit({ workspaceId: state.workspaceId, id: state.id });
    }
  }

  private update(
    workspaceId: string,
    id: string,
    change: (state: SidebarPanelState) => SidebarPanelState
  ): void {
    const stateKey = key(workspaceId, id);
    const had = this.states.get(stateKey);
    const after = change(had ?? { workspaceId, id });
    const empty = after.badge === undefined && after.data === undefined;
    // Data changes come with a new revision, so a badge's change compares only the badge.
    const same =
      had !== undefined &&
      after.revision === had.revision &&
      JSON.stringify(after.badge) === JSON.stringify(had.badge);
    if (had ? same : empty) return;
    if (empty) this.states.delete(stateKey);
    else this.states.set(stateKey, after);
    this.emit(after);
  }

  private emit(state: SidebarPanelState): void {
    for (const listener of this.listeners) listener(state);
  }
}

export const sidebarPanelStates = new SidebarPanelStates();
