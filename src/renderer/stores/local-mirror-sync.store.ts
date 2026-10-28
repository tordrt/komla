import { create } from 'zustand';

import type { LocalMirrorSyncStatus } from '@/types';

interface LocalMirrorSyncState {
  statusesByWorkspaceId: ReadonlyMap<string, Exclude<LocalMirrorSyncStatus, { state: 'ready' }>>;
}

export const useLocalMirrorSyncStore = create<LocalMirrorSyncState>(() => ({
  statusesByWorkspaceId: new Map(),
}));

export function setLocalMirrorSyncStatus(status: LocalMirrorSyncStatus): void {
  useLocalMirrorSyncStore.setState((state) => {
    const statusesByWorkspaceId = new Map(state.statusesByWorkspaceId);
    if (status.state === 'ready') {
      statusesByWorkspaceId.delete(status.workspaceId);
    } else {
      statusesByWorkspaceId.set(status.workspaceId, status);
    }
    return { statusesByWorkspaceId };
  });
}
