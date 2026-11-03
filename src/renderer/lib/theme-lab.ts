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

// Lines: the faint lines that give the panes, the active tab, quick commands and the sidebar's
// panels an edge against the chrome. Each picker tries another strength for one of them.

/** Each line strength, as a foreground alpha; none is no line. */
const LINE_ALPHAS = { none: 0, hairline: 0.06, soft: 0.1, clear: 0.14 } as const;
type LineStrength = keyof typeof LINE_ALPHAS;
const LINE_STRENGTHS = Object.keys(LINE_ALPHAS) as LineStrength[];

const LINE_NAMES: Record<LineStrength, string> = {
  none: 'None',
  hairline: 'Hairline',
  soft: 'Soft',
  clear: 'Clear',
};

function line(strength: LineStrength): string {
  return strength === 'none'
    ? 'transparent'
    : `oklch(var(--foreground) / ${LINE_ALPHAS[strength]})`;
}

/** Where a line goes and how it is drawn there, with today's strength. */
interface LineTarget {
  /** What the line goes around, for the descriptions. */
  what: string;
  today: LineStrength;
  css: (strength: LineStrength) => string;
}

// Each line is drawn as globals.css or the component draws it: the panes' as the outline's border,
// the sidebar's selected workspace as an inset ring, the others as an inset outline. The sidebar's
// lines are dark themes' only: light themes lift those surfaces with white fills and shadows.
const PANE_LINE: LineTarget = {
  what: 'every pane without focus',
  today: 'clear',
  // The focused pane's outline and a notification's keep their colors.
  css: (strength) =>
    `.pane-outline:not([data-focused='true']):not([data-attention='true']) {\n  border-color: ${line(strength)} !important;\n}\n`,
};

function outlineLine(what: string, selector: string): LineTarget {
  return {
    what,
    today: 'clear',
    css: (strength) => `${selector} {\n  outline-color: ${line(strength)} !important;\n}\n`,
  };
}

const ACTIVE_TAB = `${TERMINAL_TAB}[data-active]`;
const TAB_LINE = outlineLine('the active tab', ACTIVE_TAB);
const QUICK_COMMANDS_LINE = outlineLine('quick commands', '.quick-commands-control');
const SIDEBAR_PANEL_LINE = outlineLine(
  'the project panels and the Pinned shelf',
  '.dark .sidebar-panel'
);
const NEW_WORKSPACE_LINE = outlineLine(
  'New Workspace and its quick create menu',
  '.dark [data-new-workspace-controls]'
);
const SELECTED_WORKSPACE_LINE: LineTarget = {
  what: 'the selected workspace',
  today: 'hairline',
  css: (strength) =>
    `.dark .sidebar-selected-card {\n  --tw-ring-color: ${line(strength)} !important;\n}\n`,
};

/** None, hairline, soft and clear lines around one target, today's strength as today's option. */
function lineOptions(target: LineTarget): LabOption[] {
  return LINE_STRENGTHS.map((strength) => {
    const today = strength === target.today;
    const name = LINE_NAMES[strength];
    const description =
      strength === 'none'
        ? `No line around ${target.what}`
        : `A ${name.toLowerCase()} line around ${target.what}`;
    return {
      id: today ? TODAY_OPTION_ID : strength,
      name,
      description: today ? `${description}, as today` : description,
      css: today ? '' : target.css(strength),
    };
  });
}

export const LAB_PANE_BORDERS: readonly LabOption[] = lineOptions(PANE_LINE);

// The focused pane's outline: today a quarter accent mixed into the muted text color, 1px wide.
// These try more of the accent, a wider line, and a glow inside the pane.
const FOCUSED_PANE = ".pane-outline[data-focused='true']";

function focusedPane(accentPercent: number, widthPx = 1, glow = false): string {
  const color =
    accentPercent >= 100
      ? 'oklch(var(--komla, var(--brand)))'
      : `color-mix(in oklab, oklch(var(--komla, var(--brand))) ${accentPercent}%, oklch(var(--muted-foreground)))`;
  const rules = [`  border-color: ${color} !important;`];
  if (widthPx !== 1) rules.push(`  border-width: ${widthPx}px !important;`);
  if (glow) {
    rules.push(
      `  box-shadow: inset 0 0 14px color-mix(in oklab, oklch(var(--komla, var(--brand))) 22%, transparent) !important;`
    );
  }
  return `${FOCUSED_PANE} {\n${rules.join('\n')}\n}\n`;
}

export const LAB_FOCUSED_PANES: readonly LabOption[] = [
  {
    id: TODAY_OPTION_ID,
    name: 'Faint',
    description: 'The accent at 25%, mostly the muted text color, as today',
    css: '',
  },
  { id: 'soft', name: 'Soft', description: 'The accent at 45%', css: focusedPane(45) },
  { id: 'strong', name: 'Strong', description: 'The accent at 70%', css: focusedPane(70) },
  { id: 'accent', name: 'Accent', description: 'The full accent color', css: focusedPane(100) },
  {
    id: 'wide',
    name: 'Faint, 2px',
    description: "Today's color in a 2px line",
    css: focusedPane(25, 2),
  },
  {
    id: 'accent-wide',
    name: 'Accent, 2px',
    description: 'The full accent color in a 2px line',
    css: focusedPane(100, 2),
  },
  {
    id: 'glow',
    name: 'Faint, glow',
    description: "Today's line, with a faint accent glow inside the pane's edge",
    css: focusedPane(25, 1, true),
  },
];

export const LAB_ACTIVE_TABS: readonly LabOption[] = [
  ...lineOptions(TAB_LINE),
  {
    id: 'raised',
    name: 'Raised',
    description: 'A stronger wash and a clear line, so the active tab reads as a raised button',
    css: `${ACTIVE_TAB} {\n  background-color: oklch(var(--foreground) / 0.11) !important;\n}\n`,
  },
  {
    id: 'accent',
    name: 'Accent',
    description: "A line in the focused pane's outline color around the active tab",
    css: `${ACTIVE_TAB} {\n  outline-color: color-mix(in oklab, oklch(var(--komla, var(--brand))) 45%, oklch(var(--muted-foreground))) !important;\n}\n`,
  },
];

export const LAB_QUICK_COMMANDS: readonly LabOption[] = lineOptions(QUICK_COMMANDS_LINE);

export const LAB_SIDEBAR_PANELS: readonly LabOption[] = lineOptions(SIDEBAR_PANEL_LINE);

export const LAB_NEW_WORKSPACE_BUTTONS: readonly LabOption[] = lineOptions(NEW_WORKSPACE_LINE);

export const LAB_SELECTED_WORKSPACES: readonly LabOption[] = lineOptions(SELECTED_WORKSPACE_LINE);

const ALL_LINES = [
  PANE_LINE,
  TAB_LINE,
  QUICK_COMMANDS_LINE,
  SIDEBAR_PANEL_LINE,
  NEW_WORKSPACE_LINE,
  SELECTED_WORKSPACE_LINE,
];

// Every edge line, around the panes, the active tab, quick commands, the sidebar's panels, New
// Workspace and the selected workspace, at one strength. The panel puts it first, so a picker
// below it still wins. The file panel's frame and the dividers have their own pickers.
export const LAB_ALL_LINES: readonly LabOption[] = [
  {
    id: TODAY_OPTION_ID,
    name: 'Mixed',
    description: 'Each line at its own strength, as today',
    css: '',
  },
  ...LINE_STRENGTHS.map((strength) => ({
    id: strength,
    name: LINE_NAMES[strength],
    description:
      strength === 'none'
        ? 'No edge lines on the panes, tabs and sidebar'
        : `Every edge line on the panes, tabs and sidebar ${LINE_NAMES[strength].toLowerCase()}`,
    css: ALL_LINES.map((target) => target.css(strength)).join(''),
  })),
];

// The file panel: today a block like the panes, its line across its top and down its left edge
// from rounded corners, a gutter above the status bar, its header on the chrome above. These try
// other ways to set it apart.
const FILE_PANEL = '.file-panel-chrome';
const FILE_PANEL_BODY = '.file-panel-body';
const FILE_PANEL_HEADER = '[data-testid="file-panel-header"]';
const PANEL_FILL = 'oklch(var(--sidebar-muted))';

// Takes away today's line, corners and gutter.
const PANEL_RESET = `${FILE_PANEL} {\n  padding-bottom: 0 !important;\n}\n${FILE_PANEL_BODY} {\n  border-width: 0 !important;\n  border-radius: 0 !important;\n}\n`;

const PANEL_FILL_CSS = `${FILE_PANEL_BODY} {\n  --card: var(--sidebar-muted) !important;\n  background-color: ${PANEL_FILL} !important;\n}\n`;

// A card on the chrome like a pane: the same corners and gutter, and a clear line. The panes'
// gutter is to its left already, so it keeps one on its right and below.
function panelCard(fill: boolean): string {
  return `${PANEL_RESET}${FILE_PANEL} {\n  padding: 0 var(--pane-gap) var(--pane-gap) 0 !important;\n}\n${FILE_PANEL_BODY} {\n  border-radius: var(--pane-radius) !important;\n  outline: 1px solid ${line('clear')};\n  outline-offset: -1px;\n}\n${fill ? PANEL_FILL_CSS : ''}`;
}

export const LAB_FILE_PANELS: readonly LabOption[] = [
  {
    id: TODAY_OPTION_ID,
    name: 'Edge',
    description:
      'A clear line across its top and down its left edge, from rounded corners, as today',
    css: '',
  },
  {
    id: 'straight',
    name: 'Straight edge',
    description:
      'A clear line down its left edge only, from the top of the window to the status bar',
    css: `${PANEL_RESET}${FILE_PANEL_BODY} {\n  border-left-width: 1px !important;\n}\n${FILE_PANEL_HEADER} {\n  border-left: 1px solid ${line('clear')};\n}\n`,
  },
  {
    id: 'chrome',
    name: 'Chrome',
    description: 'On the chrome, with only a faint line under it, as before',
    css: `${PANEL_RESET}${FILE_PANEL} {\n  box-shadow: inset 0 -1px 0 oklch(var(--foreground) / 0.08);\n}\n`,
  },
  {
    id: 'fill',
    name: 'Filled edge',
    description: "Today's line and corner, the panel in the project panels' fill",
    css: PANEL_FILL_CSS,
  },
  {
    id: 'card',
    name: 'Card',
    description: 'A rounded card like a pane, with a clear line, its header on the chrome above',
    css: panelCard(false),
  },
  {
    id: 'card-fill',
    name: 'Filled card',
    description: "A rounded card in the project panels' fill, with a clear line",
    css: panelCard(true),
  },
];

// The line under the file tree's header (its search or its changes summary): today a soft line, a
// step under the panel's own.
export const LAB_FILE_TREE_DIVIDERS: readonly LabOption[] = [
  {
    id: 'border',
    name: 'Border',
    description: "The theme's border color, as before",
    css: `${FILE_PANEL_BODY} .file-tree-header {\n  border-bottom-color: oklch(var(--border)) !important;\n}\n`,
  },
  ...(['clear', 'soft', 'hairline'] as const).map((strength) => ({
    id: strength === 'soft' ? TODAY_OPTION_ID : strength,
    name: LINE_NAMES[strength],
    description: `A ${LINE_NAMES[strength].toLowerCase()} line under the file tree's header${strength === 'soft' ? ', as today' : ''}`,
    css:
      strength === 'soft'
        ? ''
        : `${FILE_PANEL_BODY} .file-tree-header {\n  border-bottom-color: ${line(strength)} !important;\n}\n`,
  })),
];

// Where the panel's line starts: today below its Diff/Files header, at a rounded corner level
// with the panes' tops.
export const LAB_FILE_PANEL_TOPS: readonly LabOption[] = [
  {
    id: TODAY_OPTION_ID,
    name: 'Rounded top',
    description:
      'The line starts below the header, at a rounded corner level with the panes, as today',
    css: '',
  },
  {
    id: 'open',
    name: 'Open',
    description: 'The line runs on up past the header to the top of the window',
    css: `${FILE_PANEL_BODY} {\n  border-top-width: 0 !important;\n  border-top-left-radius: 0 !important;\n}\n${FILE_PANEL_HEADER} {\n  border-left: 1px solid ${line('clear')};\n}\n`,
  },
  {
    id: 'header-line',
    name: 'Line under header',
    description: 'The line runs up to the top of the window, with a soft line under the header',
    css: `${FILE_PANEL_BODY} {\n  border-top-width: 0 !important;\n  border-top-left-radius: 0 !important;\n}\n${FILE_PANEL_HEADER} {\n  border-left: 1px solid ${line('clear')};\n  box-shadow: inset 0 -1px 0 ${line('soft')};\n}\n`,
  },
];

// Between the tab row and the file panel's header, which share the top row's chrome: today a
// short soft upright line at the header's left edge, over the panel's own.
function topRowDivider(height: string, strength: LineStrength): string {
  return `${FILE_PANEL_HEADER}::before {\n  height: ${height} !important;\n  background-color: ${line(strength)} !important;\n}\n`;
}

export const LAB_TOP_ROW_DIVIDERS: readonly LabOption[] = [
  {
    id: TODAY_OPTION_ID,
    name: 'Short, soft',
    description: 'A short soft line between the tabs and the Diff/Files header, as today',
    css: '',
  },
  {
    id: 'none',
    name: 'None',
    description: 'Nothing between the tabs and the Diff/Files header',
    css: `${FILE_PANEL_HEADER}::before {\n  content: none !important;\n}\n`,
  },
  {
    id: 'short-clear',
    name: 'Short, clear',
    description: 'A short clear line between the tabs and the Diff/Files header',
    css: topRowDivider('16px', 'clear'),
  },
  {
    id: 'tall',
    name: 'Tall, soft',
    description: "A soft line nearly the top row's height between the tabs and the header",
    css: topRowDivider('calc(100% - 12px)', 'soft'),
  },
];

// The bottom row: the sidebar's footer (Komla, the filter and settings menus) and the status bar,
// one bar along the window's bottom: today a clear line along its top, and a short soft line
// between the footer and the status bar. These try the line at other strengths, or the bar filled.
const SIDEBAR_FOOTER = '[data-sidebar-footer]';
const STATUS_BAR = '[data-status-bar]';
const BOTTOM_BAR = `${SIDEBAR_FOOTER}, ${STATUS_BAR}`;
const BAR_FILL = 'color-mix(in oklch, oklch(var(--foreground)) 3%, oklch(var(--chrome)))';

function barLine(selector: string, strength: LineStrength): string {
  return `${selector} {\n  box-shadow: inset 0 1px 0 ${line(strength)} !important;\n}\n`;
}

export const LAB_BOTTOM_BARS: readonly LabOption[] = [
  {
    id: TODAY_OPTION_ID,
    name: 'Clear line',
    description: 'A clear line along the top of the whole bottom row, as today',
    css: '',
  },
  {
    id: 'none',
    name: 'None',
    description: 'Nothing along the top of the bottom row',
    css: barLine(BOTTOM_BAR, 'none'),
  },
  {
    id: 'hairline',
    name: 'Hairline',
    description: 'A hairline along the top of the whole bottom row',
    css: barLine(BOTTOM_BAR, 'hairline'),
  },
  {
    id: 'soft',
    name: 'Soft line',
    description: 'A soft line along the top of the whole bottom row',
    css: barLine(BOTTOM_BAR, 'soft'),
  },
  {
    id: 'footer',
    name: 'Footer only',
    description: "A clear line above the sidebar's footer only, closing the workspace list",
    css: barLine(STATUS_BAR, 'none'),
  },
  {
    id: 'fill',
    name: 'Fill and line',
    description: 'The whole bottom row a step lighter than the chrome, with its clear line',
    css: `${BOTTOM_BAR} {\n  background-color: ${BAR_FILL} !important;\n}\n`,
  },
];

// Between the sidebar's footer and the status bar: today a short soft line, as in the top row.
export const LAB_BOTTOM_ROW_DIVIDERS: readonly LabOption[] = [
  {
    id: TODAY_OPTION_ID,
    name: 'Short, soft',
    description: "A short soft line between the sidebar's footer and the status bar, as today",
    css: '',
  },
  {
    id: 'none',
    name: 'None',
    description: "Nothing between the sidebar's footer and the status bar",
    css: `${SIDEBAR_FOOTER}::after {\n  content: none !important;\n}\n`,
  },
  {
    id: 'short-clear',
    name: 'Short, clear',
    description: "A short clear line between the sidebar's footer and the status bar",
    css: `${SIDEBAR_FOOTER}::after {\n  background-color: ${line('clear')} !important;\n}\n`,
  },
  {
    id: 'full',
    name: 'Full height',
    description: "A soft line the bottom row's full height, the sidebar's edge carried down",
    css: `${SIDEBAR_FOOTER}::after {\n  top: 0 !important;\n  height: 100% !important;\n  transform: none !important;\n}\n`,
  },
];
