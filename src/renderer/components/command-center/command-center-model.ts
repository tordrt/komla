import uFuzzy from '@leeoniya/ufuzzy';

import {
  getProjectInfo,
  type DashboardProjectInfo,
} from '@/components/dashboard/dashboard-view-model';
import { getWorkspaceDynamicTitle } from '@/components/workspaces/WorkspaceInfoCard';
import {
  getWorkspaceLastTouchedAt,
  getWorkspaceStateGroup,
  WORKSPACE_STATE_GROUP_LABELS,
  WORKSPACE_STATE_GROUPS,
  type WorkspaceStateGroup,
} from '@/lib/workspace-state-groups';

import type { Project, Workspace } from '@/types';

/** Typed first, this limits the results to commands. */
export const COMMANDS_ONLY_PREFIX = '>';

/** Workspaces listed under Recent before anything is typed. Typing searches them all. */
export const RECENT_WORKSPACE_LIMIT = 12;

export interface CommandCenterWorkspaceResult {
  workspace: Workspace;
  title: string;
  group: WorkspaceStateGroup;
  projectInfo: DashboardProjectInfo | null;
  lastActivityAt: number;
}

export interface CommandCenterCommand {
  id: string;
  label: string;
  /** Listed under Actions before anything is typed. */
  featured?: boolean;
}

export interface BuildCommandCenterResultsParams<C extends CommandCenterCommand> {
  query: string;
  workspaces: Workspace[];
  projects: Project[];
  commands: C[];
  /** Left out of Recent, where it would always come first. */
  currentWorkspaceId?: string | null;
}

export type CommandCenterSectionKey = WorkspaceStateGroup | 'actions' | 'recent' | 'commands';

export type CommandCenterItem<C extends CommandCenterCommand> =
  | { kind: 'workspace'; result: CommandCenterWorkspaceResult }
  | { kind: 'command'; command: C };

export interface CommandCenterSection<C extends CommandCenterCommand> {
  key: CommandCenterSectionKey;
  label: string;
  items: CommandCenterItem<C>[];
}

function fuzzyMatches(haystack: string[], needle: string): Set<number> {
  const [idxs] = new uFuzzy().search(haystack, needle, 1);
  return new Set(idxs ?? []);
}

function searchText(result: CommandCenterWorkspaceResult): string {
  const { workspace } = result;
  const branch = workspace.isWorktree && workspace.branchName ? workspace.branchName : '';
  return [result.title, workspace.customDescription, branch, result.projectInfo?.name]
    .filter(Boolean)
    .join(' | ');
}

interface RankedResult {
  result: CommandCenterWorkspaceResult;
  titleMatch: boolean;
}

// Within a group, a match in the title beats one found only in the description,
// branch, or project name, so recent activity elsewhere doesn't bury it.
function byGroupThenTitleMatchThenRecency(a: RankedResult, b: RankedResult): number {
  const groupDifference =
    WORKSPACE_STATE_GROUPS.indexOf(a.result.group) - WORKSPACE_STATE_GROUPS.indexOf(b.result.group);
  if (groupDifference !== 0) return groupDifference;
  if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1;
  return b.result.lastActivityAt - a.result.lastActivityAt;
}

function rankWorkspaces(
  workspaces: Workspace[],
  projects: Project[],
  needle: string
): CommandCenterWorkspaceResult[] {
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const results = workspaces.map((workspace) => ({
    workspace,
    title: workspace.customName || getWorkspaceDynamicTitle(workspace) || workspace.name,
    group: getWorkspaceStateGroup(workspace),
    projectInfo: getProjectInfo(workspace, projects, projectMap),
    lastActivityAt: getWorkspaceLastTouchedAt(workspace),
  }));
  const matches = needle ? fuzzyMatches(results.map(searchText), needle) : null;
  const titleMatches = needle
    ? fuzzyMatches(
        results.map((result) => result.title),
        needle
      )
    : null;
  return results
    .map((result, index) => ({ result, titleMatch: titleMatches?.has(index) ?? false }))
    .filter((_, index) => matches?.has(index) ?? true)
    .sort(byGroupThenTitleMatchThenRecency)
    .map(({ result }) => result);
}

/** The commands whose label matches, in their own order; all of them for an empty query. */
export function matchCommands<C extends CommandCenterCommand>(commands: C[], query: string): C[] {
  const needle = query.trim();
  if (!needle) return commands;
  const matches = fuzzyMatches(
    commands.map((command) => command.label),
    needle
  );
  return commands.filter((_, index) => matches.has(index));
}

function workspaceSection<C extends CommandCenterCommand>(
  key: CommandCenterSectionKey,
  label: string,
  results: CommandCenterWorkspaceResult[]
): CommandCenterSection<C> {
  return { key, label, items: results.map((result) => ({ kind: 'workspace', result })) };
}

function commandSection<C extends CommandCenterCommand>(
  key: CommandCenterSectionKey,
  label: string,
  commands: C[]
): CommandCenterSection<C> {
  return { key, label, items: commands.map((command) => ({ kind: 'command', command })) };
}

/**
 * Sections for the command center. Before anything is typed: workspaces waiting on the
 * user, then the featured actions, then the most recently touched workspaces. A query
 * searches every workspace, grouped by state, then every command. After the ">" prefix,
 * only commands.
 */
export function buildCommandCenterResults<C extends CommandCenterCommand>({
  query,
  workspaces,
  projects,
  commands,
  currentWorkspaceId,
}: BuildCommandCenterResultsParams<C>): CommandCenterSection<C>[] {
  const trimmed = query.trim();
  if (trimmed.startsWith(COMMANDS_ONLY_PREFIX)) {
    const needle = trimmed.slice(COMMANDS_ONLY_PREFIX.length);
    return [commandSection<C>('commands', 'Commands', matchCommands(commands, needle))].filter(
      (section) => section.items.length > 0
    );
  }

  const ranked = rankWorkspaces(workspaces, projects, trimmed);
  const sections: CommandCenterSection<C>[] = trimmed
    ? [
        ...WORKSPACE_STATE_GROUPS.map((group) =>
          workspaceSection<C>(
            group,
            WORKSPACE_STATE_GROUP_LABELS[group],
            ranked.filter((result) => result.group === group)
          )
        ),
        commandSection('commands', 'Commands', matchCommands(commands, trimmed)),
      ]
    : [
        workspaceSection(
          'attention',
          WORKSPACE_STATE_GROUP_LABELS.attention,
          ranked.filter((result) => result.group === 'attention')
        ),
        commandSection(
          'actions',
          'Actions',
          commands.filter((command) => command.featured)
        ),
        // Ones in the Trash only show when searched for.
        workspaceSection(
          'recent',
          'Recent',
          ranked
            .filter(
              (result) =>
                (result.group === 'running' || result.group === 'stopped') &&
                result.workspace.id !== currentWorkspaceId
            )
            .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
            .slice(0, RECENT_WORKSPACE_LIMIT)
        ),
      ];
  return sections.filter((section) => section.items.length > 0);
}
