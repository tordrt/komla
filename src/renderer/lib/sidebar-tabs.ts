/** What the sidebar shows: the changed files, all files, or a sidebar panel by its id. */
export type SidebarView = 'diff' | 'files' | `panel:${string}`;

/** The tabs the row shows until it's measured, and the sidebar's narrowest keeps room for. */
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
  caret: number;
  /** Whether the menu's caret shows beside every tab, as to add a panel when there's none. */
  alwaysCaret?: boolean;
}

/**
 * The row that fits in `room` pixels, with the menu's caret when some views are left out: as many
 * whole tabs as fit, and at least the one showing, so a badge never shortens a title. Unmeasured,
 * before layout or in tests, it shows SIDEBAR_MIN_TABS.
 */
export function fittingSidebarTabRow(
  order: readonly SidebarView[],
  showing: SidebarView | null,
  { widthOf, caret, alwaysCaret = false, room }: SidebarTabMeasures & { room: number }
): SidebarView[] {
  if (room <= 0 || order.some((view) => widthOf(view) <= 0)) {
    return sidebarTabRow(order, Math.min(SIDEBAR_MIN_TABS, order.length), showing);
  }
  for (let count = order.length; count > 1; count--) {
    const row = sidebarTabRow(order, count, showing);
    const width = row.reduce((sum, view) => sum + widthOf(view), 0);
    if (width + (alwaysCaret || count < order.length ? caret : 0) <= room) return row;
  }
  return sidebarTabRow(order, 1, showing);
}

/**
 * The row at its narrowest: the SIDEBAR_MIN_TABS widest of the views and the caret, or every view
 * when they take less. `widthOf` leaves out their badges. Its width is 0 until every view is
 * measured.
 */
function narrowestSidebarTabRow(
  order: readonly SidebarView[],
  { widthOf, caret, alwaysCaret = false }: SidebarTabMeasures
): { width: number; count: number } {
  const widths = order.map(widthOf).sort((a, b) => b - a);
  const count = Math.min(SIDEBAR_MIN_TABS, order.length);
  const more = order.length > count;
  if (widths.some((width) => width <= 0) || ((more || alwaysCaret) && caret <= 0)) {
    return { width: 0, count };
  }
  const sum = (some: number[]) => some.reduce((total, width) => total + width, 0);
  const every = sum(widths) + (alwaysCaret ? caret : 0);
  const fewest = sum(widths.slice(0, count)) + (more || alwaysCaret ? caret : 0);
  return every <= fewest ? { width: every, count: order.length } : { width: fewest, count };
}

/**
 * The width the row needs at its narrowest. It doesn't depend on which views come first, which one
 * shows or their badges, so the sidebar doesn't resize as they change. 0 until every view is
 * measured.
 */
export function narrowestSidebarTabRowWidth(
  order: readonly SidebarView[],
  measures: SidebarTabMeasures
): number {
  return narrowestSidebarTabRow(order, measures).width;
}

/**
 * The row that fits in `room`, and whether its badges show in full or as dots. Badges show in full
 * unless they'd leave fewer whole tabs than the narrowest row has, as when one comes at the
 * narrowest; `widthOf` counts them and `titleWidthOf` doesn't.
 */
export function fittingSidebarTabs(
  order: readonly SidebarView[],
  showing: SidebarView | null,
  {
    titleWidthOf,
    ...measures
  }: SidebarTabMeasures & { room: number; titleWidthOf: (view: SidebarView) => number }
): { row: SidebarView[]; dotBadges: boolean } {
  const full = fittingSidebarTabRow(order, showing, measures);
  const titles = fittingSidebarTabRow(order, showing, { ...measures, widthOf: titleWidthOf });
  const promised = narrowestSidebarTabRow(order, { ...measures, widthOf: titleWidthOf }).count;
  return full.length >= Math.min(titles.length, promised)
    ? { row: full, dotBadges: false }
    : { row: titles, dotBadges: true };
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
 * The row after the user picks a view from the menu: it takes the place of the last tab that isn't
 * showing, so the one they came from stays.
 */
export function pickSidebarTab(
  row: readonly SidebarView[],
  picked: SidebarView,
  showing: SidebarView | null
): SidebarView[] {
  if (row.includes(picked)) return [...row];
  const next = [...row];
  const slot = row.findLastIndex((view) => view !== showing);
  next[slot === -1 ? row.length - 1 : slot] = picked;
  return next;
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
