import { useConfigStore } from '@/stores/config.store';
import { useDevServerPreviewStore } from '@/stores/dev-server-preview.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isSshWorkspace } from '@/types';

/**
 * Keeps this window's browser tabs in step with the SSH hosts the user disconnected from, in
 * whichever window: disconnecting closed the tunnels of a host's workspaces, so they show as
 * stopped, and connecting forgets them, so each forwards again as it's shown. Returns the
 * unsubscribe function.
 */
export function followSshHostConnections(): () => void {
  return useConfigStore.subscribe((state, previous) => {
    const beforeIds = previous.config?.disconnectedSshHostIds;
    const afterIds = state.config?.disconnectedSshHostIds;
    // Unknown until main's config arrives, as when loading it failed.
    if (afterIds === beforeIds || !afterIds || !beforeIds) return;
    const before = new Set(beforeIds);
    const after = new Set(afterIds);
    const switched = new Map<string, boolean>();
    for (const hostId of after) if (!before.has(hostId)) switched.set(hostId, false);
    for (const hostId of before) if (!after.has(hostId)) switched.set(hostId, true);
    if (switched.size === 0) return;
    const preview = useDevServerPreviewStore.getState();
    for (const workspace of useWorkspacesStore.getState().workspaces) {
      if (!isSshWorkspace(workspace)) continue;
      const connected = switched.get(workspace.backend.hostId);
      if (connected === undefined) continue;
      preview.clearSshPreviewForwardState(workspace.id, { keepStopped: !connected });
    }
  });
}
