/**
 * Deterministic color assignment for projects based on name hashing, shared by the renderer
 * and the main process (which sends project colors to the phone).
 */

import { PROJECT_COLORS } from './project-colors';

/**
 * Simple string hash function for deterministic color selection.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
}

/**
 * Returns a consistent color for a given project name.
 * The same project name will always return the same color.
 */
export function getProjectColor(projectName: string): string {
  return PROJECT_COLORS[hashString(projectName) % PROJECT_COLORS.length];
}

/**
 * The color a project shows in Komla, saved or derived from its name, as `#rrggbb`; undefined for
 * a saved color that is neither hex nor hsl().
 */
export function projectColorHex(
  savedColor: string | undefined,
  projectName: string
): string | undefined {
  const color = savedColor || getProjectColor(projectName);
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  const match = color.match(/^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/);
  if (!match) return undefined;
  const h = Number(match[1]) % 360;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return `#${[r, g, b]
    .map((channel) =>
      Math.round((channel + m) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}
