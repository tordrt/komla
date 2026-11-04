import type { SidebarPanelData, SidebarPanelState } from '../../shared/types/sidebar-panels';

const key = (workspaceId: string, id: string) => `${workspaceId}\0${id}`;

/**
 * What plugin code sets for sidebar panels while Komla runs: the data it posts for each panel's
 * page. It isn't kept across restarts; the code that posted it posts it again. An empty workspace id stands for every workspace.
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

  post(workspaceId: string, id: string, data: SidebarPanelData): void {
    const stateKey = key(workspaceId, id);
    const had = this.states.get(stateKey);
    if (had?.data && JSON.stringify(had.data) === JSON.stringify(data)) return;
    const after = { workspaceId, id, data, revision: (had?.revision ?? 0) + 1 };
    this.states.set(stateKey, after);
    this.emit(after);
  }

  /** Forgets what was set for these panels, as when their plugin stops. */
  forget(ids: ReadonlySet<string>): void {
    for (const [stateKey, state] of this.states) {
      if (!ids.has(state.id)) continue;
      this.states.delete(stateKey);
      this.emit({ workspaceId: state.workspaceId, id: state.id });
    }
  }

  private emit(state: SidebarPanelState): void {
    for (const listener of this.listeners) listener(state);
  }
}

export const sidebarPanelStates = new SidebarPanelStates();
