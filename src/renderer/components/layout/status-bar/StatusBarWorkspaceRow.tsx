import { flashWaitingAgents } from '@/components/workspaces/agent-state';
import { openWorkspace } from '@/lib/open-workspace';
import { cn } from '@/lib/utils';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import type { Workspace } from '@/types';
import type * as React from 'react';

/** The name the sidebar shows for a workspace. */
export function workspaceLabel(workspace: Pick<Workspace, 'customName' | 'name'>): string {
  return workspace.customName || workspace.name;
}

/** A workspace in a status bar popover; clicking it opens the workspace, in whichever window. */
export function StatusBarWorkspaceRow({
  workspace,
  leading,
  trailing,
  onOpen,
  children,
}: {
  workspace: Workspace;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  /** Called after the workspace opens, e.g. to close the popover. */
  onOpen?: () => void;
  /** Lines nested under the workspace's name, such as one per agent. */
  children?: React.ReactNode;
}) {
  const selected = useWorkspacesStore((s) => s.selectedWorkspaceId === workspace.id);
  const currentWindowId = useWindowStore((s) => s.windowId);
  return (
    <li>
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-foreground/8',
          selected && 'bg-foreground/5'
        )}
        aria-current={selected ? 'true' : undefined}
        onClick={() => {
          flashWaitingAgents(workspace);
          void openWorkspace(workspace, currentWindowId);
          onOpen?.();
        }}
      >
        {leading}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{workspaceLabel(workspace)}</span>
          {children}
        </span>
        {trailing && (
          <span className="shrink-0 text-ui text-muted-foreground tabular-nums">{trailing}</span>
        )}
      </button>
    </li>
  );
}
