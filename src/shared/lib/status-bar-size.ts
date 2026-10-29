/** How tall the status bar along the bottom of the window is. */
export const STATUS_BAR_SIZES = ['small', 'medium', 'large'] as const;

export type StatusBarSize = (typeof STATUS_BAR_SIZES)[number];

export const DEFAULT_STATUS_BAR_SIZE: StatusBarSize = 'medium';
