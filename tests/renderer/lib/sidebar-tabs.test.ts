import { describe, expect, it } from 'vitest';

import {
  fittingSidebarTabCount,
  fittingSidebarTabRow,
  keptSidebarTabOrder,
  moveSidebarTab,
  narrowestSidebarTabRowWidth,
  replaceSidebarTab,
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
    // The caret shows beside every tab too.
    expect(fittingSidebarTabRow(git, 'diff', { widthOf, caret: 24, room: 244 })).toEqual(git);
    expect(fittingSidebarTabRow(git, 'diff', { widthOf, caret: 24, room: 243 })).toHaveLength(3);
  });

  it('counts the view that shows in place of the last tab', () => {
    // Usage is wider than CI, which it takes the place of.
    expect(fittingSidebarTabRow(git, 'panel:usage', { widthOf, caret: 24, room: 164 })).toEqual([
      'diff',
      'panel:usage',
    ]);
  });

  it('shows at least the first two tabs, the last of them the one showing, and two until measured', () => {
    // Usage doesn't fit beside Diff whole, so it shortens its title.
    expect(fittingSidebarTabRow(git, 'panel:usage', { widthOf, caret: 24, room: 110 })).toEqual([
      'diff',
      'panel:usage',
    ]);
    expect(fittingSidebarTabRow(git, 'diff', { widthOf, caret: 24, room: 10 })).toEqual([
      'diff',
      'files',
    ]);
    const tree: SidebarView[] = ['diff', 'files'];
    expect(fittingSidebarTabRow(tree, 'diff', { widthOf, caret: 24, room: 103 })).toEqual(tree);
    expect(fittingSidebarTabRow(git, 'diff', { widthOf: () => 0, caret: 0, room: 500 })).toEqual([
      'diff',
      'files',
    ]);
    expect(fittingSidebarTabRow(['files'], 'files', { widthOf, caret: 24, room: 10 })).toEqual([
      'files',
    ]);
  });

  it('measures the narrowest row as the first tab, the widest of the rest and the caret', () => {
    // Diff (40), Usage (80) and the caret, whichever of the rest shows beside Diff.
    expect(narrowestSidebarTabRowWidth(git, { widthOf, caret: 24 })).toBe(144);
    expect(narrowestSidebarTabRowWidth(['diff', 'files'], { widthOf, caret: 24 })).toBe(104);
    // Usage (80) first, then CI (60), the widest of the rest.
    const panelsFirst: SidebarView[] = ['panel:usage', 'panel:ci', 'files', 'diff'];
    expect(narrowestSidebarTabRowWidth(panelsFirst, { widthOf, caret: 24 })).toBe(164);
    expect(narrowestSidebarTabRowWidth(['files'], { widthOf, caret: 24 })).toBe(64);
    expect(narrowestSidebarTabRowWidth(git, { widthOf: () => 0, caret: 24 })).toBe(0);
    expect(narrowestSidebarTabRowWidth(git, { widthOf, caret: 0 })).toBe(0);
  });
});

describe('fittingSidebarTabCount', () => {
  const widthOf = (view: SidebarView) => (view === 'panel:usage' ? 80 : 40);

  it('counts the views at the start of the order that fit beside the caret, at least two', () => {
    expect(fittingSidebarTabCount(git, { widthOf, caret: 24, room: 224 })).toBe(4);
    expect(fittingSidebarTabCount(git, { widthOf, caret: 24, room: 223 })).toBe(3);
    expect(fittingSidebarTabCount(git, { widthOf, caret: 24, room: 10 })).toBe(2);
    expect(fittingSidebarTabCount(git, { widthOf: () => 0, caret: 24, room: 500 })).toBe(2);
    expect(fittingSidebarTabCount(['files'], { widthOf, caret: 24, room: 10 })).toBe(1);
  });
});

describe('keptSidebarTabOrder', () => {
  it('keeps the row first, the rest in their order, then the views kept for other workspaces', () => {
    expect(
      keptSidebarTabOrder(['panel:ci', 'diff'], git, ['diff', 'files', 'panel:deploys'])
    ).toEqual(['panel:ci', 'diff', 'files', 'panel:usage', 'panel:deploys']);
  });
});

describe('replaceSidebarTab', () => {
  it("puts the view in the tab's place in the row, and the tab in the view's among the rest", () => {
    expect(replaceSidebarTab(['diff', 'files'], git, 'files', 'panel:usage')).toEqual([
      'diff',
      'panel:usage',
      'panel:ci',
      'files',
    ]);
    // Usage showed in the last tab's place, ahead of where the order has it.
    expect(replaceSidebarTab(['diff', 'panel:usage'], git, 'panel:usage', 'panel:ci')).toEqual([
      'diff',
      'panel:ci',
      'files',
      'panel:usage',
    ]);
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
