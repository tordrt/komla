import { STATUS_ITEM_ID_PATTERN } from '../../../shared/types/status-items';

import type { Workspace } from '../../../shared/types/workspace';

type FileTreeMode = NonNullable<Workspace['fileTreeMode']>;

const PANEL_VIEW_PREFIX = 'panel:';

/**
 * What a new workspace's sidebar opens on: the first tab in the order the user keeps for its
 * project, passing over a panel hidden there and Diff without git, or Default mode where the
 * project keeps no order. A panel that's first shows over the tree, which takes the first of Diff
 * and Files in that order. One gone since, as a plugin turned off, leaves the tree showing.
 */
export function initialSidebarView({
  projectId,
  isGitWorkspace,
  defaultMode,
  projectSidebarTabs,
  projectHiddenItems,
}: {
  projectId: string | null;
  isGitWorkspace: boolean;
  defaultMode: FileTreeMode;
  projectSidebarTabs?: Record<string, string[]>;
  projectHiddenItems?: Record<string, string[]>;
}): { fileTreeMode: FileTreeMode; sidebarPanelId?: string } {
  const kept = (projectId && projectSidebarTabs?.[projectId]) || [];
  const hidden = (projectId && projectHiddenItems?.[projectId]) || [];
  const views = kept.filter((view) =>
    view === 'diff'
      ? isGitWorkspace
      : view === 'files' ||
        (view.startsWith(PANEL_VIEW_PREFIX) &&
          STATUS_ITEM_ID_PATTERN.test(view.slice(PANEL_VIEW_PREFIX.length)) &&
          !hidden.includes(view))
  );
  const tree = views.find((view) => view === 'diff' || view === 'files');
  const fileTreeMode: FileTreeMode = tree ? (tree === 'diff' ? 'diff' : 'browse') : defaultMode;
  const first = views[0];
  return first?.startsWith(PANEL_VIEW_PREFIX)
    ? { fileTreeMode, sidebarPanelId: first.slice(PANEL_VIEW_PREFIX.length) }
    : { fileTreeMode };
}
