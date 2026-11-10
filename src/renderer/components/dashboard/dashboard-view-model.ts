import uFuzzy from '@leeoniya/ufuzzy';

import { getWorkspaceDisplayTitle } from '@/components/workspaces/WorkspaceInfoCard';
import { getProjectColor } from '@/lib/project-colors';
import { isWorkspaceHostVisible } from '@/lib/workspace-host';
import {
  getWorkspaceLastTouchedAt,
  getWorkspaceStateGroup,
  WORKSPACE_STATE_GROUP_LABELS,
  type WorkspaceStateGroup,
} from '@/lib/workspace-state-groups';

import {
  getWorkspaceTagOptions,
  workspaceTagKey,
  workspaceTagKeyOf,
  type WorkspaceTagDefinition,
  type WorkspaceTagOption,
} from '../../../shared/lib/workspace-tags';

import type { Project, Workspace } from '@/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

export interface DashboardProjectInfo {
  name: string;
  color: string;
  icon?: string;
  /** Directory projects without an icon show a folder, as in the sidebar. */
  kind?: 'directory';
}

export interface DashboardWorkspaceItem {
  workspace: Workspace;
  projectInfo: DashboardProjectInfo | null;
  lastActivityAt: number;
}

export type DashboardSectionKey = WorkspaceStateGroup | 'week' | 'month';

export interface DashboardSection {
  key: DashboardSectionKey;
  title: string;
  items: DashboardWorkspaceItem[];
}

// In display order, the command center's groups with stopped workspaces split by age.
const SECTION_TITLES: Record<DashboardSectionKey, string> = {
  attention: WORKSPACE_STATE_GROUP_LABELS.attention,
  running: WORKSPACE_STATE_GROUP_LABELS.running,
  stopped: WORKSPACE_STATE_GROUP_LABELS.stopped,
  week: 'Not touched in a week',
  month: 'Not touched in a month',
  trash: WORKSPACE_STATE_GROUP_LABELS.trash,
};

export interface DashboardProjectFilter {
  name: string;
  color: string;
  icon?: string;
  kind?: 'directory';
  count: number;
}

export interface BuildDashboardOverviewParams {
  workspaces: Workspace[];
  projects: Project[];
  currentWindowId: string | null;
  /** Projects whose workspaces are left out, by the name the Overview shows them under. */
  hiddenProjectNames?: ReadonlySet<string>;
  /** Tags whose workspaces are left out, by key; the untagged key leaves out those without one. */
  hiddenTagKeys?: ReadonlySet<string>;
  /** The user's tag list, for the tag filters' names and colors. */
  tags?: readonly WorkspaceTagDefinition[];
  hiddenWorkspaceHostIds?: ReadonlySet<string>;
  pinnedOnly?: boolean;
  searchQuery?: string | null;
  now?: number;
}

export interface DashboardOverview {
  totalWindowCount: number;
  visibleCount: number;
  sections: DashboardSection[];
  projectFilters: DashboardProjectFilter[];
  /** The whole tag list, unused tags counting 0, then tags in use that the list lacks. */
  tagFilters: WorkspaceTagOption[];
  /** The workspaces without a tag, for the Untagged filter beside the tags. */
  untaggedCount: number;
}

/**
 * What a filter still shows, for its chip: up to two names, else the one or two it hides, else
 * how many of all.
 */
export function describeShown(shown: readonly string[], hidden: readonly string[]): string {
  if (shown.length === 0) return 'none';
  if (shown.length <= 2) return shown.join(', ');
  if (hidden.length <= 2) return `not ${hidden.join(', ')}`;
  return `${shown.length} of ${shown.length + hidden.length}`;
}

/** Every tag on the list, so one can be picked before any workspace has it, then those in use. */
function getTagFilters(
  tags: readonly WorkspaceTagDefinition[],
  workspaces: readonly Workspace[]
): WorkspaceTagOption[] {
  const inUse = getWorkspaceTagOptions(tags, workspaces);
  const inUseByKey = new Map(inUse.map((option) => [option.key, option]));
  const listed = tags.map((tag) => {
    const key = workspaceTagKey(tag.name);
    return inUseByKey.get(key) ?? { key, name: tag.name, tone: tag.tone, count: 0 };
  });
  const listedKeys = new Set(listed.map((option) => option.key));
  return [...listed, ...inUse.filter((option) => !listedKeys.has(option.key))];
}

export function getProjectInfo(
  workspace: Workspace,
  projects: Project[],
  projectMap: Map<string, Project>
): DashboardProjectInfo | null {
  // As the sidebar's Scratch group shows them.
  if (workspace.scratch) return { name: 'Scratch', color: getProjectColor('Scratch') };
  if (workspace.projectId) {
    const project = projectMap.get(workspace.projectId);
    if (project) {
      return {
        name: project.name,
        color: project.color || getProjectColor(project.name),
        ...(project.icon && { icon: project.icon }),
        ...(project.kind === 'directory' && { kind: 'directory' as const }),
      };
    }
  }

  if (workspace.repoName) {
    const matchingProject = projects.find((project) => project.name === workspace.repoName);
    return {
      name: workspace.repoName,
      color: matchingProject?.color || getProjectColor(workspace.repoName),
    };
  }

  if (!workspace.isWorktree && workspace.workingDirectory) {
    const dirName = workspace.workingDirectory.split(/[\\/]/).pop() || workspace.workingDirectory;
    return { name: dirName, color: workspace.color || getProjectColor(dirName) };
  }

  return null;
}

/**
 * Only stopped workspaces are split by age: those untouched for a week move to the
 * week or month group so they can be trashed or deleted together.
 */
function getSectionKey(
  workspace: Workspace,
  lastActivityAt: number,
  now: number
): DashboardSectionKey {
  const group = getWorkspaceStateGroup(workspace);
  if (group !== 'stopped') return group;
  const age = now - lastActivityAt;
  if (age >= MONTH_MS) return 'month';
  if (age >= WEEK_MS) return 'week';
  return 'stopped';
}

// A question or an error blocks the agent, so those come before finished turns.
function getAttentionRank(workspace: Workspace): number {
  const kind = workspace.attention?.kind;
  if (kind === 'input-required') return 0;
  if (kind === 'error') return 1;
  return 2;
}

function byAttentionThenLastActivity(a: DashboardWorkspaceItem, b: DashboardWorkspaceItem): number {
  const rankDifference = getAttentionRank(a.workspace) - getAttentionRank(b.workspace);
  if (rankDifference !== 0) return rankDifference;
  if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
  return (a.workspace.order ?? 0) - (b.workspace.order ?? 0);
}

function searchItems(items: DashboardWorkspaceItem[], query: string): DashboardWorkspaceItem[] {
  const haystack = items.map(({ workspace }) => {
    const branch = workspace.isWorktree && workspace.branchName ? workspace.branchName : '';
    const lastPrompt = workspace.promptSubmits?.at(-1)?.prompt ?? '';
    return [getWorkspaceDisplayTitle(workspace), workspace.customDescription, branch, lastPrompt]
      .filter(Boolean)
      .join(' | ');
  });
  const [idxs] = new uFuzzy().search(haystack, query, 1);
  return idxs ? idxs.map((i) => items[i]) : [];
}

export function buildDashboardOverview({
  workspaces,
  projects,
  currentWindowId,
  hiddenProjectNames = new Set(),
  hiddenTagKeys = new Set(),
  tags = [],
  hiddenWorkspaceHostIds = new Set(),
  pinnedOnly = false,
  searchQuery,
  now = Date.now(),
}: BuildDashboardOverviewParams): DashboardOverview {
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  // Active workspaces are per-window; ones in the Trash are shared across all windows
  const windowWorkspaces = workspaces.filter(
    (workspace) => workspace.status !== 'active' || workspace.windowId === currentWindowId
  );

  const hostVisibleItems: DashboardWorkspaceItem[] = windowWorkspaces
    .filter((workspace) => isWorkspaceHostVisible(workspace, hiddenWorkspaceHostIds))
    .map((workspace) => ({
      workspace,
      projectInfo: getProjectInfo(workspace, projects, projectMap),
      lastActivityAt: getWorkspaceLastTouchedAt(workspace),
    }));

  // Project counts take in every group, before the project filter applies.
  const projectCountMap = new Map<string, Omit<DashboardProjectFilter, 'name'>>();
  for (const item of hostVisibleItems) {
    if (item.projectInfo) {
      const existing = projectCountMap.get(item.projectInfo.name);
      if (existing) {
        existing.count++;
      } else {
        const { color, icon, kind } = item.projectInfo;
        projectCountMap.set(item.projectInfo.name, {
          color,
          ...(icon && { icon }),
          ...(kind && { kind }),
          count: 1,
        });
      }
    }
  }
  const projectFilters: DashboardProjectFilter[] = Array.from(projectCountMap.entries())
    .map(([name, info]) => ({ name, ...info }))
    .sort((a, b) => b.count - a.count);

  // Like the project counts, tag counts take in every group before the filters apply.
  const hostVisibleWorkspaces = hostVisibleItems.map((item) => item.workspace);
  const tagFilters = getTagFilters(tags, hostVisibleWorkspaces);
  const untaggedCount = hostVisibleWorkspaces.filter((workspace) => !workspace.tag).length;

  const filteredItems = hostVisibleItems.filter(
    (item) =>
      !(item.projectInfo && hiddenProjectNames.has(item.projectInfo.name)) &&
      !hiddenTagKeys.has(workspaceTagKeyOf(item.workspace)) &&
      (!pinnedOnly || item.workspace.pinned === true)
  );
  const query = searchQuery?.trim();
  const matchingItems = query ? searchItems(filteredItems, query) : filteredItems;

  const itemsBySection = new Map<DashboardSectionKey, DashboardWorkspaceItem[]>();
  for (const item of matchingItems) {
    const key = getSectionKey(item.workspace, item.lastActivityAt, now);
    const items = itemsBySection.get(key);
    if (items) items.push(item);
    else itemsBySection.set(key, [item]);
  }
  // Groups without workspaces are left out.
  const sections = (Object.keys(SECTION_TITLES) as DashboardSectionKey[]).flatMap((key) => {
    const items = itemsBySection.get(key);
    if (!items) return [];
    items.sort(byAttentionThenLastActivity);
    return [{ key, title: SECTION_TITLES[key], items }];
  });

  return {
    totalWindowCount: windowWorkspaces.length,
    visibleCount: matchingItems.length,
    sections,
    projectFilters,
    tagFilters,
    untaggedCount,
  };
}
