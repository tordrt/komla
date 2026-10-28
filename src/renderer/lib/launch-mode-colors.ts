// Colors a user can pick for an agent launch mode. They are categories, not statuses,
// so they use the Tailwind palette directly instead of the status tokens.
export const LAUNCH_MODE_COLORS = [
  'blue',
  'purple',
  'amber',
  'emerald',
  'red',
  'cyan',
  'pink',
  'orange',
] as const;

export type LaunchModeColor = (typeof LAUNCH_MODE_COLORS)[number];

// Modes without a saved color cycle through these by position.
const FALLBACK_LAUNCH_MODE_COLORS: readonly LaunchModeColor[] = [
  'blue',
  'purple',
  'amber',
  'emerald',
];

function isLaunchModeColor(color: string): color is LaunchModeColor {
  return (LAUNCH_MODE_COLORS as readonly string[]).includes(color);
}

/** The color a launch mode shows everywhere: its saved color, or one picked by position. */
export function getLaunchModeColor(
  savedColor: string | null | undefined,
  index: number
): LaunchModeColor {
  if (!savedColor) {
    return FALLBACK_LAUNCH_MODE_COLORS[
      ((index % FALLBACK_LAUNCH_MODE_COLORS.length) + FALLBACK_LAUNCH_MODE_COLORS.length) %
        FALLBACK_LAUNCH_MODE_COLORS.length
    ];
  }
  return isLaunchModeColor(savedColor) ? savedColor : 'amber';
}

/** Text in the mode's color, readable in light and dark palettes. */
export const LAUNCH_MODE_TEXT_CLASSES: Record<LaunchModeColor, string> = {
  blue: 'text-blue-700 dark:text-blue-400',
  purple: 'text-purple-700 dark:text-purple-400',
  amber: 'text-amber-800 dark:text-amber-400',
  emerald: 'text-emerald-800 dark:text-emerald-400',
  red: 'text-red-700 dark:text-red-400',
  cyan: 'text-cyan-800 dark:text-cyan-400',
  pink: 'text-pink-700 dark:text-pink-400',
  orange: 'text-orange-800 dark:text-orange-400',
};

/** Solid swatch or dot. */
export const LAUNCH_MODE_DOT_CLASSES: Record<LaunchModeColor, string> = {
  blue: 'bg-blue-500',
  purple: 'bg-purple-500',
  amber: 'bg-amber-500',
  emerald: 'bg-emerald-500',
  red: 'bg-red-500',
  cyan: 'bg-cyan-500',
  pink: 'bg-pink-500',
  orange: 'bg-orange-500',
};

/** Tinted pill, readable in light and dark palettes. Add `ring-1` for an outline. */
export const LAUNCH_MODE_PILL_CLASSES: Record<LaunchModeColor, string> = {
  blue: 'bg-blue-500/15 text-blue-700 ring-blue-500/30 dark:text-blue-400',
  purple: 'bg-purple-500/15 text-purple-700 ring-purple-500/30 dark:text-purple-400',
  amber: 'bg-amber-500/15 text-amber-800 ring-amber-500/30 dark:text-amber-400',
  emerald: 'bg-emerald-500/15 text-emerald-800 ring-emerald-500/30 dark:text-emerald-400',
  red: 'bg-red-500/15 text-red-700 ring-red-500/30 dark:text-red-400',
  cyan: 'bg-cyan-500/15 text-cyan-800 ring-cyan-500/30 dark:text-cyan-400',
  pink: 'bg-pink-500/15 text-pink-700 ring-pink-500/30 dark:text-pink-400',
  orange: 'bg-orange-500/15 text-orange-800 ring-orange-500/30 dark:text-orange-400',
};
