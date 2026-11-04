import { useProjectsStore } from '@/stores/projects.store';
import { usePublishRepoDialogStore } from '@/stores/publish-repo-dialog.store';
import { useToastStore } from '@/stores/toast.store';

import {
  DUPLICATE_WORKSPACE_ERROR_PREFIX,
  OPENCODE_HOLDS_WORKTREE_ERROR_PREFIX,
  SshProjectNeedsRemoteError,
} from '../../shared/types/workspace';

const ERROR_PREFIXES = [DUPLICATE_WORKSPACE_ERROR_PREFIX, OPENCODE_HOLDS_WORKTREE_ERROR_PREFIX];

/** A workspace delete failed because opencode's background service still uses the worktree. */
export function isOpenCodeHoldsWorktreeError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(OPENCODE_HOLDS_WORKTREE_ERROR_PREFIX);
}

/** Strip any known internal error prefix so user-facing messages read cleanly. */
export function stripErrorPrefix(err: Error): string {
  let msg = err.message;

  // Strip Electron IPC wrapper (e.g. "Error invoking remote method 'workspace:create': Error: ...")
  const ipcMatch = msg.match(/^Error invoking remote method '[^']+': (?:Error: )?/);
  if (ipcMatch) {
    msg = msg.slice(ipcMatch[0].length);
  }

  for (const prefix of ERROR_PREFIXES) {
    const idx = msg.indexOf(prefix);
    if (idx >= 0) return msg.slice(idx + prefix.length).trim();
  }
  return msg;
}

export function handleCreateError(err: unknown, retry?: () => void): void {
  if (
    err instanceof SshProjectNeedsRemoteError &&
    useProjectsStore.getState().projects.some((project) => project.id === err.detail.projectId)
  ) {
    // Offer to publish the project instead of failing, then create the workspace again.
    usePublishRepoDialogStore.getState().openForProject({ ...err.detail, onPublished: retry });
  } else {
    const message = err instanceof Error ? stripErrorPrefix(err) : String(err);
    useToastStore.getState().addToast(`Failed to create workspace: ${message}`, 'error');
  }
}
