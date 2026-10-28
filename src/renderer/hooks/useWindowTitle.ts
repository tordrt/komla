import { useEffect } from 'react';

import {
  getWorkspaceDisplayTitle,
  stripAgentTitleGlyphs,
} from '@/components/workspaces/WorkspaceInfoCard';
import { useWorkspacesStore } from '@/stores/workspaces.store';

type WorkspacesState = ReturnType<typeof useWorkspacesStore.getState>;

function windowTitle(state: WorkspacesState): string {
  const workspace = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  if (!workspace) return 'Komla';
  return `${stripAgentTitleGlyphs(getWorkspaceDisplayTitle(workspace))} — Komla`;
}

/**
 * Names the open workspace in the window title, which the OS shows in the window switcher, the
 * taskbar and the Window menu. The agent's spinner is left out, or the title would flicker. Writes
 * it from a store subscription so App doesn't re-render whenever an agent retitles its terminal.
 */
export function useWindowTitle(): void {
  useEffect(() => {
    const update = (state: WorkspacesState) => {
      const title = windowTitle(state);
      if (document.title !== title) document.title = title;
    };
    update(useWorkspacesStore.getState());
    return useWorkspacesStore.subscribe(update);
  }, []);
}
