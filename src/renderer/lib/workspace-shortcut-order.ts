export function orderWorkspacesForShortcuts<T extends { id: string; order?: number }>(
  visibleWorkspaces: T[],
  displayOrderedWorkspaceIds: string[] | null
): T[] {
  if (displayOrderedWorkspaceIds !== null) {
    const workspaceMap = new Map(visibleWorkspaces.map((workspace) => [workspace.id, workspace]));
    return displayOrderedWorkspaceIds
      .map((id) => workspaceMap.get(id))
      .filter((workspace): workspace is T => workspace !== undefined);
  }

  return [...visibleWorkspaces].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
