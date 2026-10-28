export type MarkdownViewMode = 'rich' | 'source';

/** Past this size, the rich editor's parsing and saving makes typing lag. */
export const RICH_MARKDOWN_MAX_LENGTH = 300_000;

const STORAGE_KEY = 'komla.markdownViewMode';
const listeners = new Set<() => void>();
let viewMode: MarkdownViewMode = readStoredViewMode();

function readStoredViewMode(): MarkdownViewMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'source' ? 'source' : 'rich';
  } catch {
    return 'rich';
  }
}

export function isMarkdownFile(filePath: string): boolean {
  return /\.(?:md|markdown|mdown|mkd)$/i.test(filePath);
}

export function getMarkdownViewMode(): MarkdownViewMode {
  return viewMode;
}

/** Remembered across files and restarts. */
export function setMarkdownViewMode(mode: MarkdownViewMode): void {
  if (viewMode === mode) return;
  viewMode = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // The choice still holds until Komla quits.
  }
  for (const listener of listeners) listener();
}

export function subscribeMarkdownViewMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
