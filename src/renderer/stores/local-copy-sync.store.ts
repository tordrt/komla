import { create } from 'zustand';

import type { LocalCopySyncStatus } from '@/types';

interface LocalCopySyncState {
  statusesByWorkspaceId: ReadonlyMap<string, Exclude<LocalCopySyncStatus, { state: 'ready' }>>;
}

export const useLocalCopySyncStore = create<LocalCopySyncState>(() => ({
  statusesByWorkspaceId: new Map(),
}));

export function setLocalCopySyncStatus(status: LocalCopySyncStatus): void {
  useLocalCopySyncStore.setState((state) => {
    const statusesByWorkspaceId = new Map(state.statusesByWorkspaceId);
    if (status.state === 'ready') {
      statusesByWorkspaceId.delete(status.workspaceId);
    } else {
      statusesByWorkspaceId.set(status.workspaceId, status);
    }
    return { statusesByWorkspaceId };
  });
}
