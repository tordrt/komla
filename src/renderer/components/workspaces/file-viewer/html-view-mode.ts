export type HtmlViewMode = 'browser' | 'source';
// Diff-mode browser preview toggle is kept separate from browse-mode's source/browser
// toggle: in diff context "Source" wouldn't make sense (we render a diff
// editor, not a source buffer), and the default differs — diff workflows
// start on the diff view, not the rendered preview.
export type HtmlDiffViewMode = 'diff' | 'browser';

const htmlViewModeByWorkspace = new Map<string, HtmlViewMode>();
const htmlDiffViewModeByWorkspace = new Map<string, HtmlDiffViewMode>();
const listeners = new Set<() => void>();

export function getHtmlViewMode(workingDirectory: string): HtmlViewMode {
  return htmlViewModeByWorkspace.get(workingDirectory) ?? 'browser';
}

export function setHtmlViewMode(workingDirectory: string, mode: HtmlViewMode): void {
  if (getHtmlViewMode(workingDirectory) === mode) return;
  htmlViewModeByWorkspace.set(workingDirectory, mode);
  for (const listener of listeners) listener();
}

export function getHtmlDiffViewMode(workingDirectory: string): HtmlDiffViewMode {
  return htmlDiffViewModeByWorkspace.get(workingDirectory) ?? 'diff';
}

export function setHtmlDiffViewMode(workingDirectory: string, mode: HtmlDiffViewMode): void {
  if (getHtmlDiffViewMode(workingDirectory) === mode) return;
  htmlDiffViewModeByWorkspace.set(workingDirectory, mode);
  for (const listener of listeners) listener();
}

export function subscribeHtmlViewMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
