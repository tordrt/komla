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
  UNTAGGED_WORKSPACE_TAG_KEY,
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
  count: number;
}

export interface BuildDashboardOverviewParams {
  workspaces: Workspace[];
  projects: Project[];
  currentWindowId: string | null;
  filterProjectName?: string | null;
  /**
   * Only workspaces with this tag, by key, or the untagged key for those without one. Left out
   * while no chip offers it.
   */
  filterTagKey?: string | null;
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
  /** The tags in use, offered while any is. */
  tagFilters: WorkspaceTagOption[];
  /** The workspaces without a tag, for the Untagged filter beside the tags. */
  untaggedCount: number;
  /** Untagged is offered beside the tags in use, and only while some workspace has no tag. */
  untaggedOffered: boolean;
  /** The tag filter that applies: the one asked for while a chip offers it, else null. */
  tagFilterKey: string | null;
}

export function getProjectInfo(
  workspace: Workspace,
  projects: Project[],
  projectMap: Map<string, Project>
): DashboardProjectInfo | null {
  if (workspace.projectId) {
    const project = projectMap.get(workspace.projectId);
    if (project) {
      return {
        name: project.name,
        color: project.color || getProjectColor(project.name),
        ...(project.icon && { icon: project.icon }),
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
  filterProjectName,
  filterTagKey = null,
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

  // Project chips count every group, before the project filter applies.
  const projectCountMap = new Map<string, { color: string; icon?: string; count: number }>();
  for (const item of hostVisibleItems) {
    if (item.projectInfo) {
      const existing = projectCountMap.get(item.projectInfo.name);
      if (existing) {
        existing.count++;
      } else {
        const { color, icon } = item.projectInfo;
        projectCountMap.set(item.projectInfo.name, { color, ...(icon && { icon }), count: 1 });
      }
    }
  }
  const projectFilters: DashboardProjectFilter[] = Array.from(projectCountMap.entries())
    .map(([name, info]) => ({ name, ...info }))
    .sort((a, b) => b.count - a.count);

  // Like the project chips, tag chips count every group before the filters apply.
  const hostVisibleWorkspaces = hostVisibleItems.map((item) => item.workspace);
  const tagFilters = getWorkspaceTagOptions(tags, hostVisibleWorkspaces);
  const untaggedCount = hostVisibleWorkspaces.filter((workspace) => !workspace.tag).length;
  const untaggedOffered = tagFilters.length > 0 && untaggedCount > 0;
  const tagFilterOffered =
    filterTagKey === UNTAGGED_WORKSPACE_TAG_KEY
      ? untaggedOffered
      : tagFilters.some((tag) => tag.key === filterTagKey);
  const tagFilterKey = tagFilterOffered ? filterTagKey : null;

  const filteredItems = hostVisibleItems.filter(
    (item) =>
      (!filterProjectName || item.projectInfo?.name === filterProjectName) &&
      (tagFilterKey === null || workspaceTagKeyOf(item.workspace) === tagFilterKey) &&
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
    untaggedOffered,
    tagFilterKey,
  };
}
