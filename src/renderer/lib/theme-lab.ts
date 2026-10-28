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
