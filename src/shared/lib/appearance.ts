// The built-in themes and the rules a theme must follow. The main process checks
// `komla settings apply appearance` with them, and the renderer checks edits to theme.json.

import type { AppearanceSettings, CustomPaletteConfig, ThemeConfig } from '../types/customization';

export type ThemeMode = 'dark' | 'light';

export const DEFAULT_PALETTE_ID = 'default';
/** Komla Light: the light theme while following the system, until the user chooses another. */
export const LIGHT_PALETTE_ID = 'frost';
/** theme.json's customPalette. */
export const CUSTOM_PALETTE_ID = 'custom';

/** Neutral ink, Komla Dark's accent: near-white. Komla Light uses its near-black form. */
export const DEFAULT_ACCENT = 'oklch(0.922 0 0)';
export const DEFAULT_LIGHT_ACCENT = 'oklch(0.205 0 0)';

export interface BuiltInTheme {
  id: string;
  name: string;
  mode: ThemeMode;
  /** "oklch(L C H)" */
  accent: string;
}

/**
 * The renderer's PALETTES, which define these themes' colors. Choosing a theme also sets its
 * accent, which the user can change afterwards.
 */
export const BUILT_IN_THEMES: ReadonlyArray<BuiltInTheme> = [
  { id: 'default', name: 'Komla Dark', mode: 'dark', accent: DEFAULT_ACCENT },
  { id: 'slate', name: 'Komla Slate', mode: 'dark', accent: DEFAULT_ACCENT },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    mode: 'dark',
    accent: 'oklch(0.79 0.12 305)',
  },
  { id: 'dracula', name: 'Dracula', mode: 'dark', accent: 'oklch(0.74 0.15 302)' },
  { id: 'github-dark', name: 'GitHub Dark', mode: 'dark', accent: 'oklch(0.7 0.19 258)' },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', mode: 'dark', accent: 'oklch(0.73 0.18 52)' },
  { id: 'kanagawa', name: 'Kanagawa', mode: 'dark', accent: 'oklch(0.7 0.1 264)' },
  { id: 'monokai', name: 'Monokai', mode: 'dark', accent: 'oklch(0.7 0.24 7)' },
  { id: 'nord', name: 'Nord', mode: 'dark', accent: 'oklch(0.77 0.06 217)' },
  { id: 'one-dark', name: 'One Dark', mode: 'dark', accent: 'oklch(0.73 0.12 245)' },
  { id: 'rose-pine', name: 'Rosé Pine', mode: 'dark', accent: 'oklch(0.78 0.09 305)' },
  { id: 'solarized-dark', name: 'Solarized Dark', mode: 'dark', accent: 'oklch(0.7 0.14 245)' },
  { id: 'tokyo-night', name: 'Tokyo Night', mode: 'dark', accent: 'oklch(0.72 0.13 264)' },
  { id: LIGHT_PALETTE_ID, name: 'Komla Light', mode: 'light', accent: DEFAULT_LIGHT_ACCENT },
  {
    id: 'slate-light',
    name: 'Komla Slate Light',
    mode: 'light',
    accent: DEFAULT_LIGHT_ACCENT,
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    mode: 'light',
    accent: 'oklch(0.5 0.25 297)',
  },
  { id: 'github-light', name: 'GitHub Light', mode: 'light', accent: 'oklch(0.5 0.19 257)' },
  { id: 'one-light', name: 'One Light', mode: 'light', accent: 'oklch(0.5 0.2 270)' },
  { id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', mode: 'light', accent: 'oklch(0.5 0.07 306)' },
  { id: 'solarized-light', name: 'Solarized Light', mode: 'light', accent: 'oklch(0.5 0.14 245)' },
];

/** Whether a theme is dark or light; undefined for an id that isn't a theme. */
export function themeMode(
  paletteId: string,
  customPalette: CustomPaletteConfig | undefined
): ThemeMode | undefined {
  if (paletteId === CUSTOM_PALETTE_ID) return customPalette?.mode;
  return BUILT_IN_THEMES.find((theme) => theme.id === paletteId)?.mode;
}

type SystemThemeChoice = Pick<
  ThemeConfig,
  'palette' | 'followSystem' | 'lightPalette' | 'customPalette' | 'colors'
>;

/**
 * The theme to show, with its accent: with followSystem, the light theme while the system is
 * light. A light theme id that isn't a light theme shows as Komla Light.
 */
export function shownTheme<T extends SystemThemeChoice>(theme: T, systemIsDark: boolean): T {
  if (!theme.followSystem || systemIsDark) return theme;
  const id = theme.lightPalette;
  return {
    ...theme,
    palette: themeMode(id, theme.customPalette) === 'light' ? id : LIGHT_PALETTE_ID,
    colors: { ...theme.colors, accent: theme.colors.lightAccent },
  };
}

/**
 * The theme and accent that choosing a theme of this mode replaces: with followSystem, the light
 * theme for a light one and the dark theme for any other; otherwise the theme.
 */
export function themeSlot(
  theme: Pick<ThemeConfig, 'followSystem' | 'palette' | 'lightPalette' | 'colors'>,
  mode: ThemeMode | undefined
): { palette: string; accent: string } {
  return theme.followSystem && mode === 'light'
    ? { palette: theme.lightPalette, accent: theme.colors.lightAccent }
    : { palette: theme.palette, accent: theme.colors.accent };
}

/** Saves a chosen theme and its accent where themeSlot finds the theme they replace. */
export function themeChoice(
  theme: Pick<ThemeConfig, 'followSystem' | 'colors'>,
  paletteId: string,
  mode: ThemeMode | undefined,
  accent: string
): Pick<ThemeConfig, 'colors'> &
  (Pick<ThemeConfig, 'palette'> | Pick<ThemeConfig, 'lightPalette'>) {
  return theme.followSystem && mode === 'light'
    ? { lightPalette: paletteId, colors: { ...theme.colors, lightAccent: accent } }
    : { palette: paletteId, colors: { ...theme.colors, accent } };
}

/** The accent choosing a theme brings: a built-in theme's own, or the one saved with the custom theme. */
export function themeAccent(
  paletteId: string,
  customPalette: CustomPaletteConfig | undefined
): string | undefined {
  if (paletteId === CUSTOM_PALETTE_ID) return customPalette?.accent;
  return BUILT_IN_THEMES.find((theme) => theme.id === paletteId)?.accent;
}

export const MIN_TEXT_CONTRAST = 4.5;
export const MAX_BORDER_RADIUS = 24;

// Text colors globals.css draws on a palette's surfaces in each mode.
export const MODE_TEXT: Record<ThemeMode, { foreground: string; mutedForeground: string }> = {
  dark: { foreground: '0.985 0 0', mutedForeground: '0.75 0 0' },
  light: { foreground: '0.145 0 0', mutedForeground: '0.5 0 0' },
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const OKLCH_COLOR = /^oklch\(\s*[\d.]+\s+[\d.]+\s+[\d.]+\s*\)$/;
export const REQUIRED_SURFACES = ['background', 'card', 'muted', 'highlight', 'border'] as const;
const ANSI_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

// CSS vars hold the raw OKLCH triplet ("L C H"). Convert to a hex string the
// way Electron's setTitleBarOverlay expects. Done in JS rather than via canvas
// because Chromium may serialize fillStyle back as oklch() instead of rgb().
export function oklchTripletToHex(triplet: string): string | null {
  // Minified CSS drops leading zeros (".175"), so the integer part is optional.
  const numberPattern = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
  const m = triplet
    .trim()
    .match(new RegExp(`^(${numberPattern})\\s+(${numberPattern})\\s+(${numberPattern})$`));
  if (!m) return null;
  const L = parseFloat(m[1]);
  const C = parseFloat(m[2]);
  const h = parseFloat(m[3]) * (Math.PI / 180);
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  // OKLab → linear sRGB
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;
  const lr = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const lg = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const lb = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  // Clamp into [0,1] before gamma — out-of-gamut OKLCH yields negative linear
  // values, and Math.pow(negative, 1/2.4) is NaN.
  const gamma = (x: number) => {
    const c = Math.max(0, Math.min(1, x));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  };
  const toHex = (x: number) =>
    Math.max(0, Math.min(255, Math.round(gamma(x) * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(lr)}${toHex(lg)}${toHex(lb)}`;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two 6-digit hex colors. */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** Whether white text reads better than black on a 6-digit hex color. */
export function isDarkColor(hex: string): boolean {
  return contrastRatio(hex, '#ffffff') > contrastRatio(hex, '#000000');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function colorProblem(path: string, value: unknown, required: boolean): string[] {
  if (value === undefined && !required) return [];
  if (typeof value === 'string' && HEX_COLOR.test(value)) return [];
  return [`customPalette.${path} must be a 6-digit hex color like "#1e1e2e".`];
}

function ansiProblems(ansi: unknown): string[] {
  if (ansi === undefined) return [];
  if (!isRecord(ansi)) return ['customPalette.terminal.ansi must be an object.'];
  return Object.entries(ansi).flatMap(([key, value]) =>
    (ANSI_NAMES as readonly string[]).includes(key)
      ? colorProblem(`terminal.ansi.${key}`, value, false)
      : [`customPalette.terminal.ansi.${key} isn't a terminal color. Use ${ANSI_NAMES.join(', ')}.`]
  );
}

function shapeProblems(config: Record<string, unknown>): string[] {
  const surfaceColors = isRecord(config.surfaces) ? config.surfaces : {};
  const terminal = isRecord(config.terminal) ? config.terminal : {};
  return [
    ...(config.mode === 'dark' || config.mode === 'light'
      ? []
      : ['customPalette.mode must be "dark" or "light".']),
    ...(config.name === undefined || typeof config.name === 'string'
      ? []
      : ['customPalette.name must be text.']),
    ...(config.accent === undefined ||
    (typeof config.accent === 'string' && OKLCH_COLOR.test(config.accent))
      ? []
      : ['customPalette.accent must look like "oklch(0.65 0.15 250)".']),
    ...(isRecord(config.surfaces) ? [] : ['customPalette.surfaces must be an object.']),
    ...(isRecord(config.terminal) ? [] : ['customPalette.terminal must be an object.']),
    ...REQUIRED_SURFACES.flatMap((key) =>
      colorProblem(`surfaces.${key}`, surfaceColors[key], true)
    ),
    ...colorProblem('surfaces.popover', surfaceColors.popover, false),
    ...colorProblem('surfaces.sidebar', surfaceColors.sidebar, false),
    ...colorProblem('terminal.background', terminal.background, true),
    ...colorProblem('terminal.foreground', terminal.foreground, true),
    ...colorProblem('terminal.cursor', terminal.cursor, false),
    ...colorProblem('terminal.selection', terminal.selection, false),
    ...ansiProblems(terminal.ansi),
  ];
}

function contrastProblem(
  subject: string,
  foreground: string,
  background: string,
  hint: string
): string[] {
  const ratio = contrastRatio(foreground, background);
  if (ratio >= MIN_TEXT_CONTRAST) return [];
  return [
    `${subject} has ${ratio.toFixed(1)}:1 contrast; it needs at least ${MIN_TEXT_CONTRAST}:1. ${hint}`,
  ];
}

function readabilityProblems(
  mode: ThemeMode,
  colors: Record<string, string | undefined>,
  terminal: { background: string; foreground: string }
): string[] {
  const text = oklchTripletToHex(MODE_TEXT[mode].foreground)!;
  const mutedText = oklchTripletToHex(MODE_TEXT[mode].mutedForeground)!;
  // Text colors are fixed per mode, so the surface is what has to move.
  const fix = mode === 'dark' ? 'darker' : 'lighter';
  const textSurfaces = (['background', 'card', 'popover', 'sidebar'] as const).filter(
    (key) => colors[key] !== undefined
  );
  const mutedTextSurfaces = (['card', 'sidebar'] as const).filter(
    (key) => colors[key] !== undefined
  );
  return [
    ...textSurfaces.flatMap((key) =>
      contrastProblem(`Text on surfaces.${key}`, text, colors[key]!, `Make surfaces.${key} ${fix}.`)
    ),
    ...mutedTextSurfaces.flatMap((key) =>
      contrastProblem(
        `Secondary text on surfaces.${key}`,
        mutedText,
        colors[key]!,
        `Make surfaces.${key} ${fix}.`
      )
    ),
    ...contrastProblem(
      'terminal.foreground on terminal.background',
      terminal.foreground,
      terminal.background,
      'Move the two colors further apart in lightness.'
    ),
  ];
}

/** What to fix before a customPalette can be used; empty when it is ready. */
export function customPaletteProblems(config: unknown): string[] {
  if (!isRecord(config)) return ['customPalette must be an object.'];
  const shape = shapeProblems(config);
  if (shape.length > 0) return shape;
  return readabilityProblems(
    config.mode as ThemeMode,
    config.surfaces as Record<string, string | undefined>,
    config.terminal as { background: string; foreground: string }
  );
}

/** What to fix before the appearance settings can be applied; empty when they are ready. */
export function appearanceProblems(settings: AppearanceSettings): string[] {
  const knownPalette =
    settings.palette === CUSTOM_PALETTE_ID ||
    BUILT_IN_THEMES.some((theme) => theme.id === settings.palette);
  return [
    ...(knownPalette
      ? []
      : [
          `palette "${settings.palette}" isn't a theme. Use "${CUSTOM_PALETTE_ID}" or a built-in id from themes.`,
        ]),
    ...(settings.palette === CUSTOM_PALETTE_ID && settings.customPalette === undefined
      ? [`palette "${CUSTOM_PALETTE_ID}" needs a customPalette.`]
      : []),
    ...(settings.customPalette === undefined ? [] : customPaletteProblems(settings.customPalette)),
    ...(OKLCH_COLOR.test(settings.accent) ? [] : ['accent must look like "oklch(0.65 0.15 250)".']),
    ...(Number.isFinite(settings.borderRadius) &&
    settings.borderRadius >= 0 &&
    settings.borderRadius <= MAX_BORDER_RADIUS
      ? []
      : [`borderRadius must be a number of pixels from 0 to ${MAX_BORDER_RADIUS}.`]),
  ];
}
