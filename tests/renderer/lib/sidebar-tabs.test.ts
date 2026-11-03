import { describe, expect, it } from 'vitest';

import {
  fittingSidebarTabRow,
  fittingSidebarTabs,
  keptSidebarTabOrder,
  moveSidebarTab,
  narrowestSidebarTabRowWidth,
  pickSidebarTab,
  sidebarTabOrder,
  sidebarTabRow,
  type SidebarView,
} from '../../../src/renderer/lib/sidebar-tabs';

const git: SidebarView[] = ['diff', 'files', 'panel:ci', 'panel:usage'];

describe('sidebarTabOrder', () => {
  it("puts the views the user placed first, then the rest in the workspace's order", () => {
    expect(sidebarTabOrder(git, undefined)).toEqual(git);
    expect(sidebarTabOrder(git, ['panel:ci', 'diff'])).toEqual([
      'panel:ci',
      'diff',
      'files',
      'panel:usage',
    ]);
  });

  it("skips the placed views this workspace doesn't have", () => {
    expect(sidebarTabOrder(['files', 'panel:ci'], ['panel:deploys', 'diff', 'panel:ci'])).toEqual([
      'panel:ci',
      'files',
    ]);
  });
});

describe('sidebarTabRow', () => {
  it('shows the first views in the order', () => {
    expect(sidebarTabRow(git, 2, 'diff')).toEqual(['diff', 'files']);
    expect(sidebarTabRow(git, 3, 'diff')).toEqual(['diff', 'files', 'panel:ci']);
  });

  it('always shows the view that shows, in place of the last tab', () => {
    expect(sidebarTabRow(git, 2, 'panel:usage')).toEqual(['diff', 'panel:usage']);
    expect(sidebarTabRow(git, 2, 'files')).toEqual(['diff', 'files']);
  });
});

describe('fittingSidebarTabRow', () => {
  const widths: Record<string, number> = {
    diff: 40,
    files: 40,
    'panel:ci': 60,
    'panel:usage': 80,
  };
  const widthOf = (view: SidebarView) => widths[view];

  it('shows as many tabs as fit beside the caret, and every one when all fit', () => {
    expect(fittingSidebarTabRow(git, 'diff', { widthOf, caret: 24, room: 164 })).toEqual([
      'diff',
      'files',
      'panel:ci',
    ]);
    expect(fittingSidebarTabRow(git, 'diff', { widthOf, caret: 24, room: 163 })).toEqual([
      'diff',
      'files',
    ]);
    // Without the caret, as no view is left out.
    expect(fittingSidebarTabRow(git, 'diff', { widthOf, caret: 24, room: 220 })).toEqual(git);
  });

  it('counts the view that shows in place of the last tab', () => {
    // Usage is wider than CI, which it takes the place of.
    expect(fittingSidebarTabRow(git, 'panel:usage', { widthOf, caret: 24, room: 164 })).toEqual([
      'diff',
      'panel:usage',
    ]);
  });

  it('shows only whole tabs, at least the one showing, and two until measured', () => {
    // Usage and the caret fit, but not Diff beside them.
    expect(fittingSidebarTabRow(git, 'panel:usage', { widthOf, caret: 24, room: 110 })).toEqual([
      'panel:usage',
    ]);
    expect(fittingSidebarTabRow(git, 'diff', { widthOf, caret: 24, room: 10 })).toEqual(['diff']);
    // The caret for adding a panel needs room beside every tab.
    const tree: SidebarView[] = ['diff', 'files'];
    const withCaret = { widthOf, caret: 24, alwaysCaret: true };
    expect(fittingSidebarTabRow(tree, 'diff', { ...withCaret, room: 103 })).toEqual(['diff']);
    expect(fittingSidebarTabRow(tree, 'diff', { ...withCaret, room: 104 })).toEqual(tree);
    expect(fittingSidebarTabRow(git, 'diff', { widthOf: () => 0, caret: 0, room: 500 })).toEqual([
      'diff',
      'files',
    ]);
    expect(fittingSidebarTabRow(['files'], 'files', { widthOf, caret: 24, room: 10 })).toEqual([
      'files',
    ]);
  });

  it('measures the narrowest row as the two widest tabs and the caret', () => {
    expect(narrowestSidebarTabRowWidth(git, { widthOf, caret: 24 })).toBe(164);
    expect(narrowestSidebarTabRowWidth(['diff', 'files'], { widthOf, caret: 24 })).toBe(80);
    // Whichever views come first.
    const panelsFirst: SidebarView[] = ['panel:usage', 'panel:ci', 'files', 'diff'];
    expect(narrowestSidebarTabRowWidth(panelsFirst, { widthOf, caret: 24 })).toBe(164);
    // Every tab, when they take less room than two and the caret.
    const short = (view: SidebarView) => (view === 'panel:ci' ? 10 : widthOf(view));
    const three: SidebarView[] = ['diff', 'files', 'panel:ci'];
    expect(narrowestSidebarTabRowWidth(three, { widthOf: short, caret: 24 })).toBe(90);
    // With the caret for adding a panel, which shows with every tab.
    const tree: SidebarView[] = ['diff', 'files'];
    expect(narrowestSidebarTabRowWidth(tree, { widthOf, caret: 24, alwaysCaret: true })).toBe(104);
    expect(narrowestSidebarTabRowWidth(git, { widthOf: () => 0, caret: 24 })).toBe(0);
    expect(narrowestSidebarTabRowWidth(git, { widthOf, caret: 0 })).toBe(0);
  });
});

describe('fittingSidebarTabs', () => {
  // Diff, Files and CI's title take 40 pixels each, and CI's badge 40 more.
  const titleWidthOf = () => 40;
  const widthOf = (view: SidebarView) => (view === 'panel:ci' ? 80 : 40);
  const three: SidebarView[] = ['diff', 'files', 'panel:ci'];
  const measures = { widthOf, titleWidthOf, caret: 24 };

  it('shows badges as dots rather than leave out a tab the narrowest row has', () => {
    expect(fittingSidebarTabs(three, 'panel:ci', { ...measures, room: 120 })).toEqual({
      row: three,
      dotBadges: true,
    });
    expect(fittingSidebarTabs(three, 'panel:ci', { ...measures, room: 160 })).toEqual({
      row: three,
      dotBadges: false,
    });
  });

  it('shows badges in full with as many tabs as the narrowest row has, though dots fit more', () => {
    const four: SidebarView[] = [...three, 'panel:usage'];
    // Titles alone fit three and the caret; with CI's badge, two do.
    expect(fittingSidebarTabs(four, 'panel:ci', { ...measures, room: 150 })).toEqual({
      row: ['diff', 'panel:ci'],
      dotBadges: false,
    });
  });
});

describe('keptSidebarTabOrder', () => {
  it('keeps the row first, the rest in their order, then the views kept for other workspaces', () => {
    expect(
      keptSidebarTabOrder(['panel:ci', 'diff'], git, ['diff', 'files', 'panel:deploys'])
    ).toEqual(['panel:ci', 'diff', 'files', 'panel:usage', 'panel:deploys']);
  });
});

describe('pickSidebarTab', () => {
  it("puts the picked view in place of the last tab that isn't showing", () => {
    expect(pickSidebarTab(['diff', 'files'], 'panel:ci', 'diff')).toEqual(['diff', 'panel:ci']);
    expect(pickSidebarTab(['diff', 'files'], 'panel:ci', 'files')).toEqual(['panel:ci', 'files']);
    expect(pickSidebarTab(['diff', 'files', 'panel:ci'], 'panel:usage', 'panel:ci')).toEqual([
      'diff',
      'panel:usage',
      'panel:ci',
    ]);
  });

  it('leaves the row as it is for a view already in it', () => {
    expect(pickSidebarTab(['diff', 'panel:ci'], 'panel:ci', 'diff')).toEqual(['diff', 'panel:ci']);
  });
});

describe('moveSidebarTab', () => {
  it('moves a tab to before another, or to the end', () => {
    expect(moveSidebarTab(['diff', 'files', 'panel:ci'], 2, 0)).toEqual([
      'panel:ci',
      'diff',
      'files',
    ]);
    expect(moveSidebarTab(['diff', 'files', 'panel:ci'], 0, 2)).toEqual([
      'files',
      'diff',
      'panel:ci',
    ]);
    expect(moveSidebarTab(['diff', 'files', 'panel:ci'], 0, 3)).toEqual([
      'files',
      'panel:ci',
      'diff',
    ]);
  });
});
