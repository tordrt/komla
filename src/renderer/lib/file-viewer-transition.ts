export type FileViewerMode = 'browse' | 'diff';
export type DiffSubMode = 'changes' | 'history';

export type FileViewerTransition =
  | {
      kind: 'mode';
      mode: FileViewerMode;
      diffSubMode?: DiffSubMode;
      after?:
        | { kind: 'history-file'; filePath: string | null }
        | { kind: 'browser-file'; filePath: string }
        | { kind: 'browse-file'; filePath: string; lineNumber?: number; enableBlame?: boolean }
        | { kind: 'diff-file'; filePath: string }
        | { kind: 'commit'; commitHash: string; filePath?: string };
    }
  | {
      kind: 'file';
      filePath: string;
      browseAction: 'preview' | 'persistent' | 'close-tab' | null;
      lineNumber?: number;
    }
  | { kind: 'close' }
  | { kind: 'inline-preview'; filePath: string; lineNumber?: number };

/** Toggle requests resolve to a mode or close transition before they are stored. */
export type PendingFileViewerTransition = FileViewerTransition & { workspaceId: string };

export type FileViewerTransitionRequest =
  | PendingFileViewerTransition
  | {
      kind: 'toggle';
      workspaceId: string;
      mode: FileViewerMode;
      diffSubMode?: DiffSubMode;
    };

export type FileViewerTransitionDecision =
  | { kind: 'apply'; transition: FileViewerTransition }
  | { kind: 'confirm'; transition: FileViewerTransition };

export function decideFileViewerTransition(
  transition: FileViewerTransition,
  context: {
    dirty: boolean;
    mode: FileViewerMode;
    diffSubMode: DiffSubMode;
    currentFilePath?: string | null;
  }
): FileViewerTransitionDecision {
  if (!context.dirty) return { kind: 'apply', transition };

  if (transition.kind === 'mode') {
    const changesMode = transition.mode !== context.mode;
    const changesDiffSubMode =
      transition.mode === 'diff' &&
      transition.diffSubMode !== undefined &&
      transition.diffSubMode !== context.diffSubMode;
    const changesFile =
      (transition.after?.kind === 'browser-file' || transition.after?.kind === 'browse-file') &&
      transition.after.filePath !== context.currentFilePath;
    return changesMode || changesDiffSubMode || changesFile
      ? { kind: 'confirm', transition }
      : { kind: 'apply', transition };
  }

  return { kind: 'confirm', transition };
}

export function describeFileViewerTransition(transition: FileViewerTransition | null): string {
  if (!transition) return 'close';
  if (transition.kind === 'inline-preview') return 'switch to the inline preview';
  if (transition.kind === 'mode') return 'switch view mode';
  if (transition.kind === 'file' && transition.browseAction === 'close-tab') {
    return 'close this tab';
  }
  if (transition.kind === 'file') return 'switch files';
  return 'close';
}
