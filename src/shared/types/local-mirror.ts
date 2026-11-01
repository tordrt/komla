export type LocalMirrorSyncStatus =
  // No percent until rsync reports one, which an rsync without progress options never does.
  | { workspaceId: string; state: 'syncing'; percent?: number }
  | { workspaceId: string; state: 'ready' }
  | { workspaceId: string; state: 'error'; message: string };
