import { useFileListStore } from '@/stores/file-list.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { getDroppedFileAtPathInput, type ImportExternalFile } from './file-drop';

async function confirmLargeFileTransfer(
  largeFiles: readonly File[],
  totalBytes: number
): Promise<boolean> {
  const response = await window.api.showMessageBox({
    type: 'warning',
    title: 'Transfer large files?',
    message: `Transfer ${largeFiles.length === 1 ? largeFiles[0].name : `${largeFiles.length} files`} (${(totalBytes / (1024 * 1024)).toFixed(1)} MB)?`,
    detail: 'Large file transfers may take a while, especially for remote workspaces.',
    buttons: ['Transfer', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

/**
 * Copies files dropped or pasted from outside Komla into a workspace, asking first when they're
 * large, and returns their `@path` references, each followed by a space, or null with none
 * copied. An error toast names the files that couldn't be copied.
 */
export async function importFilesAsReferences(
  files: readonly File[],
  importExternalFile: ImportExternalFile
): Promise<string | null> {
  const failedFiles: string[] = [];
  const input = await getDroppedFileAtPathInput(
    files,
    window.api.getPathForFile,
    async (sourcePath, preferredName) => {
      try {
        return await importExternalFile(sourcePath, preferredName);
      } catch (err) {
        failedFiles.push(preferredName ?? 'file');
        throw err;
      }
    },
    confirmLargeFileTransfer
  );
  if (failedFiles.length > 0) {
    useToastStore.getState().addToast(couldNotUploadMessage(failedFiles), 'error');
  }
  return input;
}

/** The error for files that couldn't be copied in, by name. */
export function couldNotUploadMessage(names: readonly string[]): string {
  return names.length === 1
    ? `Couldn’t upload ${names[0]}`
    : `Couldn’t upload ${names.length} files`;
}

/** Imports land in `.komla-files`, which the Remote Companion ignores, so re-list the tree. */
export function refreshFileListAfterImport(workspaceId: string): void {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return;
  void useFileListStore
    .getState()
    .fetchFileList(workspace.workingDirectory, false, workspaceId)
    .catch(() => undefined);
}
