import { getWorkspaceLastTouchedAt } from '@/lib/workspace-state-groups';
import { isWorkspaceSnoozed, type Workspace } from '@/types';

export interface WorkspaceGroup {
  key: string;
  projectInfo: { name: string; color: string; icon?: string } | null;
  projectId: string | null;
  isDirectory: boolean;
  workspaces: Workspace[];
}

// Flatten grouped workspaces into the ordered ID list used by the sidebar for
// keyboard navigation (Cmd+Arrow, Cmd+1-9) and shift-click range selection.
// Groups without projectInfo are rendered flat and always visible; groups with
// projectInfo are collapsible and contribute nothing while collapsed.
export function getVisibleOrderedWorkspaceIds(
  groups: WorkspaceGroup[],
  isExpanded: (group: WorkspaceGroup) => boolean
): string[] {
  return groups.flatMap((group) => {
    if (!group.projectInfo) return group.workspaces.map((w) => w.id);
    if (!isExpanded(group)) return [];
    return group.workspaces.map((w) => w.id);
  });
}

export interface WorkspaceListSections {
  /** On the Pinned shelf above every group, in manual order. */
  pinned: Workspace[];
  /** In their project groups. */
  grouped: Workspace[];
  /** On the Working shelf below while working workspaces are hidden, in list order. */
  working: Workspace[];
  /** On the Filtered shelf below while their tags (or Untagged) are hidden, in list order. */
  tagged: Workspace[];
  /** On the Snoozed shelf below, the soonest to wake first. */
  snoozed: Workspace[];
}

export function splitWorkspaceListSections(
  workspaces: Workspace[],
  isShelvedAsWorking: (workspace: Workspace) => boolean = () => false,
  isShelvedAsTagged: (workspace: Workspace) => boolean = () => false
): WorkspaceListSections {
  const sections: WorkspaceListSections = {
    pinned: [],
    grouped: [],
    working: [],
    tagged: [],
    snoozed: [],
  };
  for (const workspace of workspaces) {
    if (isWorkspaceSnoozed(workspace)) sections.snoozed.push(workspace);
    else if (workspace.pinned) sections.pinned.push(workspace);
    else if (isShelvedAsWorking(workspace)) sections.working.push(workspace);
    else if (isShelvedAsTagged(workspace)) sections.tagged.push(workspace);
    else sections.grouped.push(workspace);
  }
  sections.pinned.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  // A snooze until notified with no time has no end to sort by, so it goes last.
  const end = (workspace: Workspace) => workspace.snoozedUntil ?? Number.MAX_SAFE_INTEGER;
  sections.snoozed.sort((a, b) => end(a) - end(b));
  return sections;
}

/** For the Stopped and Trash shelves: the last touched first, as the Overview orders them. */
export function sortByLastTouched(workspaces: Workspace[]): Workspace[] {
  return [...workspaces].sort(
    (a, b) => getWorkspaceLastTouchedAt(b) - getWorkspaceLastTouchedAt(a)
  );
}
