import { useSshCommandExecutionLocationStore } from '@/stores/ssh-command-execution-location.store';
import { useToastStore } from '@/stores/toast.store';

import type { Action, Workspace } from '@/types';

/**
 * Runs a background command Action, first asking where it runs in an SSH workspace when the
 * project hasn't chosen. `command` is the Action's content with launch values filled in.
 * Returns whether the run started.
 */
export async function runBackgroundAction(
  workspace: Workspace,
  action: Action,
  command = action.content
): Promise<boolean> {
  const executionLocation = await useSshCommandExecutionLocationStore
    .getState()
    .requestExecutionLocation(workspace, action.sshExecutionLocation);
  if (!executionLocation) return false;
  try {
    await window.api.runBackgroundAction(workspace.id, action.id, {
      command,
      // `remote` only bypasses the project's Local copy; a background run there uses the host.
      executionLocation: executionLocation === 'local-mirror' ? 'local-mirror' : 'workspace',
    });
    return true;
  } catch (error) {
    useToastStore
      .getState()
      .addToast(`Could not run ${action.title}: ${(error as Error).message}`, 'error');
    return false;
  }
}
