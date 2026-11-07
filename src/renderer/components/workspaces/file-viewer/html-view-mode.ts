export type HtmlViewMode = 'browser' | 'source';
// Diff-mode browser preview toggle is kept separate from browse-mode's source/browser
// toggle: in diff context "Source" wouldn't make sense (we render a diff
// editor, not a source buffer), and the default differs — a changed file starts on
// the diff view, while a new file, whose diff is all additions, starts on the preview.
export type HtmlDiffViewMode = 'diff' | 'browser';

const htmlViewModeByWorkspace = new Map<string, HtmlViewMode>();
const htmlDiffViewModeByWorkspace = new Map<string, HtmlDiffViewMode>();
const htmlNewFileDiffViewModeByWorkspace = new Map<string, HtmlDiffViewMode>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getHtmlViewMode(workingDirectory: string): HtmlViewMode {
  return htmlViewModeByWorkspace.get(workingDirectory) ?? 'browser';
}

export function setHtmlViewMode(workingDirectory: string, mode: HtmlViewMode): void {
  if (getHtmlViewMode(workingDirectory) === mode) return;
  htmlViewModeByWorkspace.set(workingDirectory, mode);
  notify();
}

/** The view a diff opens on: new files and changed ones each keep their own choice. */
export function getHtmlDiffViewMode(workingDirectory: string, newFile = false): HtmlDiffViewMode {
  return newFile
    ? (htmlNewFileDiffViewModeByWorkspace.get(workingDirectory) ?? 'browser')
    : (htmlDiffViewModeByWorkspace.get(workingDirectory) ?? 'diff');
}

export function setHtmlDiffViewMode(
  workingDirectory: string,
  mode: HtmlDiffViewMode,
  newFile = false
): void {
  if (getHtmlDiffViewMode(workingDirectory, newFile) === mode) return;
  (newFile ? htmlNewFileDiffViewModeByWorkspace : htmlDiffViewModeByWorkspace).set(
    workingDirectory,
    mode
  );
  notify();
}

export function subscribeHtmlViewMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
