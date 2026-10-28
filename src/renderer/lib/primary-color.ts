import type { PaletteMode } from './palette-presets';

// Lightness bounds for --primary, which is used both as text on the palette surfaces and as a
// fill under --primary-foreground (dark text in dark mode, white text in light mode). Within
// these bounds every accent swatch and project color meets WCAG AA in both roles.
const DARK_MODE_MIN_LIGHTNESS = 0.7;
const LIGHT_MODE_MAX_LIGHTNESS = 0.5;
// A gray accent is ink rather than a hue: near-black on light themes, as near-white is on dark.
const LIGHT_MODE_MAX_NEUTRAL_LIGHTNESS = 0.205;
const NEUTRAL_MAX_CHROMA = 0.01;

/** Whether an OKLCH "L C H" triplet has a hue, rather than being gray or not a triplet. */
function isHued(triplet: string): boolean {
  return Number(triplet.trim().split(/\s+/)[1]) >= NEUTRAL_MAX_CHROMA;
}

/** Fit an OKLCH "L C H" accent to the palette mode, keeping its hue and chroma. */
export function primaryForMode(triplet: string, mode: PaletteMode): string {
  const parts = triplet.trim().split(/\s+/);
  const lightness = Number(parts[0]);
  if (parts.length !== 3 || !Number.isFinite(lightness)) return triplet;
  const lightMax = isHued(triplet) ? LIGHT_MODE_MAX_LIGHTNESS : LIGHT_MODE_MAX_NEUTRAL_LIGHTNESS;
  const fitted =
    mode === 'dark' ? Math.max(lightness, DARK_MODE_MIN_LIGHTNESS) : Math.min(lightness, lightMax);
  return [fitted, parts[1], parts[2]].join(' ');
}

// theme.json holds the accent. This copy lets the window start in it before theme.json loads.
const ACCENT_CACHE_KEY = 'komla.accent';
let cachePaused = false;

function extractOklchValues(color: string): string {
  const match = color.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/);
  if (match) {
    return `${match[1]} ${match[2]} ${match[3]}`;
  }
  return color;
}

/** The --primary "L C H" an "oklch(L C H)" accent gives under a palette mode. */
export function accentPrimary(accent: string, mode: PaletteMode): string {
  return primaryForMode(extractOklchValues(accent), mode);
}

/**
 * Sets --primary and --ring from an "oklch(L C H)" accent, and --dark-primary to its dark form for
 * the dark terminal panes of a light theme, and remembers it for the next launch. The Komla
 * logo (--komla) takes the accent too, or Komla blue when the accent is gray or unreadable.
 */
export function applyAccent(accent: string, mode: PaletteMode): void {
  const primary = accentPrimary(accent, mode);
  const root = document.documentElement;
  root.style.setProperty('--primary', primary);
  root.style.setProperty('--ring', primary);
  root.style.setProperty('--dark-primary', accentPrimary(accent, 'dark'));
  root.style.setProperty('--komla', isHued(primary) ? primary : 'var(--brand)');
  if (cachePaused) return;
  try {
    localStorage.setItem(ACCENT_CACHE_KEY, accent);
  } catch {
    // Ignore quota / disabled storage
  }
}

/** While paused, accents still apply but the next launch keeps starting in the cached one. */
export function pauseAccentCache(paused: boolean): void {
  cachePaused = paused;
}

/** The accent last applied in this browser. */
export function readStoredAccent(): string | null {
  try {
    return localStorage.getItem(ACCENT_CACHE_KEY);
  } catch {
    return null;
  }
}
