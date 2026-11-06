// Theme Lab (dev builds only): live style changes for trying out Komla's default look on the real
// UI before writing them into globals.css.

/** A style the lab can try, with the stylesheet that applies it. */
export interface LabOption {
  id: string;
  name: string;
  description: string;
  /** Its stylesheet, empty for today's. */
  css: string;
}

export const TODAY_OPTION_ID = 'today';

/** The variable the lab sets to the terminal's background, which the panes sit on. */
export const LAB_PANE_COLOR_VARIABLE = '--lab-pane-color';

/** The stylesheet for the tried option; today's or an unknown one adds none. */
export function optionCss(options: readonly LabOption[], id: string): string {
  return options.find((option) => option.id === id)?.css ?? '';
}

/** Sets the color the Card option's card takes, the terminal's background. */
export function paneColorCss(color: string): string {
  return `:root {\n  ${LAB_PANE_COLOR_VARIABLE}: ${color};\n}\n`;
}

// The empty page, with no workspace open: today a clear line down the sidebar's edge sets it
// apart from the page, which shares its chrome (globals.css). The Overview also has
// `empty-work-area`, but it hides the sidebar, so these leave it alone.
const EMPTY_PAGE = '.empty-work-area:not(.overview-surface)';
// The pages the line runs beside and the card holds: the empty page, and a workspace's page while
// it restarts or sets up, which opening a stopped or new workspace shows before its panes.
const EDGE_PAGE = `:is(${EMPTY_PAGE}, .workspace-status-page)`;
const EDGE_WORK_COLUMN = `.work-column:has(${EDGE_PAGE})`;
const LINE = 'oklch(var(--foreground) / 0.14)';

const NO_SIDEBAR_LINE = `.window-chrome:has(${EDGE_PAGE}) > .sidebar-surface::after {\n  content: none !important;\n}\n`;

export const LAB_EMPTY_PAGES: readonly LabOption[] = [
  {
    id: TODAY_OPTION_ID,
    name: 'Line',
    description:
      "A clear line down the sidebar's edge to the status bar, or the window's bottom without one, as today",
    css: '',
  },
  {
    id: 'none',
    name: 'None',
    description: 'On the chrome like the sidebar, nothing between them, as before',
    css: NO_SIDEBAR_LINE,
  },
  {
    id: 'card',
    name: 'Card',
    description:
      "A rounded card like a workspace's panes, with their gutter, line and terminal color, also while a workspace starts",
    css: `${NO_SIDEBAR_LINE}${EDGE_WORK_COLUMN} main {\n  padding: 0 var(--pane-gap) var(--pane-gap) var(--pane-gap);\n}\n${EDGE_WORK_COLUMN} [data-komla-title-bar] {\n  border-color: transparent !important;\n}\n${EDGE_WORK_COLUMN} ${EDGE_PAGE} {\n  background-color: var(${LAB_PANE_COLOR_VARIABLE}) !important;\n  border: 1px solid ${LINE};\n  border-radius: var(--pane-radius);\n  overflow: hidden;\n}\n`,
  },
  {
    id: 'tint',
    name: 'Sidebar tint',
    description: "The sidebar a step lighter than the chrome, on every page, with today's line",
    css: `.sidebar-surface.window-chrome {\n  background: oklch(var(--sidebar));\n}\n`,
  },
];
