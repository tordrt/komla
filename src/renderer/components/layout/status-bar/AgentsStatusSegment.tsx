import { useState } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AgentStateIcon,
  flashWaitingAgents,
  type Agent,
} from '@/components/workspaces/agent-state';
import { isListedInWorkspaceList } from '@/components/workspaces/workspace-list-filtering';
import { openWorkspace } from '@/lib/open-workspace';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { agentCountsSummary } from '../../../../shared/lib/agent-state';

import { AgentsPanel, agentStateCounts, listAgents } from './AgentsPanel';
import { StatusBarButton } from './StatusBarButton';

/**
 * The agents in this window's sidebar workspaces that need input, failed, finished or are
 * working, most urgent first, but for the finished ones the overview cleared.
 */
function useListedAgents(): Agent[] {
  const currentWindowId = useWindowStore((s) => s.windowId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const hiddenWorkspaceHostIds = useWorkspacesStore((s) => s.hiddenWorkspaceHostIds);
  const hideStopped = useWorkspacesStore((s) => s.hideStopped);
  const hiddenProjectIds = useWorkspacesStore((s) => s.hiddenProjectIds);
  const doneClearedAt = useConfigStore((s) => s.config?.agentsDoneClearedAt);

  return listAgents(
    workspaces.filter((workspace) =>
      isListedInWorkspaceList(workspace, {
        currentWindowId,
        hideStopped,
        hiddenProjectIds,
        hiddenWorkspaceHostIds,
      })
    ),
    doneClearedAt
  );
}

/**
 * Agents that need input, failed, finished a turn the user hasn't seen, or are working, in this
 * window's sidebar, one per terminal. Opens a list of them under their states, each with its
 * workspace; clicking one opens its pane.
 */
export function AgentsStatusSegment() {
  const [open, setOpen] = useState(false);
  const agents = useListedAgents();
  const projects = useProjectsStore((s) => s.projects);
  const currentWindowId = useWindowStore((s) => s.windowId);
  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const shown = agentStateCounts(agents);
  if (shown.length === 0) return null;

  const summary = agentCountsSummary(agents);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <StatusBarButton
          aria-label={summary}
          tooltip={`Agents: ${summary}`}
          // Every state in one pill, still, as in the menu bar.
          className="gap-2.5 rounded-full bg-foreground/8 px-2 tabular-nums hover:bg-foreground/14 data-[state=open]:bg-foreground/14"
        >
          {shown.map(({ state, className, label, count }) => (
            <span key={state} className={cn('flex items-center gap-1', className)}>
              <AgentStateIcon state={state} className="text-current" still />
              {count}
              <span className="@max-3xl:hidden">{label(count)}</span>
            </span>
          ))}
        </StatusBarButton>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-100 p-0 text-xs"
        // Focusing the first row would open its tooltip; Tab still moves into the list.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        <AgentsPanel
          agents={agents}
          listClassName="max-h-[70vh]"
          projects={projects}
          selectedWorkspaceId={selectedWorkspaceId}
          onOpenAgent={({ workspace, terminal }) => {
            if (terminal) {
              void openWorkspace(workspace, currentWindowId, terminal.id);
            } else {
              flashWaitingAgents(workspace);
              void openWorkspace(workspace, currentWindowId);
            }
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
