import type { Workspace } from '../types/workspace';

type TitledWorkspace = Pick<
  Workspace,
  'customName' | 'name' | 'primaryTerminalId' | 'terminals' | 'lastDynamicTitle'
>;

/** The title the agent set on the workspace's primary terminal, if any. */
export function getWorkspaceDynamicTitle(workspace: TitledWorkspace): string | undefined {
  const primaryTerminal = workspace.primaryTerminalId
    ? workspace.terminals.find((t) => t.id === workspace.primaryTerminalId)
    : null;
  return (
    primaryTerminal?.dynamicTitle ||
    workspace.terminals[0]?.dynamicTitle ||
    workspace.lastDynamicTitle
  );
}

/** The title a workspace goes by: its custom name, the agent's title, or its generated name. */
export function getWorkspaceDisplayTitle(workspace: TitledWorkspace): string {
  return workspace.customName || getWorkspaceDynamicTitle(workspace) || workspace.name;
}

/**
 * The agent's live terminal title, where a custom name hides it from the workspace's title, as
 * the workspace's card shows it under that name.
 */
export function getWorkspaceLiveTitle(workspace: TitledWorkspace): string | undefined {
  const dynamicTitle = getWorkspaceDynamicTitle(workspace);
  return workspace.customName && dynamicTitle !== workspace.customName ? dynamicTitle : undefined;
}
