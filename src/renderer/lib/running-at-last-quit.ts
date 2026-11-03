import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isWorkspaceRestartError, type Workspace } from '@/types';

import { isRunningHere } from '../../shared/lib/terminal-execution-state';

/**
 * The local workspaces in this window that were running when Komla last quit and are still
 * stopped, in the order main lists them.
 */
export async function loadWorkspacesRunningAtLastQuit(): Promise<Workspace[]> {
  const ids = await window.api.listWorkspacesRunningAtLastQuit();
  const windowId = useWindowStore.getState().windowId;
  const workspaces = new Map(useWorkspacesStore.getState().workspaces.map((w) => [w.id, w]));
  return ids
    .map((id) => workspaces.get(id))
    .filter(
      (workspace): workspace is Workspace =>
        workspace !== undefined && workspace.windowId === windowId && !isRunningHere(workspace)
    );
}

/**
 * Restarts the workspaces one at a time, without selecting any, and stops at the plan's workspace
 * limit, where the first refusal already offers an upgrade. A failure is reported and the rest
 * still start.
 */
export async function restartWorkspacesRunningAtLastQuit(workspaceIds: string[]): Promise<void> {
  void window.api.forgetWorkspacesRunningAtLastQuit();
  const { restartWorkspace } = useWorkspacesStore.getState();
  for (const id of workspaceIds) {
    const current = useWorkspacesStore.getState().workspaces.find((w) => w.id === id);
    if (!current || isRunningHere(current)) continue;
    try {
      const result = await restartWorkspace(id);
      if (result && isWorkspaceRestartError(result)) return;
    } catch {
      // restartWorkspace reported it.
    }
  }
}
