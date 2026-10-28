export type LocalMirrorSyncStatus =
  | { workspaceId: string; state: 'syncing' }
  | { workspaceId: string; state: 'ready' }
  | { workspaceId: string; state: 'error'; message: string };
