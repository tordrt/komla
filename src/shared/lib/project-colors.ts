/**
 * Project colors, shared so the main process assigns them in the order the renderer's
 * pickers show them.
 */

export const PROJECT_COLORS = [
  'hsl(200, 75%, 50%)', // Sky Blue - slightly muted
  'hsl(340, 70%, 55%)', // Rose - slightly warmer, softer
  'hsl(42, 85%, 50%)', // Amber - matches primary
  'hsl(170, 55%, 48%)', // Teal - warmer, softer
  'hsl(188, 70%, 42%)', // Cyan - warmer teal-cyan
  'hsl(145, 58%, 42%)', // Emerald - warmer green
  'hsl(24, 85%, 52%)', // Orange - slightly softer
  'hsl(8, 75%, 55%)', // Red - warmer, less harsh
  'hsl(88, 60%, 42%)', // Lime - warmer olive-lime
  'hsl(328, 65%, 58%)', // Fuchsia - warmer pink
  'hsl(265, 65%, 58%)', // Purple - warmer undertone
  'hsl(275, 55%, 58%)', // Violet - warmer undertone
];

/**
 * Returns the next available color from the palette.
 * If all colors are used, cycles back to the beginning.
 */
export function getNextAvailableColor(usedColors: string[]): string {
  for (const color of PROJECT_COLORS) {
    if (!usedColors.includes(color)) return color;
  }
  // All used, cycle back
  return PROJECT_COLORS[usedColors.length % PROJECT_COLORS.length];
}
