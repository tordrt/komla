/** How the sidebar groups workspaces: a panel per project, or one list. */
export const WORKSPACE_GROUPINGS = ['project', 'none'] as const;

export type WorkspaceGrouping = (typeof WORKSPACE_GROUPINGS)[number];
