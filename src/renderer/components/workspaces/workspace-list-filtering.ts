import { isWorkspaceHostVisible } from '@/lib/workspace-host';
import { isHiddenByHideStopped, isWorkspaceSnoozed, type Workspace } from '@/types';

import { agentStateOf, workspaceAgents } from '../../../shared/lib/agent-state';
import { workspaceTagKeyOf } from '../../../shared/lib/workspace-tags';

interface WorkspaceListFilters {
  currentWindowId: string | null;
  hideStopped: boolean;
  hiddenProjectIds: ReadonlySet<string>;
}

function isProjectVisible(workspace: Workspace, hiddenProjectIds: ReadonlySet<string>): boolean {
  return !workspace.projectId || !hiddenProjectIds.has(workspace.projectId);
}

export function matchesWorkspaceListFiltersExceptHost(
  workspace: Workspace,
  filters: WorkspaceListFilters
): boolean {
  const stoppedMatch = !filters.hideStopped || !isHiddenByHideStopped(workspace);

  return (
    workspace.windowId === filters.currentWindowId &&
    workspace.status === 'active' &&
    stoppedMatch &&
    isProjectVisible(workspace, filters.hiddenProjectIds)
  );
}

/** Whether this window's sidebar lists the workspace, with every filter. */
export function isListedInWorkspaceList(
  workspace: Workspace,
  filters: WorkspaceListFilters & { hiddenWorkspaceHostIds: ReadonlySet<string> }
): boolean {
  return (
    isWorkspaceHostVisible(workspace, filters.hiddenWorkspaceHostIds) &&
    matchesWorkspaceListFiltersExceptHost(workspace, filters)
  );
}

/**
 * The projects that have a group in this window's sidebar: a listed workspace that isn't on the
 * Snoozed shelf. A pinned workspace keeps its project's header.
 */
export function getProjectIdsWithListedGroups(
  workspaces: Workspace[],
  filters: WorkspaceListFilters & { hiddenWorkspaceHostIds: ReadonlySet<string> }
): Set<string> {
  const projectIds = new Set<string>();
  for (const workspace of workspaces) {
    if (!workspace.projectId || isWorkspaceSnoozed(workspace)) continue;
    if (isListedInWorkspaceList(workspace, filters)) projectIds.add(workspace.projectId);
  }
  return projectIds;
}

/** Whether the sidebar's Stopped shelf lists the workspace: listed but for "Hide stopped". */
export function isListedOnStoppedShelf(
  workspace: Workspace,
  filters: WorkspaceListFilters & { hiddenWorkspaceHostIds: ReadonlySet<string> }
): boolean {
  return (
    filters.hideStopped &&
    isHiddenByHideStopped(workspace) &&
    isListedInWorkspaceList(workspace, { ...filters, hideStopped: false })
  );
}

/**
 * Whether the sidebar's Working shelf takes the workspace while working ones are hidden: an agent
 * works in it, and none needs input, failed or finished a turn the user hasn't seen, nor does an
 * alert of the workspace's own, which its card shows too. A command started with `komla notify --`
 * or a spinner turned on by hand isn't an agent and may never notify, so it doesn't count. Pinned
 * and snoozed workspaces keep their own places.
 */
export function goesOnWorkingShelf(workspace: Workspace): boolean {
  if (workspace.pinned || isWorkspaceSnoozed(workspace)) return false;
  if (!workspace.attention?.terminalId && agentStateOf(workspace.attention, false)) return false;
  const agents = workspaceAgents(workspace);
  return (
    agents.every((agent) => agent.state === 'working') &&
    agents.some((agent) => agent.terminal && !agent.terminal.commandActive)
  );
}

/**
 * Whether the sidebar's Filtered shelf takes the workspace: its tag is hidden, or it has none while
 * Untagged is, and nothing asks for the user there, neither an agent that needs input, failed or
 * finished a turn the user hasn't seen, nor an alert or unread mark of the workspace's own.
 */
export function goesOnTaggedShelf(
  workspace: Workspace,
  hiddenWorkspaceTags: ReadonlySet<string>
): boolean {
  if (!hiddenWorkspaceTags.has(workspaceTagKeyOf(workspace))) return false;
  if (workspace.unread || agentStateOf(workspace.attention, false)) return false;
  return workspaceAgents(workspace).every((agent) => agent.state === 'working');
}

/** Whether the sidebar's Trash shelf lists the workspace. Ones in the Trash belong to no window. */
export function isListedOnTrashShelf(
  workspace: Workspace,
  filters: Pick<WorkspaceListFilters, 'hiddenProjectIds'> & {
    hiddenWorkspaceHostIds: ReadonlySet<string>;
  }
): boolean {
  return (
    workspace.status === 'trashed' &&
    isWorkspaceHostVisible(workspace, filters.hiddenWorkspaceHostIds) &&
    isProjectVisible(workspace, filters.hiddenProjectIds)
  );
}

export function hasWorkspacesHiddenByHost(
  workspaces: Workspace[],
  hiddenWorkspaceHostIds: ReadonlySet<string>,
  filters: WorkspaceListFilters
): boolean {
  return workspaces.some(
    (workspace) =>
      matchesWorkspaceListFiltersExceptHost(workspace, filters) &&
      !isWorkspaceHostVisible(workspace, hiddenWorkspaceHostIds)
  );
}
