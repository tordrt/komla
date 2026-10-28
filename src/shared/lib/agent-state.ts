import { showsTerminalRunning, showsWorking } from './terminal-execution-state';

import type { Terminal, Workspace, WorkspaceAttention } from '../types';

export type AgentState = 'input' | 'error' | 'done' | 'working';

/**
 * Most urgent first: an agent waiting on the user comes before a failed one, then one that
 * finished a turn the user hasn't seen, then a working one.
 */
export const AGENT_STATES_BY_URGENCY: readonly AgentState[] = ['input', 'error', 'done', 'working'];

/** How each state reads, with how a count of agents in it reads, as in "2 need input". */
export const AGENT_STATE_TEXT: Record<
  AgentState,
  { title: string; label: (count: number) => string }
> = {
  input: { title: 'Needs input', label: (count) => `${count === 1 ? 'needs' : 'need'} input` },
  error: { title: 'Error', label: (count) => (count === 1 ? 'error' : 'errors') },
  done: { title: 'Done', label: () => 'done' },
  working: { title: 'Working', label: () => 'working' },
};

/** An agent and what it's doing; without a terminal, the workspace's own spinner or attention. */
export interface Agent {
  workspace: Workspace;
  terminal?: Terminal;
  state: AgentState;
}

/**
 * In the sidebar's order of precedence: an agent waiting on the user isn't also counted as
 * working, and a working agent's done is from an earlier turn. An idle reminder or a notice is
 * no state of its own.
 */
export function agentStateOf(
  attention: WorkspaceAttention | undefined,
  working: boolean
): AgentState | null {
  if (attention?.kind === 'input-required') return 'input';
  if (attention?.kind === 'error') return 'error';
  if (working) return 'working';
  return attention?.kind === 'turn-complete' && !attention.seen ? 'done' : null;
}

/** Lower is more urgent. */
export function urgency(state: AgentState): number {
  return AGENT_STATES_BY_URGENCY.indexOf(state);
}

/**
 * The workspace's agents that need input, failed, finished or are working: one per running
 * terminal, as its tab shows it. Without any, the workspace's own spinner or attention counts as
 * one, such as its spinner turned on by hand or an alert whose terminal has since stopped.
 */
export function workspaceAgents(workspace: Workspace): Agent[] {
  const agents: Agent[] = [];
  for (const terminal of workspace.terminals) {
    if (!showsTerminalRunning(workspace, terminal)) continue;
    const state = agentStateOf(terminal.attention, !!terminal.agentActive);
    if (state) agents.push({ workspace, terminal, state });
  }
  if (agents.length > 0) return agents;
  const state = agentStateOf(workspace.attention, showsWorking(workspace));
  return state ? [{ workspace, state }] : [];
}

/** The attention the agent shows: its terminal's, or the workspace's own without one. */
export function agentAttention({ workspace, terminal }: Agent): WorkspaceAttention | undefined {
  return terminal ? terminal.attention : workspace.attention;
}

/** Since when the agent is in its state: when it started working, or when it last notified. */
export function agentSince(agent: Agent): number | undefined {
  if (agent.state !== 'working') return agentAttention(agent)?.updatedAt;
  return agent.terminal ? agent.terminal.agentActiveSince : agent.workspace.agentActiveSince;
}

/**
 * Whether the agents overview, the status bar's item and the menu bar's, leaves the agent out: it
 * finished before the overview last cleared its finished agents. The rest of Komla still shows it.
 */
export function clearedFromOverview(agent: Agent, clearedAt: number | undefined): boolean {
  return agent.state === 'done' && clearedAt !== undefined && (agentSince(agent) ?? 0) <= clearedAt;
}

/** "2 need input, 1 working", most urgent first, for agents of the given states. */
export function agentCountsSummary(agents: readonly Pick<Agent, 'state'>[]): string {
  return AGENT_STATES_BY_URGENCY.flatMap((state) => {
    const count = agents.filter((agent) => agent.state === state).length;
    return count > 0 ? [`${count} ${AGENT_STATE_TEXT[state].label(count)}`] : [];
  }).join(', ');
}
