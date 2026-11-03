import { describe, expect, it } from 'vitest';

import {
  pickSidebarTab,
  sidebarTabRow,
  type SidebarView,
} from '../../../src/renderer/lib/sidebar-tabs';

const git: SidebarView[] = ['diff', 'files', 'panel:ci', 'panel:usage'];

describe('sidebarTabRow', () => {
  it('shows Diff and Files until the user keeps others', () => {
    expect(sidebarTabRow(git, undefined, 'diff')).toEqual(['diff', 'files']);
    expect(sidebarTabRow(git, ['diff', 'panel:ci'], 'diff')).toEqual(['diff', 'panel:ci']);
  });

  it("fills from the workspace's views what it lacks of those kept", () => {
    // No git, so no Diff: Files and the first panel.
    expect(sidebarTabRow(['files', 'panel:ci'], undefined, 'files')).toEqual(['files', 'panel:ci']);
    // A panel kept elsewhere that this workspace doesn't have.
    expect(sidebarTabRow(git, ['panel:deploys', 'panel:usage'], 'diff')).toEqual([
      'diff',
      'panel:usage',
    ]);
    expect(sidebarTabRow(['files'], ['diff', 'panel:ci'], 'files')).toEqual(['files']);
  });

  it('always shows the view that shows, in place of the last tab', () => {
    expect(sidebarTabRow(git, ['diff', 'files'], 'panel:usage')).toEqual(['diff', 'panel:usage']);
    expect(sidebarTabRow(git, ['diff', 'files'], 'files')).toEqual(['diff', 'files']);
  });
});

describe('pickSidebarTab', () => {
  it("puts the picked view in place of the tab that isn't showing", () => {
    expect(pickSidebarTab(['diff', 'files'], 'panel:ci', 'diff')).toEqual(['diff', 'panel:ci']);
    expect(pickSidebarTab(['diff', 'files'], 'panel:ci', 'files')).toEqual(['panel:ci', 'files']);
  });

  it('leaves the row as it is for a view already in it, and fills a short one', () => {
    expect(pickSidebarTab(['diff', 'panel:ci'], 'panel:ci', 'diff')).toEqual(['diff', 'panel:ci']);
    expect(pickSidebarTab(['files'], 'panel:ci', 'files')).toEqual(['files', 'panel:ci']);
  });
});
