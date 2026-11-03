/** What the sidebar shows: the changed files, all files, or a sidebar panel by its id. */
export type SidebarView = 'diff' | 'files' | `panel:${string}`;

/** How many of the views the sidebar's tab row shows; the rest are in its menu. */
export const SIDEBAR_TAB_COUNT = 2;

export function panelView(panelId: string): SidebarView {
  return `panel:${panelId}`;
}

/** The panel's id, for a view that's a panel. */
export function viewPanelId(view: SidebarView): string | undefined {
  return view.startsWith('panel:') ? view.slice('panel:'.length) : undefined;
}

/**
 * The views the tab row shows, in order: its first two, Diff and Files with git, until the user
 * keeps others there; each kept one this workspace lacks filled in its place from its views in
 * order; and always the one showing, in place of the last, as when a status item opens a panel.
 */
export function sidebarTabRow(
  views: readonly SidebarView[],
  kept: readonly string[] | undefined,
  showing: SidebarView | null
): SidebarView[] {
  const slots = (kept ?? views)
    .slice(0, SIDEBAR_TAB_COUNT)
    .map((view) => views.find((available) => available === view));
  while (slots.length < SIDEBAR_TAB_COUNT) slots.push(undefined);
  const spare = views.filter((view) => !slots.includes(view));
  const row = slots
    .map((view) => view ?? spare.shift())
    .filter((view): view is SidebarView => view !== undefined);
  if (showing && views.includes(showing) && !row.includes(showing)) {
    row[row.length - 1] = showing;
  }
  return row;
}

/**
 * The tabs to keep after the user picks a view from the menu: it takes the place of the tab that
 * isn't showing, so the one they came from stays beside it.
 */
export function pickSidebarTab(
  row: readonly SidebarView[],
  picked: SidebarView,
  showing: SidebarView | null
): SidebarView[] {
  if (row.includes(picked)) return [...row];
  if (row.length < SIDEBAR_TAB_COUNT) return [...row, picked];
  const next = [...row];
  next[showing && row.indexOf(showing) === 0 ? 1 : 0] = picked;
  return next;
}
