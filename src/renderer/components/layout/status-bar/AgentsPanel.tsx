import { Check, GearSix, GitBranch } from '@phosphor-icons/react';

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
import { AgentDetails, agentName, AgentTime } from '@/components/workspaces/AgentDetails';
import {
  getWorkspaceDisplayTitle,
  WorkspaceInfoCardContent,
} from '@/components/workspaces/WorkspaceInfoCard';
import { getProjectColor } from '@/lib/project-colors';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';

import { agentSince, clearedFromOverview } from '../../../../shared/lib/agent-state';

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
        sideOffset={8}
        collisionPadding={8}
        avoidCollisions={avoidCollisions}
        className={cn(
          'rounded-[calc(var(--radius)+2px)] p-0 shadow-xl select-text',
          // Beside the panel, the card narrows to the room the window has on its side.
          avoidCollisions
            ? 'w-[clamp(13rem,var(--radix-tooltip-content-available-width),20rem)]'
            : 'w-80'
        )}
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
    <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
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
  const inBackgroundOnly = useConfigStore((s) => s.config?.agentsMenuBarInBackgroundOnly !== false);
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

/**
 * The agents popover's content: their counts, their workspaces in the order of their most urgent
 * agent, each with its agents, and a button that clears the finished ones.
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

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-foreground/10 px-3.5 py-2.5">
        <h2 className="text-[13px] font-semibold">Agents</h2>
        <span className="flex items-center gap-2.5 text-ui text-muted-foreground tabular-nums">
          {shown.map(({ state, className, label, count }) => (
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
        <ul aria-label="Agents" className={cn('overflow-y-auto p-1.5', listClassName)}>
          {byWorkspace.map((agentsHere) =>
            agentsHere.length === 1 ? (
              <AgentRow key={agentsHere[0].workspace.id} agent={agentsHere[0]} {...rowProps} />
            ) : (
              <WorkspaceAgents key={agentsHere[0].workspace.id} agents={agentsHere} {...rowProps} />
            )
          )}
        </ul>
      ) : (
        <p className="px-3.5 py-3 text-ui text-muted-foreground">
          No agent needs you or is working.
        </p>
      )}
      {shown.some(({ state }) => state === 'done') && (
        <div className="border-t border-foreground/10 p-1.5">
          <button
            type="button"
            className={cn(menuItemClass, 'w-full hover:bg-foreground/8')}
            // Only the overview forgets them: the sidebar and their tabs still show them done.
            onClick={() => void updateConfig({ agentsDoneClearedAt: Date.now() })}
          >
            <Check />
            Clear done
          </button>
        </div>
      )}
    </>
  );
}
