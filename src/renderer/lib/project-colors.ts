/**
 * Deterministic color assignment for projects based on name hashing.
 * Provides consistent, visually distinct colors for the sidebar.
 */

export { getNextAvailableColor, PROJECT_COLORS } from '../../shared/lib/project-colors';
export { getProjectColor } from '../../shared/lib/project-color';

/** The color picked while it is still offered, or else the fallback. */
export function resolvePickedColor(picked: string, offered: string[], fallback: string): string {
  return picked && offered.includes(picked) ? picked : fallback;
}

/**
 * Returns a color string with the given alpha (0-1).
 * Works with hsl(), rgb(), and hex colors.
 */
export function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('hsl(')) {
    return color.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
  }
  if (color.startsWith('rgb(')) {
    return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
  }
  return color;
}

/**
 * Converts an HSL color string to OKLCH values string ("L C H") for CSS variable usage.
 * Standard color math: HSL → sRGB → linear sRGB → LMS → OKLab → OKLCH.
 */
export function hslToOklchValues(hsl: string): string | null {
  const match = hsl.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/);
  if (!match) return null;

  const h = parseFloat(match[1]);
  const s = parseFloat(match[2]) / 100;
  const l = parseFloat(match[3]) / 100;

  // HSL → sRGB
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r1: number, g1: number, b1: number;
  if (h < 60) {
    r1 = c;
    g1 = x;
    b1 = 0;
  } else if (h < 120) {
    r1 = x;
    g1 = c;
    b1 = 0;
  } else if (h < 180) {
    r1 = 0;
    g1 = c;
    b1 = x;
  } else if (h < 240) {
    r1 = 0;
    g1 = x;
    b1 = c;
  } else if (h < 300) {
    r1 = x;
    g1 = 0;
    b1 = c;
  } else {
    r1 = c;
    g1 = 0;
    b1 = x;
  }

  return srgbToOklchValues(r1 + m, g1 + m, b1 + m);
}

/**
 * Converts a "#rrggbb" hex color to OKLCH values string ("L C H") for CSS variable usage.
 */
export function hexToOklchValues(hex: string): string | null {
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return null;
  const [r, g, b] = match.slice(1).map((channel) => parseInt(channel, 16) / 255);
  return srgbToOklchValues(r, g, b);
}

/** OKLCH values string ("L C H") of a project color, which is "hsl(...)" or "#rrggbb" from an icon. */
export function colorToOklchValues(color: string): string | null {
  return hslToOklchValues(color) ?? hexToOklchValues(color);
}

function srgbToOklchValues(sr: number, sg: number, sb: number): string {
  // sRGB → linear sRGB
  const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const lr = toLinear(sr);
  const lg = toLinear(sg);
  const lb = toLinear(sb);

  // linear sRGB → LMS (cube root)
  const lms_l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const lms_m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const lms_s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  // LMS → OKLab
  const okL = 0.2104542553 * lms_l + 0.793617785 * lms_m - 0.0040720468 * lms_s;
  const okA = 1.9779984951 * lms_l - 2.428592205 * lms_m + 0.4505937099 * lms_s;
  const okB = 0.0259040371 * lms_l + 0.7827717662 * lms_m - 0.808675766 * lms_s;

  // OKLab → OKLCH
  const C = Math.sqrt(okA * okA + okB * okB);
  let H = Math.atan2(okB, okA) * (180 / Math.PI);
  if (H < 0) H += 360;

  return `${okL.toFixed(4)} ${C.toFixed(4)} ${H.toFixed(2)}`;
}
