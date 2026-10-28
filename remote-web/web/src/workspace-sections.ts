import uFuzzy from '@leeoniya/ufuzzy';

import type { RemoteWorkspaceSummary } from '@komla/remote-protocol';

// Groups the phone's workspace list the way Orca Mobile's host screen does: what needs you
// first, then what is working, then the rest. (UX after stablyai/orca, MIT.)

export type WorkspaceSectionId = 'needs-you' | 'working' | 'idle' | 'stopped';
export type WorkspaceFilter = 'all' | 'needs-you' | 'working';

export interface WorkspaceSection {
  id: WorkspaceSectionId;
  label: string;
  workspaces: RemoteWorkspaceSummary[];
}

const SECTION_LABELS: Record<WorkspaceSectionId, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  idle: 'Idle',
  stopped: 'Stopped',
};

const SECTION_ORDER: WorkspaceSectionId[] = ['needs-you', 'working', 'idle', 'stopped'];

export function hasLiveTerminal(workspace: RemoteWorkspaceSummary): boolean {
  return workspace.terminals.some((terminal) => terminal.status !== 'stopped');
}

export function workspaceSectionId(workspace: RemoteWorkspaceSummary): WorkspaceSectionId {
  if (workspace.attention) return 'needs-you';
  if (workspace.provisioning || workspace.agentActive) return 'working';
  return hasLiveTerminal(workspace) ? 'idle' : 'stopped';
}

function activityTime(workspace: RemoteWorkspaceSummary): number {
  return workspace.lastActivityAt ?? workspace.createdAt ?? 0;
}

function sortTime(workspace: RemoteWorkspaceSummary, section: WorkspaceSectionId): number {
  return section === 'needs-you'
    ? (workspace.attention?.updatedAt ?? activityTime(workspace))
    : activityTime(workspace);
}

function searchText(workspace: RemoteWorkspaceSummary): string {
  return [
    workspace.name,
    workspace.description,
    workspace.branchName,
    workspace.projectName,
    workspace.workingDirectory.split(/[\\/]/).pop(),
    ...workspace.terminals.flatMap((terminal) => [terminal.name, terminal.environment?.name]),
    workspace.attention?.message,
    workspace.lastPrompt,
  ]
    .filter(Boolean)
    .join(' | ');
}

// One typo per word is forgiven, since phone keyboards make them.
const fuzzy = new uFuzzy({ intraMode: 1 });

function fuzzyMatches(haystack: string[], needle: string): Set<number> {
  const [idxs] = fuzzy.search(haystack, needle, 1);
  return new Set(idxs ?? []);
}

/**
 * The workspaces the search finds, each mapped to whether its title matched, or null without a
 * search. Words match in any order, as in the desktop's command center, against what the row
 * shows plus its description and last prompt.
 */
export function searchWorkspaces(
  workspaces: RemoteWorkspaceSummary[],
  query: string
): Map<string, boolean> | null {
  const needle = query.trim();
  if (!needle) return null;
  const matches = fuzzyMatches(workspaces.map(searchText), needle);
  const titleMatches = fuzzyMatches(
    workspaces.map((workspace) => workspace.name),
    needle
  );
  return new Map(
    workspaces.flatMap((workspace, index) =>
      matches.has(index) ? [[workspace.id, titleMatches.has(index)] as const] : []
    )
  );
}

export function workspaceSectionCounts(
  workspaces: RemoteWorkspaceSummary[]
): Record<WorkspaceSectionId, number> {
  const counts: Record<WorkspaceSectionId, number> = {
    'needs-you': 0,
    working: 0,
    idle: 0,
    stopped: 0,
  };
  for (const workspace of workspaces) counts[workspaceSectionId(workspace)] += 1;
  return counts;
}

export function buildWorkspaceSections(
  workspaces: RemoteWorkspaceSummary[],
  options: { query?: string; filter?: WorkspaceFilter } = {}
): WorkspaceSection[] {
  const filter = options.filter ?? 'all';
  const found = searchWorkspaces(workspaces, options.query ?? '');
  const grouped = new Map<WorkspaceSectionId, RemoteWorkspaceSummary[]>();
  for (const workspace of workspaces) {
    if (found && !found.has(workspace.id)) continue;
    const id = workspaceSectionId(workspace);
    if (filter !== 'all' && filter !== id) continue;
    grouped.set(id, [...(grouped.get(id) ?? []), workspace]);
  }
  return SECTION_ORDER.flatMap((id) => {
    const members = grouped.get(id);
    if (!members?.length) return [];
    return [
      {
        id,
        label: SECTION_LABELS[id],
        // A title match beats one found only elsewhere, then the most recent comes first.
        workspaces: [...members].sort(
          (a, b) =>
            Number(found?.get(b.id) ?? false) - Number(found?.get(a.id) ?? false) ||
            sortTime(b, id) - sortTime(a, id)
        ),
      },
    ];
  });
}
