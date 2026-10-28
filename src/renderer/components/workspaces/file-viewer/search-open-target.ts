import { useFileViewerStore } from '@/stores/file-viewer.store';

export type OpenTarget = 'viewer' | 'preview';
export type ConfiguredOpenMode = OpenTarget | 'current';

export function resolveDefaultOpenMode(
  configured: ConfiguredOpenMode,
  fileViewerOpenForWorkspace: boolean
): OpenTarget {
  if (configured !== 'current') return configured;
  return fileViewerOpenForWorkspace ? 'viewer' : 'preview';
}

export function resolveOpenTarget(shiftKey: boolean, defaultOpenMode: OpenTarget): OpenTarget {
  if (!shiftKey) return defaultOpenMode;
  return defaultOpenMode === 'viewer' ? 'preview' : 'viewer';
}

/** Opens a file search result in the workspace's file viewer, or inline beside its terminals. */
export function openFileSearchResult(
  workspaceId: string,
  path: string,
  lineNumber: number | undefined,
  target: OpenTarget
): void {
  // The right-pane tree highlights the opened file via its currentFile prop,
  // and diff mode hides files outside the change list — flip to browse so
  // the search target stays visible and selectable in the tree.
  const store = useFileViewerStore.getState();
  if (store.inlineFileTreeByWorkspace[workspaceId]?.mode === 'diff') {
    store.setInlineFileTreeMode(workspaceId, 'browse');
  }
  if (target === 'preview') {
    store.requestFileViewerTransition({
      kind: 'inline-preview',
      workspaceId,
      filePath: path,
      lineNumber,
    });
  } else {
    store.requestFileViewerTransition({
      kind: 'file',
      workspaceId,
      filePath: path,
      lineNumber,
      browseAction: 'preview',
    });
  }
}
