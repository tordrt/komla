import { showsRunning, type Workspace, type WorkspaceAttentionKind } from '@/types';

/**
 * Listed in this order: workspaces whose agent is waiting on the user first, then
 * ones with a live terminal or tmux session, and ones in the Trash last.
 */
export const WORKSPACE_STATE_GROUPS = ['attention', 'running', 'stopped', 'trash'] as const;
export type WorkspaceStateGroup = (typeof WORKSPACE_STATE_GROUPS)[number];

export const WORKSPACE_STATE_GROUP_LABELS: Record<WorkspaceStateGroup, string> = {
  attention: 'Needs attention',
  running: 'Running',
  stopped: 'Stopped',
  trash: 'Trash',
};

// The agent needs input, hit an error, or finished its turn.
const ATTENTION_KINDS: ReadonlySet<WorkspaceAttentionKind> = new Set([
  'input-required',
  'error',
  'turn-complete',
]);

export function getWorkspaceStateGroup(workspace: Workspace): WorkspaceStateGroup {
  // Put away by the user, even if a terminal hasn't wound down yet.
  if (workspace.status === 'trashed') return 'trash';
  if (workspace.attention && ATTENTION_KINDS.has(workspace.attention.kind)) return 'attention';
  return showsRunning(workspace) ? 'running' : 'stopped';
}

/**
 * When the workspace was last touched: its files changed, a prompt was sent, or a
 * notification arrived. File changes alone miss a day spent chatting with the agent.
 */
export function getWorkspaceLastTouchedAt(workspace: Workspace): number {
  return Math.max(
    workspace.lastActivityAt || workspace.createdAt,
    workspace.promptSubmits?.at(-1)?.submittedAt ?? 0,
    workspace.attention?.updatedAt ?? 0
  );
}
