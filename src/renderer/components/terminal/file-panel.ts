import { getFileLanguage } from '@/components/workspaces/file-viewer/file-viewer-utils';
import { useFileViewerStore } from '@/stores/file-viewer.store';

import { getViewableFileKind, isMediaFile, isPdfFile } from '../../../shared/image-utils';

/**
 * Whether the file panel can show a workspace file. It reads a file of a type it doesn't know as
 * text, whole, so archives, databases and other unknown types go to quick look, which reads only
 * so much and says when a file has no preview. It previews PDFs and media only on this computer.
 */
export function filePanelShows(filePath: string, workspaceBackendKind: 'local' | 'ssh'): boolean {
  if (workspaceBackendKind === 'ssh' && (isPdfFile(filePath) || isMediaFile(filePath))) {
    return false;
  }
  return getFileLanguage(filePath) !== 'plaintext' || getViewableFileKind(filePath) !== null;
}

/**
 * Opens a workspace file in the file panel, or in the full viewer while that covers the panel. The
 * panel's tree switches to its files, as the diff lists only changed ones, so it shows the file.
 */
export function openInFilePanel(
  workspaceId: string,
  filePath: string,
  lineNumber: number | undefined
): void {
  const fileViewer = useFileViewerStore.getState();
  if (fileViewer.fileViewerWorkspaceId === workspaceId) {
    fileViewer.requestFileViewerTransition({
      kind: 'mode',
      workspaceId,
      mode: 'browse',
      after: { kind: 'browse-file', filePath, lineNumber },
    });
    return;
  }
  fileViewer.requestInlineFilePreviewNav(workspaceId, 'browse', filePath, lineNumber, {
    browseTree: true,
  });
}
