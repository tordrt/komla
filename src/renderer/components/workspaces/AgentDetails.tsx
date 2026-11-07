import { Timer } from '@phosphor-icons/react';

import { useNow } from '@/hooks/useNow';
import { formatElapsed, formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { getWorkspaceAttentionAppearance } from '@/lib/workspace-attention';

import { agentAttention, agentSince } from '../../../shared/lib/agent-state';

import { AGENT_STATES, AgentStateIcon, type Agent } from './agent-state';
import { getWorkspaceDisplayTitle, stripAgentTitleGlyphs } from './WorkspaceInfoCard';

/** How long ago the agent got to its state, or how long it has worked, as its row shows it. */
export function agentWhen(agent: Agent, now: number): string | undefined {
  const since = agentSince(agent);
  if (since === undefined) return undefined;
  return agent.state === 'working' ? formatElapsed(now - since) : formatRelativeTime(since);
}

/** Marks a time as how long an agent has worked, not how long ago something happened. */
export function WorkingStopwatch() {
  return <Timer aria-hidden className="mr-0.5 inline size-3 align-[-2px]" />;
}

/** The row's time, where a stopwatch tells how long it has worked from how long ago it got there. */
export function AgentTime({ agent, className }: { agent: Agent; className?: string }) {
  const when = agentWhen(agent, useNow());
  if (!when) return null;
  return (
    <span
      title={agent.state === 'working' ? `Working for ${when}` : undefined}
      className={cn('shrink-0 text-2xs text-muted-foreground tabular-nums', className)}
    >
      {agent.state === 'working' && <WorkingStopwatch />}
      {when}
    </span>
  );
}

/** What the agent said, for a line of its own: a title it gave, or its message. */
export function agentSaid(agent: Agent): string | undefined {
  if (agent.state === 'working') return undefined;
  const attention = agentAttention(agent);
  const appearance = getWorkspaceAttentionAppearance(attention);
  return attention?.title ? appearance?.heading : appearance?.detail;
}

/** A title as its words: without the spinner glyph, spaces at its ends, or case. */
function titleWords(title: string): string {
  return stripAgentTitleGlyphs(title).trim().toLowerCase();
}

/**
 * What the agent did or does, by the title it gave its terminal, without the spinner glyph: not
 * a title that only repeats its name or its workspace's, nor one over a heading its notification
 * gave.
 */
export function agentTaskTitle(agent: Agent): string | undefined {
  const { terminal, workspace } = agent;
  const title = terminal?.dynamicTitle && stripAgentTitleGlyphs(terminal.dynamicTitle).trim();
  if (!title) return undefined;
  const words = title.toLowerCase();
  if (
    words === titleWords(terminal.name) ||
    words === titleWords(getWorkspaceDisplayTitle(workspace))
  )
    return undefined;
  if (agent.state !== 'working' && agentAttention(agent)?.title) return undefined;
  return title;
}

/** Which agent it is: its terminal's title, or its name where the workspace goes by that title. */
export function agentName({
  workspace,
  terminal,
}: Pick<Agent, 'workspace' | 'terminal'>): string | undefined {
  const terminalTitle = terminal && (terminal.dynamicTitle || terminal.name);
  const name =
    terminalTitle !== getWorkspaceDisplayTitle(workspace) ? terminalTitle : terminal?.name;
  return name || undefined;
}

/**
 * The agent's state and since when, its terminal, and what it said, in its workspace's card: a
 * title it gave, and its message. A working agent says nothing yet.
 */
export function AgentDetails({
  agent,
  unnamed,
  showName = true,
  className,
}: {
  agent: Agent;
  /** What to call an agent without a terminal, such as the workspace's own spinner. */
  unnamed?: string;
  /** Whether it names the agent; off where what's around it already does. */
  showName?: boolean;
  className?: string;
}) {
  const { title, className: stateClassName } = AGENT_STATES[agent.state];
  const name = !showName ? undefined : agent.terminal ? agentName(agent) : unnamed;
  const when = agentWhen(agent, useNow());
  const appearance =
    agent.state === 'working' ? undefined : getWorkspaceAttentionAppearance(agentAttention(agent));
  // Without blank lines between its paragraphs, which would each take one of its four lines.
  const said = appearance?.detail?.replace(/\n\s*\n/g, '\n');
  // Only a title it gave: without one, the heading just says what its state already does.
  const heading = agentAttention(agent)?.title && appearance?.heading;
  return (
    <div
      className={cn(
        'mt-2.5 space-y-1 rounded-md bg-foreground/[0.04] px-2.5 py-2 text-xs',
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <AgentStateIcon state={agent.state} />
        <span className={cn('shrink-0 font-medium', stateClassName)}>{title}</span>
        {when && (
          <span className="shrink-0 text-muted-foreground">
            {agent.state === 'working'
              ? `for ${when}`
              : when === 'now'
                ? 'just now'
                : `${when} ago`}
          </span>
        )}
        {name && <span className="ml-auto min-w-0 truncate text-muted-foreground">{name}</span>}
      </div>
      {heading && heading !== said && (
        <p className="font-medium break-words text-popover-foreground">{heading}</p>
      )}
      {said && (
        <p className="line-clamp-4 leading-relaxed break-words whitespace-pre-wrap text-popover-foreground/90">
          {said}
        </p>
      )}
    </div>
  );
}
