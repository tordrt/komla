/** What the sidebar shows: the changed files, all files, or a sidebar panel by its id. */
export type SidebarView = 'diff' | 'files' | `panel:${string}`;

/** The fewest tabs the row shows, and the sidebar's narrowest keeps room for. */
export const SIDEBAR_MIN_TABS = 2;

/** The most views a project keeps the order of. */
export const SIDEBAR_KEPT_VIEWS_MAX = 128;

export function panelView(panelId: string): SidebarView {
  return `panel:${panelId}`;
}

/** The panel's id, for a view that's a panel. */
export function viewPanelId(view: SidebarView): string | undefined {
  return view.startsWith('panel:') ? view.slice('panel:'.length) : undefined;
}

/**
 * The workspace's views in the order the user keeps for its project, the ones they never placed
 * after them in their own order: Diff and Files with git, then the panels.
 */
export function sidebarTabOrder(
  views: readonly SidebarView[],
  kept: readonly string[] | undefined
): SidebarView[] {
  const placed = (kept ?? []).filter((view): view is SidebarView =>
    views.includes(view as SidebarView)
  );
  return [...new Set(placed), ...views.filter((view) => !placed.includes(view))];
}

/**
 * The first `count` views in the order, and always the one showing, in place of the last, as when
 * a status item opens a panel that has no tab.
 */
export function sidebarTabRow(
  order: readonly SidebarView[],
  count: number,
  showing: SidebarView | null
): SidebarView[] {
  const row = order.slice(0, Math.max(1, count));
  if (showing && order.includes(showing) && !row.includes(showing)) {
    row[row.length - 1] = showing;
  }
  return row;
}

interface SidebarTabMeasures {
  widthOf: (view: SidebarView) => number;
  /** The caret of the menu with every view, which always shows after the tabs. */
  caret: number;
}

/** The room `row` takes, with the menu's caret after it. */
function sidebarTabRowWidth(row: readonly SidebarView[], { widthOf, caret }: SidebarTabMeasures) {
  return row.reduce((sum, view) => sum + widthOf(view), 0) + caret;
}

function measured(order: readonly SidebarView[], { widthOf, caret }: SidebarTabMeasures): boolean {
  return caret > 0 && order.every((view) => widthOf(view) > 0);
}

/**
 * How many views at the start of the order fit in `room` pixels as whole tabs, beside the menu's
 * caret, and never fewer than SIDEBAR_MIN_TABS: the menu marks where they end.
 */
export function fittingSidebarTabCount(
  order: readonly SidebarView[],
  measures: SidebarTabMeasures & { room: number }
): number {
  const fewest = Math.min(SIDEBAR_MIN_TABS, order.length);
  if (measures.room <= 0 || !measured(order, measures)) return fewest;
  let count = order.length;
  while (count > fewest && sidebarTabRowWidth(order.slice(0, count), measures) > measures.room) {
    count--;
  }
  return count;
}

/**
 * The row that fits in `room` pixels beside the menu's caret: as many whole tabs as fit, and never
 * fewer than SIDEBAR_MIN_TABS, the last of them the one showing when it has no tab, which shortens
 * its title when it's too wide for that place.
 */
export function fittingSidebarTabRow(
  order: readonly SidebarView[],
  showing: SidebarView | null,
  measures: SidebarTabMeasures & { room: number }
): SidebarView[] {
  const fewest = Math.min(SIDEBAR_MIN_TABS, order.length);
  if (measures.room > 0 && measured(order, measures)) {
    for (let count = order.length; count > fewest; count--) {
      const row = sidebarTabRow(order, count, showing);
      if (sidebarTabRowWidth(row, measures) <= measures.room) return row;
    }
  }
  return sidebarTabRow(order, fewest, showing);
}

/**
 * The width the row needs at its narrowest: the first tab in the order, whole, the widest of the
 * rest, as any of them may show beside it, and the caret. It doesn't depend on the one showing,
 * so the sidebar doesn't resize as views show; only moving the first tab changes it. 0 until
 * every view is measured.
 */
export function narrowestSidebarTabRowWidth(
  order: readonly SidebarView[],
  measures: SidebarTabMeasures
): number {
  if (!measured(order, measures)) return 0;
  const [first, ...rest] = order;
  if (!first) return measures.caret;
  const widest = Math.max(0, ...rest.map(measures.widthOf));
  return measures.widthOf(first) + widest + measures.caret;
}

/**
 * The order to keep once the row becomes `row`: its views first, as shown, then the rest in the
 * order they had, then what the project keeps for views this workspace lacks, such as another
 * branch's panel.
 */
export function keptSidebarTabOrder(
  row: readonly SidebarView[],
  order: readonly SidebarView[],
  kept: readonly string[] | undefined
): SidebarView[] {
  const next = [...row, ...order.filter((view) => !row.includes(view))];
  const elsewhere = (kept ?? []).filter((view) => !next.includes(view as SidebarView));
  return [...next, ...(elsewhere as SidebarView[])].slice(0, SIDEBAR_KEPT_VIEWS_MAX);
}

/**
 * The order after the user puts `view` in place of the row's `tab`: the view takes the tab's place
 * in the row as it shows, and the tab the view's place among the rest, so a narrower view doesn't
 * bring it back into the row.
 */
export function replaceSidebarTab(
  row: readonly SidebarView[],
  order: readonly SidebarView[],
  tab: SidebarView,
  view: SidebarView
): SidebarView[] {
  const next = row.map((each) => (each === tab ? view : each));
  const rest = order
    .filter((each) => each !== tab)
    .map((each) => (each === view ? tab : each))
    .filter((each) => !next.includes(each));
  return [...next, ...rest];
}

/** The row after the user drags the tab at `from` to before the one at `to`, or to the end. */
export function moveSidebarTab(
  row: readonly SidebarView[],
  from: number,
  to: number
): SidebarView[] {
  const next = [...row];
  const [moved] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, moved);
  return next;
}
