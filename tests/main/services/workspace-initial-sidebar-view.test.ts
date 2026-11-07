import { describe, expect, it } from 'vitest';

import { initialSidebarView } from '../../../src/main/services/workspace/initial-sidebar-view';

const base = { projectId: 'proj-1', isGitWorkspace: true, defaultMode: 'diff' as const };

describe('initialSidebarView', () => {
  it('opens on Default mode where the project keeps no tab order', () => {
    expect(initialSidebarView({ ...base, defaultMode: 'browse' })).toEqual({
      fileTreeMode: 'browse',
    });
    expect(
      initialSidebarView({ ...base, projectSidebarTabs: { other: ['panel:checks'] } })
    ).toEqual({ fileTreeMode: 'diff' });
    expect(initialSidebarView({ ...base, projectId: null })).toEqual({ fileTreeMode: 'diff' });
  });

  it("opens on a panel that's first in the project's order, its tree on the first of Diff and Files", () => {
    expect(
      initialSidebarView({
        ...base,
        projectSidebarTabs: { 'proj-1': ['panel:checks', 'files', 'diff'] },
      })
    ).toEqual({ fileTreeMode: 'browse', sidebarPanelId: 'checks' });
    // With neither placed, the tree keeps Default mode.
    expect(
      initialSidebarView({ ...base, projectSidebarTabs: { 'proj-1': ['panel:checks'] } })
    ).toEqual({ fileTreeMode: 'diff', sidebarPanelId: 'checks' });
  });

  it('opens on Files where it comes first, even with Default mode on Diff', () => {
    expect(
      initialSidebarView({ ...base, projectSidebarTabs: { 'proj-1': ['files', 'panel:checks'] } })
    ).toEqual({ fileTreeMode: 'browse' });
  });

  it('passes over a panel hidden in the project, and Diff without git', () => {
    expect(
      initialSidebarView({
        ...base,
        projectSidebarTabs: { 'proj-1': ['panel:checks', 'panel:deploys', 'diff'] },
        projectHiddenItems: { 'proj-1': ['panel:checks'] },
      })
    ).toEqual({ fileTreeMode: 'diff', sidebarPanelId: 'deploys' });
    expect(
      initialSidebarView({
        ...base,
        isGitWorkspace: false,
        projectSidebarTabs: { 'proj-1': ['diff', 'panel:checks'] },
      })
      // Without git the tree shows Files whatever its mode, as for any such workspace.
    ).toEqual({ fileTreeMode: 'diff', sidebarPanelId: 'checks' });
  });

  it('ignores entries that are no view, and an empty panel id', () => {
    expect(
      initialSidebarView({
        ...base,
        defaultMode: 'browse',
        projectSidebarTabs: { 'proj-1': ['terminal', 'panel:', 'diff'] },
      })
    ).toEqual({ fileTreeMode: 'diff' });
  });
});
