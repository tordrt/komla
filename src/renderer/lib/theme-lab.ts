// Theme Lab (dev builds only): live style changes for trying out Komla's default look on the real
// UI before writing them into globals.css.

/** A background for the status bar while a workspace is open. */
export interface LabStatusBar {
  id: string;
  name: string;
  description: string;
  /** Its CSS background, unused for today's. */
  background: string;
}

export const TODAY_STATUS_BAR_ID = 'today';

export const LAB_STATUS_BARS: readonly LabStatusBar[] = [
  {
    id: TODAY_STATUS_BAR_ID,
    name: 'Today',
    description: 'The sidebar color',
    background: '',
  },
  {
    id: 'half',
    name: 'Halfway',
    description: 'Halfway from the card to the sidebar',
    background: 'color-mix(in oklch, oklch(var(--card)) 50%, oklch(var(--chrome)))',
  },
  {
    id: 'card',
    name: 'Card',
    description: 'The work area card, as before',
    background: 'oklch(var(--card))',
  },
];

// With no workspace open, the status bar keeps the sidebar's color, as the empty page around it.
const OPEN_WORK_COLUMN = '.work-column:not(:has(.empty-work-area))';

/** The stylesheet for the tried status bar background; today's adds none. */
export function statusBarCss(id: string): string {
  const bar = LAB_STATUS_BARS.find((option) => option.id === id);
  if (!bar || bar.id === TODAY_STATUS_BAR_ID) return '';
  return `${OPEN_WORK_COLUMN} [data-status-bar] {\n  background-color: ${bar.background} !important;\n}\n`;
}

/** A style the lab can try, with the stylesheet that applies it. */
export interface LabOption {
  id: string;
  name: string;
  description: string;
  /** Its stylesheet, empty for today's. */
  css: string;
}

export const TODAY_OPTION_ID = 'today';

/** Clears the faint line globals.css draws along the file panel's bottom edge. */
const NO_PANEL_LINE = '.file-panel-chrome {\n  box-shadow: none !important;\n}\n';

function statusBarTopLine(alpha: number): string {
  return `${OPEN_WORK_COLUMN} [data-status-bar] {\n  box-shadow: inset 0 1px 0 oklch(var(--foreground) / ${alpha}) !important;\n}\n${NO_PANEL_LINE}`;
}

export const LAB_STATUS_BAR_LINES: readonly LabOption[] = [
  {
    id: TODAY_OPTION_ID,
    name: 'Under panel',
    description: 'A faint line above the status bar under the file panel only, as today',
    css: '',
  },
  {
    id: 'none',
    name: 'None',
    description: 'No line above the status bar',
    css: NO_PANEL_LINE,
  },
  {
    id: 'soft',
    name: 'Soft',
    description: 'A soft line along the whole top of the status bar',
    css: statusBarTopLine(0.06),
  },
  {
    id: 'faint',
    name: 'Faint',
    description: 'A faint line along the whole top of the status bar',
    css: statusBarTopLine(0.1),
  },
];

/** Options that set one of globals.css's root variables, today's value first. */
function rootVariableOptions(
  variable: string,
  today: number,
  values: readonly number[],
  describe: (px: number) => string
): LabOption[] {
  return [today, ...values].map((px) => ({
    id: px === today ? TODAY_OPTION_ID : String(px),
    name: `${px}px`,
    description: px === today ? `${describe(px)}, as today` : describe(px),
    css: px === today ? '' : `:root {\n  ${variable}: ${px}px !important;\n}\n`,
  }));
}

export const LAB_PANE_CORNERS: readonly LabOption[] = rootVariableOptions(
  '--pane-radius',
  12,
  [8, 10, 14, 16],
  (px) => `${px}px corners on every pane`
);

export const LAB_PANE_GAPS: readonly LabOption[] = rootVariableOptions(
  '--pane-gap',
  6,
  [4, 8],
  (px) => `A ${px}px gutter of chrome between the panes and around them`
);

const TERMINAL_TAB = '[data-testid="terminal-tab-row"] [data-tab-id] > [role="button"]';

function tabCorners(radius: string): string {
  return `${TERMINAL_TAB} {\n  border-radius: ${radius} !important;\n}\n`;
}

export const LAB_TAB_CORNERS: readonly LabOption[] = [
  { id: TODAY_OPTION_ID, name: '6px', description: '6px corners on the tabs, as today', css: '' },
  { id: '8', name: '8px', description: '8px corners on the tabs', css: tabCorners('8px') },
  { id: '12', name: '12px', description: '12px corners on the tabs', css: tabCorners('12px') },
  {
    id: 'round',
    name: 'Round',
    description: 'Fully rounded ends on the tabs',
    css: tabCorners('9999px'),
  },
];

/** The stylesheet for the tried option; today's or an unknown one adds none. */
export function optionCss(options: readonly LabOption[], id: string): string {
  return options.find((option) => option.id === id)?.css ?? '';
}
