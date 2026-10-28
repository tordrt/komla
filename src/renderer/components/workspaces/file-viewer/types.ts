import type { FileChange } from '@/types';

/** View mode for diff display */
export type ViewMode = 'split' | 'unified';

/** File viewer mode */
export type FileViewerMode = 'browse' | 'diff';

/** Status color for git status badges */
export type StatusColor = 'green' | 'red' | 'amber' | 'purple' | 'muted';

/** Changed files shown in tree order */
export interface GroupedFiles {
  files: FileChange[];
}

/** Item used to build file tree */
export interface FileTreeItem {
  path: string;
  gitIgnored?: boolean;
  /** Hint that this item is a directory (e.g. untracked dir from git status -unormal) */
  isDirectory?: boolean;
}

/** File search result with match highlighting */
export interface FileSearchResult {
  path: string;
  gitIgnored?: boolean;
  fileNameMatches?: ReadonlyArray<readonly [number, number]>;
  pathMatches?: ReadonlyArray<readonly [number, number]>;
}

export const FILE_VIEW_TAB_ACTIVE_CLASS = 'bg-[var(--file-viewer-surface)]';

/** Badge color classes for status display */
export const badgeColors: Record<StatusColor, string> = {
  green: 'bg-success/15 text-success',
  red: 'bg-error/15 text-error',
  amber: 'bg-warning/15 text-warning',
  purple:
    'bg-[color-mix(in_oklch,var(--git-renamed)_15%,transparent)] text-[color:var(--git-renamed)]',
  muted: 'bg-muted text-muted-foreground',
};

/** Text color classes for git status */
export const statusTextColors: Record<StatusColor, string> = {
  green: 'text-success',
  red: 'text-error',
  amber: 'text-warning',
  purple: 'text-[color:var(--git-renamed)]',
  muted: 'text-muted-foreground',
};
