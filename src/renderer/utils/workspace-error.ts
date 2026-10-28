import { useProjectsStore } from '@/stores/projects.store';
import { usePublishRepoDialogStore } from '@/stores/publish-repo-dialog.store';
import { useToastStore } from '@/stores/toast.store';

import {
  WORKSPACE_LIMIT_ERROR_PREFIX,
  DUPLICATE_WORKSPACE_ERROR_PREFIX,
  OPENCODE_HOLDS_WORKTREE_ERROR_PREFIX,
  SshProjectNeedsRemoteError,
} from '../../shared/types/workspace';

import type { UpgradeTrigger } from '@/components/layout/UpgradeDialog';

const ERROR_PREFIXES = [
  WORKSPACE_LIMIT_ERROR_PREFIX,
  DUPLICATE_WORKSPACE_ERROR_PREFIX,
  OPENCODE_HOLDS_WORKTREE_ERROR_PREFIX,
];

export type UpgradeRetryAction = (() => void) & {
  requestedWorkspaceCount?: number;
};

export interface UpgradeDialogRequest {
  retry?: UpgradeRetryAction;
  /** Why the dialog opens; a hit limit unless something else asks for the offer. */
  trigger?: UpgradeTrigger;
}

export function isRunningLimitError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(WORKSPACE_LIMIT_ERROR_PREFIX);
}

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

export function showUpgradeDialog(retry?: () => void, requestedWorkspaceCount = 1): void {
  // App already carries the retry callback through to UpgradeDialog. Attach
  // the requested capacity so the dialog can calculate multi-run slot needs
  // without duplicating that global dialog state in App.
  const retryAction: UpgradeRetryAction | undefined = retry
    ? Object.assign(() => retry(), { requestedWorkspaceCount })
    : undefined;
  const detail: UpgradeDialogRequest = { retry: retryAction };
  window.dispatchEvent(new CustomEvent<UpgradeDialogRequest>('show-upgrade-dialog', { detail }));
}

export function handleCreateError(err: unknown, retry?: () => void): void {
  if (isRunningLimitError(err)) {
    showUpgradeDialog(retry);
  } else if (
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
