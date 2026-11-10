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
        | {
            kind: 'commit';
            commitHash: string;
            filePath?: string;
            /** A commit HEAD lacks, so the history never lists it and isn't searched for it. */
            outsideHistory?: boolean;
          };
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

/**
 * What the file panel's preview is asked to do that would drop its unsaved edits. While they're
 * unsaved one waits for the Unsaved Changes prompt; a later request takes its place.
 */
export type InlinePreviewTransition =
  | {
      kind: 'file';
      mode: FileViewerMode;
      filePath: string;
      lineNumber?: number;
      /** Shows an HTML file as a page, which also switches the tree to its files. */
      htmlPreviewIntent?: boolean;
      /** Switches the tree to its files, as a link does. */
      browseTree?: boolean;
    }
  | { kind: 'mode'; mode: FileViewerMode }
  | { kind: 'close' };

/** The file panel's preview as a transition sees it. */
export interface InlinePreviewTransitionContext {
  open: boolean;
  dirty: boolean;
  filePath: string | null;
  mode: FileViewerMode;
}

/** `ignore`: there's nothing to do, as closing a preview that isn't open. */
export type InlinePreviewTransitionDecision = 'apply' | 'confirm' | 'ignore';

export function decideInlinePreviewTransition(
  transition: InlinePreviewTransition,
  preview: InlinePreviewTransitionContext
): InlinePreviewTransitionDecision {
  if (!preview.open) return transition.kind === 'close' ? 'ignore' : 'apply';
  if (!preview.dirty) return 'apply';
  switch (transition.kind) {
    case 'file':
      // Another mode loads the same file in another editor, which drops the edits too.
      return transition.filePath === preview.filePath && transition.mode === preview.mode
        ? 'apply'
        : 'confirm';
    case 'mode':
      return transition.mode === preview.mode ? 'apply' : 'confirm';
    case 'close':
      return 'confirm';
  }
}

export function describeInlinePreviewTransition(transition: InlinePreviewTransition): string {
  if (transition.kind === 'file') return 'switch files';
  if (transition.kind === 'mode') return 'switch view mode';
  return 'close';
}
