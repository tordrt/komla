import { createFolderWorkspace } from '@/lib/open-folder';
import { useToastStore } from '@/stores/toast.store';

/**
 * Creates a Scratch workspace in an empty folder Komla makes for it. False when it couldn't,
 * which it has told the user.
 */
export function createScratchWorkspace(): Promise<boolean> {
  return createFolderWorkspace({ scratch: true });
}

/**
 * Keeps a Scratch workspace's folder, which then outlasts the workspace and joins a folder
 * project. Main broadcasts the change; a failure is shown to the user.
 */
export async function keepScratchFolder(workspaceId: string): Promise<void> {
  try {
    await window.api.keepScratchWorkspace(workspaceId);
  } catch {
    useToastStore.getState().addToast('Could not keep the scratch folder', 'error');
  }
}
