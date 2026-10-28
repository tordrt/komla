import { useGitStatusStore } from '@/stores/git-status.store';
import { type RebaseWorkspace, useRebaseAbortStore } from '@/stores/rebase-abort.store';
import { useToastStore } from '@/stores/toast.store';

/** Conflict toasts that still offer Abort rebase, by workspace, so an abort can retire them. */
const abortToastIds = new Map<string, string>();
const abortingWorkspaceIds = new Set<string>();

/** Asks the user to confirm, since aborting discards conflict resolutions made during the pause. */
export function requestRebaseAbort(workspace: RebaseWorkspace): void {
  useRebaseAbortStore.getState().requestAbort(workspace);
}

/** Aborts the workspace's paused rebase, reports a failure, and refreshes its branch status. */
export async function abortWorkspaceRebase(workspace: RebaseWorkspace): Promise<void> {
  // The menu and the conflict toast can both ask; one abort is enough.
  if (abortingWorkspaceIds.has(workspace.id)) return;
  abortingWorkspaceIds.add(workspace.id);

  const { addToast, removeToast } = useToastStore.getState();
  const toastId = abortToastIds.get(workspace.id);
  if (toastId) {
    removeToast(toastId);
    abortToastIds.delete(workspace.id);
  }

  try {
    const result = await window.api
      .abortRebase(workspace.workingDirectory)
      .catch((error: Error) => ({ success: false, message: error.message }));
    if (!result.success) addToast(result.message, 'error');

    const { invalidateStatus, fetchStatus } = useGitStatusStore.getState();
    invalidateStatus(workspace.id);
    await fetchStatus(workspace.id, workspace.workingDirectory, workspace.projectId);
  } finally {
    abortingWorkspaceIds.delete(workspace.id);
  }
}

/**
 * Reports a failed rebase. Conflicts leave the rebase paused for the user or an agent to
 * resolve, so read the refreshed branch status and offer the way back out.
 */
export function addRebaseFailureToast(message: string, workspace: RebaseWorkspace): void {
  const { addToast } = useToastStore.getState();
  const paused = useGitStatusStore.getState().getStatus(workspace.id)?.status.rebaseInProgress;
  if (!paused) {
    addToast(message, 'error');
    return;
  }

  const { id, workingDirectory, projectId } = workspace;
  const toastId = addToast(message, 'error', {
    action: {
      label: 'Abort rebase',
      onClick: () => requestRebaseAbort({ id, workingDirectory, projectId }),
    },
  });
  abortToastIds.set(id, toastId);
}
