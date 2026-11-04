import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { runningTerminalCount } from '../../shared/lib/terminal-execution-state';

import type { Workspace } from '@/types';

/** Still waiting to be restarted: outside the Trash, with no terminal running or starting. */
export function awaitsRestart(
  workspace: Workspace | undefined,
  restartingIds: ReadonlySet<string>
): workspace is Workspace {
  return (
    workspace !== undefined &&
    workspace.status === 'active' &&
    runningTerminalCount(workspace) === 0 &&
    !restartingIds.has(workspace.id)
  );
}

/**
 * Of the ids main offers, those of workspaces in this window that still await a restart, in the
 * order main lists them.
 */
export function offerableInThisWindow(ids: string[]): string[] {
  const windowId = useWindowStore.getState().windowId;
  const { workspaces, restartingWorkspaceIds } = useWorkspacesStore.getState();
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  return ids.filter((id) => {
    const workspace = byId.get(id);
    return awaitsRestart(workspace, restartingWorkspaceIds) && workspace.windowId === windowId;
  });
}

/** Declines restarting these; main keeps offering the rest at later launches. */
export function forgetWorkspacesRunningAtLastQuit(workspaceIds: string[]): void {
  if (workspaceIds.length === 0) return;
  window.api.forgetWorkspacesRunningAtLastQuit(workspaceIds).catch(() => {
    // The next launch offers them again.
  });
}

/**
 * Restarts the workspaces one at a time, without selecting any, skipping those the user restarted
 * or moved to the Trash meanwhile. Each start takes the workspace off main's offer. A failure is
 * reported and the rest still start.
 */
export async function restartWorkspacesRunningAtLastQuit(workspaceIds: string[]): Promise<void> {
  for (const id of workspaceIds) {
    const { workspaces, restartingWorkspaceIds, restartWorkspace } = useWorkspacesStore.getState();
    const workspace = workspaces.find((w) => w.id === id);
    if (!awaitsRestart(workspace, restartingWorkspaceIds)) continue;
    try {
      await restartWorkspace(id);
    } catch {
      // restartWorkspace reported it.
    }
  }
}
