import { useToastStore } from '@/stores/toast.store';

import { isSshWorkspace } from '../../shared/types';

import type { Workspace } from '../../shared/types';
import type { ViewerFileSource } from '../../shared/types/viewer-file';

/**
 * Whether a file is on an SSH host, so it is downloaded to be on this computer: a file in an SSH
 * workspace, or one a terminal there prints the path of, unless the terminal runs in its Local copy.
 */
export function isOnSshHost(
  workspace: Workspace | undefined,
  terminalId: string,
  source: ViewerFileSource
): boolean {
  if (!workspace || !isSshWorkspace(workspace)) return false;
  if (source.kind === 'workspace') return true;
  const terminal = workspace.terminals.find((candidate) => candidate.id === terminalId);
  return terminal !== undefined && terminal.executionLocation !== 'local-copy';
}

/**
 * Saves a file on an SSH host to this computer: asks where, then says where it went, or why
 * it couldn't be saved. Nothing happens if the person cancels the dialog.
 */
export async function downloadViewerFile(
  workspaceId: string,
  terminalId: string | null,
  source: ViewerFileSource
): Promise<void> {
  const { addToast } = useToastStore.getState();
  try {
    const savedPath = await window.api.downloadViewerFile(workspaceId, terminalId, source);
    if (savedPath) addToast(`Saved to ${savedPath}`, 'success');
  } catch (error) {
    addToast(`Couldn't download the file: ${(error as Error).message}`, 'error');
  }
}
