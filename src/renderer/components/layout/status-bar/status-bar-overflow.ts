/** The bar's room and what its items need, in pixels: what `fitStatusBar` decides from. */
export interface StatusBarRoom {
  /** The bar's width inside its padding. */
  width: number;
  /** The space between the bar's left and right halves. */
  sideGap: number;
  /** The space between two items. */
  itemGap: number;
  /** The width of the button that opens the items that didn't fit, at the start of the right side. */
  moreWidth: number;
  /** Each item's width on the left, in order. An item that shows nothing is 0 wide. */
  left: readonly number[];
  /** Each item's width on the right, in order, left to right. */
  right: readonly number[];
}

/**
 * How many of each side's items show in the bar, counted from the bar's edge: the left side's
 * first items and the right side's last ones. The rest, toward the middle, go behind
 * the more button.
 */
export interface StatusBarFit {
  left: number;
  right: number;
}

/** Marks the menu of items that didn't fit, so a right-click in it counts as one on the bar. */
export const OVERFLOW_MENU_ATTRIBUTE = 'data-status-bar-overflow';

/** The share of the bar the left side keeps when both sides need more room than there is. */
export const LEFT_SIDE_SHARE = 0.4;

// Measured widths are fractional; a rounding error is no reason to move an item.
const SLACK = 0.5;

/** What the first `count` items take, with the more button after them when `more`. */
function widthOf(widths: readonly number[], count: number, itemGap: number, more: number | null) {
  const shown = widths.slice(0, count).filter((width) => width > 0);
  if (more !== null) shown.push(more);
  return shown.reduce((sum, width) => sum + width, 0) + itemGap * Math.max(0, shown.length - 1);
}

/**
 * How many items fit in `budget`, from the first, and the width they take. When not all of them
 * fit, or `more` must show anyway, the more button takes room too, if it's on this side: `more`
 * is its width, or null when it's on the other. The first item that shows something always
 * stays, cut short if it must: a bar showing only the more button would say nothing.
 */
function fitSide(
  widths: readonly number[],
  budget: number,
  itemGap: number,
  more: number | null,
  moreAnyway = false
) {
  const all = widthOf(widths, widths.length, itemGap, moreAnyway ? more : null);
  if (all <= budget + SLACK) return { count: widths.length, used: all };
  const keep = widths.findIndex((width) => width > 0) + 1;
  let count = Math.max(keep, widths.length - 1);
  while (count > keep && widthOf(widths, count, itemGap, more) > budget + SLACK) count--;
  return { count, used: Math.min(budget, widthOf(widths, count, itemGap, more)) };
}

/**
 * Which items fit the bar, as its two halves share the room: the right takes all the room the
 * left doesn't need, and when both need more than there is, the left keeps up to
 * `LEFT_SIDE_SHARE` of the bar. Each side keeps the items at the bar's edge and drops the ones
 * nearest the middle first. Both sides' dropped items go behind one more button, at the start of
 * the right side.
 */
export function fitStatusBar(room: StatusBarRoom): StatusBarFit {
  const { width, sideGap, itemGap, moreWidth } = room;
  const available = Math.max(0, width - sideGap);
  const leftNeed = widthOf(room.left, room.left.length, itemGap, null);
  const rightNeed = widthOf(room.right, room.right.length, itemGap, null);
  const leftFor = (rightWidth: number) => {
    const budget = Math.min(leftNeed, Math.max(width * LEFT_SIDE_SHARE, available - rightWidth));
    const fit = fitSide(room.left, budget, itemGap, null);
    return { ...fit, dropsAny: room.left.slice(fit.count).some((itemWidth) => itemWidth > 0) };
  };
  const rightFromEdge = [...room.right].reverse();
  let left = leftFor(rightNeed);
  // Dropping any item brings in the more button, on the right. The right drops its own items to
  // make room for it, and when even its first item and the button don't fit, the left gives way.
  if (left.dropsAny) {
    const rightLeast = widthOf(
      rightFromEdge,
      rightFromEdge.findIndex((itemWidth) => itemWidth > 0) + 1,
      itemGap,
      moreWidth
    );
    if (rightLeast > available - left.used + SLACK) left = leftFor(rightLeast);
  }
  const right = fitSide(rightFromEdge, available - left.used, itemGap, moreWidth, left.dropsAny);
  return { left: left.count, right: right.count };
}
