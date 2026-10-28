import { isBrowserPreviewableFile } from '../../../shared/image-utils';

import type { FileViewerMode } from '../workspaces/file-viewer/types';

export function getNextSeenWorktreeEventAt(
  lastSeenWorktreeEventAt: number,
  eventAt: number
): number {
  return Math.max(lastSeenWorktreeEventAt, eventAt);
}

export function shouldRefreshBrowsePreviewOnReactivate(params: {
  wasActive: boolean;
  isActive: boolean;
  lastWorktreeEventAt: number;
  lastSeenWorktreeEventAt: number;
  isPreviewOpen: boolean;
  mode: FileViewerMode;
  filePath: string | null;
}): boolean {
  const {
    wasActive,
    isActive,
    lastWorktreeEventAt,
    lastSeenWorktreeEventAt,
    isPreviewOpen,
    mode,
    filePath,
  } = params;
  return (
    isActive &&
    !wasActive &&
    lastWorktreeEventAt > lastSeenWorktreeEventAt &&
    isPreviewOpen &&
    mode === 'browse' &&
    !!filePath
  );
}

export function shouldOfferDiffBrowserPreview(params: {
  mode: FileViewerMode;
  filePath: string;
  fileStatus: string | undefined;
}): boolean {
  return (
    params.mode === 'diff' &&
    isBrowserPreviewableFile(params.filePath) &&
    params.fileStatus !== 'deleted'
  );
}
