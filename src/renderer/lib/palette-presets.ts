// Palette presets for the runtime theme selector.
// Tokens are partial maps (CSS var name -> OKLCH "L C H" string).
// Only neutral surface tokens are included - each theme's accent lives in
// BUILT_IN_THEMES and is saved to theme.json when the theme is chosen.
// Terminals are dark in every theme. Komla Dark uses the Terminal settings' colors, Komla Light a
// softer dark that sits easier beside its light surfaces, and every other theme its own colors.

import { hexToOklchValues } from './project-colors';

export { CUSTOM_PALETTE_ID, DEFAULT_PALETTE_ID } from '../../shared/lib/appearance';

import type { TerminalColorConfig } from '@/types';

export type PaletteMode = 'dark' | 'light';

export type PaletteTokens = Partial<{
  '--background': string;
  '--card': string;
  '--popover': string;
  '--muted': string;
  '--secondary': string;
  '--accent': string;
  '--border': string;
  '--input': string;
  '--sidebar': string;
  '--sidebar-accent': string;
  '--sidebar-muted': string;
  '--sidebar-border': string;
  /** The workspace sidebar and the window around the work area card. */
  '--chrome': string;
}>;

export interface Palette {
  id: string;
  label: string;
  mode: PaletteMode;
  tokens: PaletteTokens;
  /** The terminal's colors. Left out, the terminal uses the Terminal settings. */
  xterm?: {
    background: string;
    foreground: string;
    cursor?: string;
    selection?: string;
    ansi?: Partial<TerminalColorConfig['ansi']>;
  };
  /** The dark surfaces for terminal panes in a light theme. */
  terminalTokens?: PaletteTokens;
  monaco: {
    editorBackground: string;
  };
}

// A theme without its own sidebar colors keeps the sidebar on its card, accent and muted.
export const TOKEN_FALLBACKS: Partial<Record<keyof PaletteTokens, keyof PaletteTokens>> = {
  '--sidebar': '--card',
  '--sidebar-accent': '--accent',
  '--sidebar-muted': '--muted',
  '--sidebar-border': '--border',
};

/** The surface tokens a theme preview draws. */
export type PreviewToken = '--card' | '--chrome' | '--sidebar-accent' | '--border';

// globals.css's values for the tokens a palette can leave out, which Komla Dark does.
export const MODE_SURFACES: Record<PaletteMode, Record<PreviewToken, string>> = {
  dark: {
    '--card': '0.284 0.01 250',
    '--chrome': '0.155 0.01 250',
    '--sidebar-accent': '0.278 0.01 250',
    '--border': '0.381 0.01 250',
  },
  light: {
    '--card': '0.985 0 0',
    '--chrome': '0.955 0 0',
    '--sidebar-accent': '0.937 0 0',
    '--border': '0.922 0 0',
  },
};

/** The "L C H" a palette gives a surface token, as the window would show it. */
export function paletteSurface(palette: Palette, token: PreviewToken): string {
  const fallback = TOKEN_FALLBACKS[token];
  return (
    palette.tokens[token] ??
    (fallback && palette.tokens[fallback]) ??
    MODE_SURFACES[palette.mode][token]
  );
}

function oklch(hex: string): string {
  const values = hexToOklchValues(hex);
  if (!values) throw new Error(`Invalid palette color: ${hex}`);
  return values;
}

// Custom themes give hex colors; map seven of them onto every surface token. The sidebar is a
// step off the card, so the work area card stands out against it.
export function surfaces(colors: {
  background: string;
  card: string;
  popover?: string;
  muted: string;
  accent: string;
  border: string;
  sidebar: string;
}): PaletteTokens {
  return {
    '--background': oklch(colors.background),
    '--card': oklch(colors.card),
    '--popover': oklch(colors.popover ?? colors.card),
    '--muted': oklch(colors.muted),
    '--secondary': oklch(colors.muted),
    '--accent': oklch(colors.accent),
    '--border': oklch(colors.border),
    '--input': oklch(colors.border),
    '--chrome': oklch(colors.sidebar),
  };
}

// The dark themes' surfaces as lightness steps from their terminal: the chrome a step under the
// terminal, project panels on it, and the work area card, menus and fills a step and more above it.
// Komla Dark (globals.css's .dark) spreads these 1.5 times as far from its window background.
const DARK_STEPS: Record<keyof PaletteTokens, number> = {
  '--sidebar-border': -0.085,
  '--background': -0.061,
  '--chrome': -0.051,
  '--sidebar': -0.023,
  '--sidebar-muted': 0,
  '--sidebar-accent': 0.031,
  '--card': 0.035,
  '--popover': 0.053,
  '--muted': 0.084,
  '--secondary': 0.084,
  '--border': 0.1,
  '--accent': 0.105,
  '--input': 0.146,
};

/** A dark theme's surfaces around its terminal background, layered as Komla Dark's are. */
export function darkSurfaces(terminal: string): PaletteTokens {
  const [lightness, chroma, hue] = oklch(terminal).split(' ').map(Number);
  const round = (value: number) => Number(value.toFixed(3));
  const tokens: PaletteTokens = {};
  for (const [token, step] of Object.entries(DARK_STEPS)) {
    const stepped = Math.min(1, lightness + step);
    // Above the anchor the tint fades out toward white, where no chroma fits.
    const tint = stepped > lightness ? chroma * ((1 - stepped) / (1 - lightness)) : chroma;
    tokens[token as keyof PaletteTokens] = `${round(stepped)} ${round(tint)} ${round(hue)}`;
  }
  return tokens;
}

type AnsiRow = [string, string, string, string, string, string, string, string];

// Rows in ANSI order: black, red, green, yellow, blue, magenta, cyan, white.
function ansi(normal: AnsiRow, bright: AnsiRow): TerminalColorConfig['ansi'] {
  const [black, red, green, yellow, blue, magenta, cyan, white] = normal;
  const [
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  ] = bright;
  return {
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  };
}

export const PALETTES: Palette[] = [
  {
    id: 'default',
    label: 'Komla Dark',
    mode: 'dark',
    tokens: {},
    monaco: { editorBackground: '#13171b' },
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    mode: 'dark',
    tokens: darkSurfaces('#1e1e2e'),
    xterm: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selection: '#585b70',
      ansi: ansi(
        ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de'],
        ['#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8']
      ),
    },
    monaco: { editorBackground: '#1e1e2e' },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    mode: 'dark',
    tokens: darkSurfaces('#282a36'),
    xterm: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      selection: '#44475a',
      ansi: ansi(
        ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2'],
        ['#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']
      ),
    },
    monaco: { editorBackground: '#282a36' },
  },
  {
    id: 'nord',
    label: 'Nord',
    mode: 'dark',
    tokens: darkSurfaces('#2e3440'),
    xterm: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      selection: '#434c5e',
      ansi: ansi(
        ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0'],
        ['#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']
      ),
    },
    monaco: { editorBackground: '#2e3440' },
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    mode: 'dark',
    tokens: darkSurfaces('#1a1b26'),
    xterm: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      selection: '#283457',
      ansi: ansi(
        ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6'],
        ['#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']
      ),
    },
    monaco: { editorBackground: '#1a1b26' },
  },
  {
    id: 'frost',
    label: 'Komla Light',
    mode: 'light',
    // Komla Dark's graphite: zinc with a faint cool cast, light enough to read as white.
    tokens: {
      '--background': '0.99 0.001 286',
      '--card': '0.975 0.002 286',
      '--popover': '1 0 0',
      '--muted': '0.96 0.003 286',
      '--secondary': '0.96 0.003 286',
      '--accent': '0.93 0.004 286',
      '--border': '0.915 0.004 286',
      '--input': '0.915 0.004 286',
      '--sidebar': '0.96 0.003 286',
      '--sidebar-accent': '0.925 0.005 286',
      '--sidebar-muted': '0.945 0.004 286',
      '--chrome': '0.936 0.003 286',
    },
    // Ghostty's default terminal (src/config/Config.zig), with the Terminal settings' ANSI colors,
    // and pane surfaces a step lighter than it, as Komla Dark's card sits beside its terminal.
    xterm: { background: '#282c34', foreground: '#ffffff' },
    terminalTokens: {
      '--background': '0.289 0.021 264',
      '--card': '0.35 0.021 264',
      '--popover': '0.35 0.021 264',
      '--muted': '0.39 0.021 264',
      '--secondary': '0.39 0.021 264',
      '--accent': '0.42 0.021 264',
      '--border': '0.39 0.021 264',
      '--input': '0.44 0.021 264',
    },
    monaco: { editorBackground: '#f6f6f8' },
  },
];

export function getPalette(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}
