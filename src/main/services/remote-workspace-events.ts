type WorkspaceChangeListener = () => void;

const workspaceChangeListeners = new Set<WorkspaceChangeListener>();

export function onRemoteWorkspaceChange(listener: WorkspaceChangeListener): () => void {
  workspaceChangeListeners.add(listener);
  return () => {
    workspaceChangeListeners.delete(listener);
  };
}

export function publishRemoteWorkspaceChange(): void {
  for (const listener of workspaceChangeListeners) {
    listener();
  }
}
