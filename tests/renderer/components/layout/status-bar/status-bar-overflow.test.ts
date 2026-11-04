import { describe, expect, it } from 'vitest';

import { fitStatusBar } from '../../../../../src/renderer/components/layout/status-bar/status-bar-overflow';

const room = { sideGap: 8, itemGap: 4, moreWidth: 20 };

describe('fitStatusBar', () => {
  it('shows every item when they all fit', () => {
    expect(fitStatusBar({ ...room, width: 500, left: [100, 100], right: [100, 100] })).toEqual({
      left: 2,
      right: 2,
    });
  });

  it('shows every item when they fit exactly', () => {
    // 100 + 4 + 100, the gap between the sides, then 100 + 4 + 100.
    expect(fitStatusBar({ ...room, width: 416, left: [100, 100], right: [100, 100] })).toEqual({
      left: 2,
      right: 2,
    });
  });

  it('drops items from the right side, leaving room for its more button', () => {
    // The left takes 100; the right has 392 for 100 + 100 + 100 + 100, then 100 + 100 + 100 + more.
    expect(fitStatusBar({ ...room, width: 500, left: [100], right: [100, 100, 100, 100] })).toEqual(
      { left: 1, right: 3 }
    );
    // 322 left over: 100 + 100 + more fits, a third 100 with more doesn't.
    expect(fitStatusBar({ ...room, width: 430, left: [100], right: [100, 100, 100, 100] })).toEqual(
      { left: 1, right: 2 }
    );
  });

  it('gives the left side the room the right side does not need', () => {
    expect(fitStatusBar({ ...room, width: 500, left: [100, 100, 100, 100], right: [50] })).toEqual({
      left: 4,
      right: 1,
    });
  });

  it('keeps up to 40% of the bar for the left side when both sides need more', () => {
    // The left may take 400 of 1000: 3 × 100 fits, 4 × 100 doesn't. The right gets the 684
    // that leaves, with the more button for both sides: 6 × 100 + more.
    expect(
      fitStatusBar({
        ...room,
        width: 1000,
        left: [100, 100, 100, 100, 100],
        right: Array(8).fill(100),
      })
    ).toEqual({ left: 3, right: 6 });
  });

  it('makes room on the right for the more button when only the left drops items', () => {
    // The left gets 534, for 5 × 100; the right's 150 × 3 fit the 476 left, but not with the button.
    expect(
      fitStatusBar({ ...room, width: 1000, left: Array(6).fill(100), right: [150, 150, 150] })
    ).toEqual({ left: 5, right: 2 });
  });

  it("takes the more button's room from the left when the right can't drop enough", () => {
    // 444 × 2 would fit beside the right's 100, but not with the button the left's third adds.
    expect(fitStatusBar({ ...room, width: 1000, left: [444, 444, 444], right: [100] })).toEqual({
      left: 1,
      right: 1,
    });
    // When the right can drop items for the button, the left keeps its room: a 170 first item on
    // the left stays whole, and the right shows its last item and the button.
    expect(
      fitStatusBar({
        width: 248,
        sideGap: 8,
        itemGap: 4,
        moreWidth: 26,
        left: [170, 65, 26, 26, 26],
        right: [26, 26],
      })
    ).toEqual({ left: 1, right: 1 });
    // With nothing on the right, the button still takes room from the left.
    expect(fitStatusBar({ ...room, width: 1000, left: [494, 494, 494], right: [] })).toEqual({
      left: 1,
      right: 0,
    });
  });

  it('keeps all of a left side shorter than 40% while the right side drops items', () => {
    expect(
      fitStatusBar({ ...room, width: 1000, left: [100, 100], right: Array(10).fill(100) })
    ).toEqual({ left: 2, right: 7 });
  });

  it('keeps the first item that shows something, however little room there is', () => {
    expect(fitStatusBar({ ...room, width: 100, left: [0, 300, 100], right: [200, 100] })).toEqual({
      left: 2,
      right: 1,
    });
  });

  it("keeps a side's only item that shows something when it is nearest the middle", () => {
    expect(fitStatusBar({ ...room, width: 100, left: [0, 200], right: [] })).toEqual({
      left: 2,
      right: 0,
    });
    expect(fitStatusBar({ ...room, width: 100, left: [], right: [200, 0] })).toEqual({
      left: 0,
      right: 2,
    });
  });

  it('drops items from the start of the right side, nearest the middle', () => {
    // 322 for the right: its last two, 100 + 100 + more, fit; the 50 at its start goes first.
    expect(fitStatusBar({ ...room, width: 430, left: [100], right: [50, 100, 100, 100] })).toEqual({
      left: 1,
      right: 2,
    });
    // Narrow items at its end fit where wide ones at its start wouldn't.
    expect(fitStatusBar({ ...room, width: 300, left: [], right: [200, 50, 50] })).toEqual({
      left: 0,
      right: 2,
    });
  });

  it('takes no room or gap for items that show nothing', () => {
    // 100 + 4 + 100, with nothing between them for the empty item.
    expect(fitStatusBar({ ...room, width: 212, left: [100, 0, 100], right: [] })).toEqual({
      left: 3,
      right: 0,
    });
  });

  it('ignores rounding errors in measured widths', () => {
    expect(fitStatusBar({ ...room, width: 416, left: [100.2, 100.2], right: [100, 100] })).toEqual({
      left: 2,
      right: 2,
    });
  });
});
