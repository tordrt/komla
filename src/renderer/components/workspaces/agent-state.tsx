import { Question, Warning } from '@phosphor-icons/react';
import { useLayoutEffect, useRef } from 'react';

import { cn } from '@/lib/utils';
import { getWorkspaceAttentionAppearance } from '@/lib/workspace-attention';
import { flashPanes } from '@/stores/pane-flash.store';
import {
  pickWorkspaceAttention,
  showsTerminalRunning,
  showsWorking,
  type Workspace,
  type WorkspaceAttention,
} from '@/types';

import {
  AGENT_STATE_TEXT,
  AGENT_STATES_BY_URGENCY,
  agentStateOf,
  urgency,
  workspaceAgents,
  type Agent,
  type AgentState,
} from '../../../shared/lib/agent-state';

import { ActivitySpinner, StillActivityGlyph, useActivityGlyph } from './activity-spinners';
import { DoneCheck } from './DoneCheck';

export type { Agent, AgentState };
export { AGENT_STATES_BY_URGENCY, agentStateOf, urgency, workspaceAgents };

/** How each state reads, with how a count of agents in it reads, as in "2 need input". */
export const AGENT_STATES: Record<
  AgentState,
  { title: string; className?: string; label: (count: number) => string }
> = {
  input: { ...AGENT_STATE_TEXT.input, className: 'text-attention' },
  error: { ...AGENT_STATE_TEXT.error, className: 'text-error' },
  done: { ...AGENT_STATE_TEXT.done, className: 'text-success' },
  working: AGENT_STATE_TEXT.working,
};

/** Most urgent first. */
export function byUrgency(a: Agent, b: Agent): number {
  return urgency(a.state) - urgency(b.state);
}

/** What the attention says, such as the question an agent asks. */
export function attentionDetail(attention: WorkspaceAttention | undefined): string | undefined {
  return getWorkspaceAttentionAppearance(attention)?.detail;
}

/** When the longest-working of the workspace's working agents started, while any works. */
export function workingSince(workspace: Workspace): number | undefined {
  const starts = workspaceAgents(workspace).flatMap(({ terminal, state }) => {
    const since = terminal ? terminal.agentActiveSince : workspace.agentActiveSince;
    return state === 'working' && since ? [since] : [];
  });
  return starts.length > 0 ? Math.min(...starts) : undefined;
}

/**
 * Flashes the panes of the workspace's agents that wait on the user, such as one that needs input
 * or finished, as a jump to the workspace lands.
 */
export function flashWaitingAgents(workspace: Workspace): void {
  flashPanes(
    workspaceAgents(workspace).flatMap(({ terminal, state }) =>
      terminal && state !== 'working' ? [terminal.id] : []
    )
  );
}

/** The most urgent state of the workspace's agents. */
export function workspaceAgentState(workspace: Workspace): AgentState | null {
  const states = new Set(workspaceAgents(workspace).map(({ state }) => state));
  return AGENT_STATES_BY_URGENCY.find((state) => states.has(state)) ?? null;
}

export interface WorkspaceCardStatus {
  /** The pill: the most urgent attention the user hasn't seen, the latest among equals. */
  attention: WorkspaceAttention | undefined;
  /**
   * Every other agent that needs input, failed, finished or is working, most urgent first, and
   * the pill's own agent when it still works.
   */
  others: Agent[];
}

/**
 * What a workspace's card shows when its tabs are out of view. It reads each terminal's own
 * attention, which stays until the user sees that terminal, so a done the user didn't open stays
 * on the card after they leave the workspace.
 */
export function workspaceCardStatus(workspace: Workspace): WorkspaceCardStatus {
  const workspaceScoped = workspace.attention?.terminalId ? undefined : workspace.attention;
  const attention = pickWorkspaceAttention([
    ...workspace.terminals.map((terminal) => terminal.attention),
    workspaceScoped,
  ]);
  const others: Agent[] = [];
  for (const terminal of workspace.terminals) {
    const working = !!terminal.agentActive && showsTerminalRunning(workspace, terminal);
    const state = agentStateOf(terminal.attention, working);
    // The pill shows its terminal's attention, but not that the agent still works, as after a
    // notice mid-turn.
    if (state && (terminal.id !== attention?.terminalId || state === 'working')) {
      others.push({ workspace, terminal, state });
    }
  }
  // The workspace's own spinner, such as one turned on by hand, or one for a tab that isn't
  // running here yet.
  const terminalWorking = workspace.terminals.some(
    (terminal) => terminal.agentActive && showsTerminalRunning(workspace, terminal)
  );
  if (showsWorking(workspace) && !terminalWorking) others.push({ workspace, state: 'working' });
  return { attention, others: others.sort(byUrgency) };
}

/**
 * How many of the workspace's agents work, as its sidebar card counts them: an agent that needs
 * input or failed isn't counted, and the workspace's own spinner counts when no terminal works.
 */
export function workingAgentCount(workspace: Workspace): number {
  let count = 0;
  let terminalWorking = false;
  for (const terminal of workspace.terminals) {
    if (!terminal.agentActive || !showsTerminalRunning(workspace, terminal)) continue;
    terminalWorking = true;
    if (agentStateOf(terminal.attention, true) === 'working') count += 1;
  }
  if (!terminalWorking && showsWorking(workspace)) count += 1;
  return count;
}

/**
 * How many of the working terminals workingAgentCount counts run only commands started with
 * `komla notify --`, which are no agents.
 */
export function workingCommandCount(workspace: Workspace): number {
  return workspace.terminals.filter(
    (terminal) =>
      terminal.agentActive &&
      terminal.commandActive &&
      showsTerminalRunning(workspace, terminal) &&
      agentStateOf(terminal.attention, true) === 'working'
  ).length;
}

/** What the working agents' spinner announces, when `commands` of them are commands. */
export function workingAgentsLabel(count: number, commands = 0): string {
  const agents = count - commands;
  if (commands === 0) return agents > 1 ? `${agents} agents processing` : 'Agent processing';
  if (agents === 0) return commands > 1 ? `${commands} commands running` : 'Command running';
  return `${agents} ${agents > 1 ? 'agents' : 'agent'} processing, ${commands} ${commands > 1 ? 'commands' : 'command'} running`;
}

export function AgentStateIcon({
  state,
  className,
  still = false,
}: {
  state: AgentState;
  className?: string;
  /** Working shows the still dashed circle whatever spinner Settings picked, for summaries. */
  still?: boolean;
}) {
  if (state === 'input') {
    return (
      <Question
        aria-hidden="true"
        weight="bold"
        className={cn('size-3 shrink-0 text-attention', className)}
      />
    );
  }
  if (state === 'error') {
    return (
      <Warning
        aria-hidden="true"
        weight="bold"
        className={cn('size-3 shrink-0 text-error', className)}
      />
    );
  }
  if (state === 'done') {
    return (
      <DoneCheck
        aria-hidden="true"
        weight="bold"
        className={cn('size-3 shrink-0 text-success', className)}
      />
    );
  }
  const Glyph = still ? StillActivityGlyph : ActivitySpinner;
  return <Glyph className={cn('size-3 shrink-0 text-muted-foreground', className)} />;
}

/**
 * The working agents' spinner, with their count when more than one. A decorative one is hidden
 * from assistive tech, for when nearby text already says the agents work.
 */
export function WorkingAgentsGlyph({
  count,
  commands = 0,
  decorative = false,
}: {
  count: number;
  /** How many of them are commands run with `komla notify --`. */
  commands?: number;
  decorative?: boolean;
}) {
  return (
    <span
      data-working-agents={count}
      className="flex items-center gap-0.5 text-2xs text-muted-foreground"
    >
      <SynchronizedActivitySpinner
        label={decorative ? undefined : workingAgentsLabel(count, commands)}
      />
      {count > 1 && (
        <span aria-hidden="true" className="tabular-nums">
          {count}
        </span>
      )}
    </span>
  );
}

function SynchronizedActivitySpinner({ label }: { label?: string }) {
  const spinnerRef = useRef<HTMLSpanElement>(null);
  const Glyph = useActivityGlyph();

  useLayoutEffect(() => {
    // CSS animations normally start when their element mounts. Anchor every
    // workspace spinner to the document timeline so cards activated later keep
    // the same phase as the spinners already on screen.
    for (const animation of spinnerRef.current?.getAnimations?.({ subtree: true }) ?? []) {
      animation.startTime = 0;
    }
  }, [Glyph]);

  return (
    <span
      ref={spinnerRef}
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
      className="size-3.5 shrink-0"
    >
      {/* oxlint-disable-next-line react/static-components -- one of the fixed spinner glyphs */}
      <Glyph className="size-full text-muted-foreground" />
    </span>
  );
}
