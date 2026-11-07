import { ArrowElbowDownRight, CaretDown, Check, GearSix, GitBranch } from '@phosphor-icons/react';
import { Fragment, useState } from 'react';

import { ProjectMark } from '@/components/projects/ProjectMark';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { menuItemClass } from '@/components/ui/menu-styles';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AGENT_STATES,
  AGENT_STATES_BY_URGENCY,
  AgentStateIcon,
  byUrgency,
  workspaceAgents,
  type Agent,
  type AgentState,
} from '@/components/workspaces/agent-state';
import {
  AgentDetails,
  agentName,
  agentSaid,
  AgentTime,
} from '@/components/workspaces/AgentDetails';
import {
  getWorkspaceDisplayTitle,
  WorkspaceInfoCardContent,
} from '@/components/workspaces/WorkspaceInfoCard';
import { getProjectColor } from '@/lib/project-colors';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';

import { agentSince, clearedFromOverview } from '../../../../shared/lib/agent-state';
import { AGENTS_MENU_BAR_CARD } from '../../../../shared/types';

import type { AgentsMenuBarProject } from '../../../../shared/types';
import type { Workspace } from '@/types';
import type * as React from 'react';

/**
 * The workspaces' agents, most urgent first and the latest first among equals, without the
 * finished ones the overview cleared at `doneClearedAt`.
 */
export function listAgents(workspaces: readonly Workspace[], doneClearedAt?: number): Agent[] {
  return workspaces
    .flatMap((workspace) => workspaceAgents(workspace))
    .filter((agent) => !clearedFromOverview(agent, doneClearedAt))
    .sort((a, b) => byUrgency(a, b) || (agentSince(b) ?? 0) - (agentSince(a) ?? 0));
}

/** Each state the agents are in, most urgent first, with how it reads and how many are in it. */
export function agentStateCounts(agents: readonly Agent[]) {
  return AGENT_STATES_BY_URGENCY.map((state: AgentState) => ({
    state,
    ...AGENT_STATES[state],
    count: agents.filter((agent) => agent.state === state).length,
  })).filter(({ count }) => count > 0);
}

interface AgentsPanelProps {
  agents: readonly Agent[];
  projects: readonly AgentsMenuBarProject[];
  selectedWorkspaceId?: string | null;
  /**
   * Whether a row's card and the settings menu may move and narrow to fit the window. The menu
   * bar's popover grows its window to fit them where they open instead.
   */
  avoidCollisions?: boolean;
  listClassName?: string;
  onOpenAgent: (agent: Agent) => void;
}

type RowProps = Omit<AgentsPanelProps, 'agents' | 'listClassName'>;

/**
 * The agent's row, which shows its workspace's card beside the panel on hover, as the sidebar's
 * cards do, with what the agent said.
 */
function AgentCard({
  agent,
  avoidCollisions = true,
  children,
}: Pick<RowProps, 'avoidCollisions'> & {
  agent: Agent;
  children: React.ReactElement;
}) {
  const { workspace } = agent;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="left"
        align="start"
        sideOffset={AGENTS_MENU_BAR_CARD.gap}
        collisionPadding={8}
        avoidCollisions={avoidCollisions}
        className={cn(
          'rounded-[calc(var(--radius)+2px)] p-0 shadow-xl select-text',
          // Beside the panel, the card narrows to the room the window has on its side.
          avoidCollisions && 'w-[clamp(13rem,var(--radix-tooltip-content-available-width),20rem)]'
        )}
        // In the menu bar's popover, the room its window keeps for it.
        style={avoidCollisions ? undefined : { width: AGENTS_MENU_BAR_CARD.width }}
      >
        {/* The row already tells the project and branch. */}
        <WorkspaceInfoCardContent workspace={workspace} sshHost={null} showLocation={false}>
          <AgentDetails agent={agent} />
        </WorkspaceInfoCardContent>
      </TooltipContent>
    </Tooltip>
  );
}

/** The workspace's project and branch, under its name. */
function WorkspacePlace({
  workspace,
  projects,
}: {
  workspace: Workspace;
  projects: RowProps['projects'];
}) {
  const found = projects.find((project) => project.id === workspace.projectId);
  const project = found && { ...found, color: found.color || getProjectColor(found.name) };
  const branch = workspace.isWorktree ? workspace.branchName : undefined;
  if (!project && !branch) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-foreground/60">
      {project && (
        <>
          <ProjectMark project={project} iconClassName="size-3" dotClassName="size-1.5" />
          <span className="shrink-0 truncate">{project.name}</span>
        </>
      )}
      {project && branch && <span className="opacity-50">/</span>}
      {branch && (
        <>
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate font-mono">{branch}</span>
        </>
      )}
    </span>
  );
}

const rowClass =
  'flex w-full rounded-md text-left outline-hidden hover:bg-foreground/8 focus-visible:bg-foreground/8';

/** A workspace's only agent, as one row: its state, the workspace's name, project and branch. */
function AgentRow({
  agent,
  projects,
  selectedWorkspaceId,
  onOpenAgent,
  ...card
}: RowProps & { agent: Agent }) {
  const { workspace, state } = agent;
  const selected = selectedWorkspaceId === workspace.id;
  // Why it needs you, or what it did, at a glance; working, what it was asked.
  const said = agentSaid(agent);
  const asked = state === 'working' ? workspace.promptSubmits?.at(-1)?.prompt : undefined;
  return (
    <li>
      <AgentCard agent={agent} {...card}>
        <button
          type="button"
          className={cn(
            rowClass,
            'items-start gap-2.5 px-2.5 py-1.5',
            selected && 'bg-foreground/5'
          )}
          aria-current={selected ? 'true' : undefined}
          onClick={() => onOpenAgent(agent)}
        >
          <span className="flex h-[18px] shrink-0 items-center">
            <AgentStateIcon state={state} className="size-3.5" />
          </span>
          <span className="sr-only">{AGENT_STATES[state].title}:</span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                {getWorkspaceDisplayTitle(workspace)}
              </span>
              <AgentTime agent={agent} />
            </span>
            <WorkspacePlace workspace={workspace} projects={projects} />
            {said && (
              <span
                className={cn(
                  'mt-0.5 block truncate text-xs',
                  state === 'done' ? 'text-muted-foreground' : 'text-foreground/80'
                )}
              >
                {said}
              </span>
            )}
            {asked && (
              <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <span title="Your last prompt" className="flex shrink-0">
                  <ArrowElbowDownRight
                    aria-label="Your last prompt"
                    className="size-3 opacity-60"
                  />
                </span>
                <span className="truncate">{asked}</span>
              </span>
            )}
          </span>
        </button>
      </AgentCard>
    </li>
  );
}

/**
 * A workspace with several agents: its name, project and branch, and under them a line per
 * agent, which opens the agent's pane.
 */
function WorkspaceAgents({
  agents,
  projects,
  selectedWorkspaceId,
  onOpenAgent,
  ...card
}: RowProps & { agents: Agent[] }) {
  const { workspace } = agents[0];
  const title = getWorkspaceDisplayTitle(workspace);
  const selected = selectedWorkspaceId === workspace.id;
  return (
    <li className={cn('rounded-md pb-0.5', selected && 'bg-foreground/5')}>
      {/* Lined up with a lone agent's name, past where its state icon goes. */}
      <div className="px-2.5 pt-1.5 pb-0.5 pl-[34px]">
        <span className="block truncate text-[13px] font-medium">{title}</span>
        <WorkspacePlace workspace={workspace} projects={projects} />
      </div>
      <ul aria-label={title}>
        {agents.map((agent) => (
          <li key={agent.terminal?.id ?? ''}>
            <AgentCard agent={agent} {...card}>
              <button
                type="button"
                className={cn(rowClass, 'items-center gap-2 py-1 pr-2.5 pl-[34px]')}
                aria-current={selected ? 'true' : undefined}
                onClick={() => onOpenAgent(agent)}
              >
                <AgentStateIcon state={agent.state} className="size-3.5" />
                <span className="sr-only">{AGENT_STATES[agent.state].title}:</span>
                <span className="min-w-0 flex-1 truncate">{agentName(agent) ?? title}</span>
                <AgentTime agent={agent} />
              </button>
            </AgentCard>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** The menu bar item's settings, at hand in both of the agents popovers. */
function MenuBarSettings({ avoidCollisions = true }: Pick<RowProps, 'avoidCollisions'>) {
  const inMenuBar = useConfigStore((s) => s.config?.showAgentsInMenuBar === true);
  const inBackgroundOnly = useConfigStore((s) => s.config?.agentsMenuBarInBackgroundOnly === true);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  // Each switch keeps the menu open, so both can be set in one go.
  const keepOpen = (event: Event) => event.preventDefault();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Menu bar settings" size="xs" className="-my-1 -mr-1.5">
          <GearSix />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" avoidCollisions={avoidCollisions} className="w-72">
        <DropdownMenuCheckboxItem
          checked={inMenuBar}
          onSelect={keepOpen}
          onCheckedChange={(checked) => void updateConfig({ showAgentsInMenuBar: checked })}
        >
          Show in the menu bar
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={inBackgroundOnly}
          disabled={!inMenuBar}
          onSelect={keepOpen}
          onCheckedChange={(checked) =>
            void updateConfig({ agentsMenuBarInBackgroundOnly: checked })
          }
        >
          Only while Komla is in the background
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Finished agents past this many fold into a "more" row, so the panel stays short.
const MAX_DONE_SHOWN = 3;

// The panel's groups, by each workspace's most urgent agent.
const AGENT_GROUPS: { key: string; title: string; states: readonly AgentState[] }[] = [
  { key: 'attention', title: 'Needs you', states: ['input', 'error'] },
  { key: 'done', title: 'Done', states: ['done'] },
  { key: 'working', title: 'Working', states: ['working'] },
];

/**
 * The agents popover's content: their counts, then their workspaces grouped as needing you, done
 * or working by their most urgent agent, each with its agents, and a button that clears the
 * finished ones.
 */
export function AgentsPanel({ agents, listClassName, ...rowProps }: AgentsPanelProps) {
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const shown = agentStateCounts(agents);
  const byWorkspace: Agent[][] = [];
  for (const agent of agents) {
    const group = byWorkspace.find(([first]) => first.workspace.id === agent.workspace.id);
    if (group) group.push(agent);
    else byWorkspace.push([agent]);
  }
  const [showAllDone, setShowAllDone] = useState(false);
  const groups = AGENT_GROUPS.map((group) => {
    const workspaces = byWorkspace.filter(([first]) => group.states.includes(first.state));
    // Done ones past a few fold away until asked for.
    const folds = group.key === 'done' && !showAllDone && workspaces.length > MAX_DONE_SHOWN;
    const listed = folds ? workspaces.slice(0, MAX_DONE_SHOWN - 1) : workspaces;
    const ofGroup = (list: Agent[][]) =>
      list.flat().filter((agent) => group.states.includes(agent.state)).length;
    return {
      ...group,
      workspaces,
      listed,
      // The agents under this header in the group's states: those its rows hold.
      count: ofGroup(workspaces),
      hiddenCount: folds ? ofGroup(workspaces.slice(listed.length)) : 0,
    };
  }).filter((group) => group.workspaces.length > 0);
  const doneCount = shown.find(({ state }) => state === 'done')?.count ?? 0;
  // Clear done heads the Done group when there's one; otherwise, as when a done agent shares a
  // workspace with one that needs you, it sits under the list.
  const doneHeaded = groups.length > 1 && groups.some((group) => group.key === 'done');

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-foreground/10 px-3.5 py-2.5">
        <h2 className="text-[13px] font-semibold">Agents</h2>
        <span className="flex items-center gap-2.5 text-ui text-muted-foreground tabular-nums">
          {/* Grouped, each group heads its rows; on its own, the summary says what's there. */}
          {groups.length === 1 &&
            shown.map(({ state, className, label, count }) => (
              <span key={state} className={cn('flex items-center gap-1', className)}>
                <AgentStateIcon state={state} className="text-current" still />
                {count} {label(count)}
              </span>
            ))}
          {window.api.platform === 'darwin' && (
            <MenuBarSettings avoidCollisions={rowProps.avoidCollisions} />
          )}
        </span>
      </div>
      {byWorkspace.length > 0 ? (
        <ul
          aria-label="Agents"
          className={cn('overflow-y-auto bg-inherit px-1.5 pb-1.5', listClassName)}
        >
          {groups.map((group, index) => (
            <Fragment key={group.key}>
              {groups.length > 1 && (
                <li
                  role="presentation"
                  className={cn(
                    // Stays in view while its rows scroll under it.
                    'sticky top-0 z-10 -mx-1.5 flex h-8 items-center justify-between bg-inherit px-4 text-xs font-semibold text-foreground/70',
                    index > 0 && 'mt-1.5 border-t border-foreground/10'
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    {group.title}
                    <span className="font-medium text-muted-foreground-60 tabular-nums">
                      {group.count}
                    </span>
                  </span>
                  {group.key === 'done' && (
                    <button
                      type="button"
                      className="-mr-1.5 rounded-md px-1.5 py-0.5 text-2xs font-medium text-foreground/75 ring-1 ring-foreground/10 transition-colors ring-inset hover:bg-foreground/8 hover:text-foreground"
                      // Only the overview forgets them: the sidebar and their tabs still show them done.
                      onClick={() => void updateConfig({ agentsDoneClearedAt: Date.now() })}
                    >
                      Clear done
                    </button>
                  )}
                </li>
              )}
              {group.listed.map((agentsHere) =>
                agentsHere.length === 1 ? (
                  <AgentRow key={agentsHere[0].workspace.id} agent={agentsHere[0]} {...rowProps} />
                ) : (
                  <WorkspaceAgents
                    key={agentsHere[0].workspace.id}
                    agents={agentsHere}
                    {...rowProps}
                  />
                )
              )}
              {group.hiddenCount > 0 && (
                <li>
                  <button
                    type="button"
                    className={cn(
                      rowClass,
                      'px-2.5 py-1.5 pl-[34px] text-xs text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() => setShowAllDone(true)}
                  >
                    Show {group.hiddenCount} more done
                    <CaretDown className="ml-1 size-3" />
                  </button>
                </li>
              )}
            </Fragment>
          ))}
        </ul>
      ) : (
        <p className="px-3.5 py-3 text-ui text-muted-foreground">
          No agent needs you or is working.
        </p>
      )}
      {!doneHeaded && doneCount > 0 && (
        <div className="border-t border-foreground/10 p-1.5">
          <button
            type="button"
            className={cn(menuItemClass, 'w-full hover:bg-foreground/8')}
            onClick={() => void updateConfig({ agentsDoneClearedAt: Date.now() })}
          >
            <Check />
            {/* How many, as no Done header counts them. */}
            Clear {doneCount} done
          </button>
        </div>
      )}
    </>
  );
}
