// Palette presets for the runtime theme selector.
// Tokens are partial maps (CSS var name -> OKLCH "L C H" string).
// Only neutral surface tokens are included - each theme's accent lives in
// BUILT_IN_THEMES and is saved to theme.json when the theme is chosen.
// Terminals are dark in every theme. Komla Dark uses the Terminal settings' colors, Komla Light and
// Komla Slate Light a softer dark that sits easier beside their light surfaces, every other dark
// theme its own colors, and every other light theme its dark sibling's.

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
  /** A light theme's dark sibling, whose terminal colors and surfaces its terminal panes use. */
  darkTerminal?: string;
  /** The dark surfaces for terminal panes in a light theme with its own dark terminal. */
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

// Komla Light's surfaces as lightness steps from its card, which is also its editor's color.
const LIGHT_STEPS: Partial<Record<keyof PaletteTokens, number>> = {
  '--popover': 0.025,
  '--background': 0.015,
  '--sidebar': -0.015,
  '--muted': -0.015,
  '--secondary': -0.015,
  '--sidebar-muted': -0.03,
  '--chrome': -0.039,
  '--accent': -0.045,
  '--sidebar-accent': -0.05,
  '--border': -0.06,
  '--input': -0.06,
  '--card': 0,
};

function steppedSurfaces(
  anchor: string,
  steps: Partial<Record<keyof PaletteTokens, number>>
): PaletteTokens {
  const [lightness, chroma, hue] = oklch(anchor).split(' ').map(Number);
  const round = (value: number) => Number(value.toFixed(3));
  const tokens: PaletteTokens = {};
  for (const [token, step] of Object.entries(steps)) {
    const stepped = Math.min(1, lightness + step);
    // Above a light anchor the tint fades out toward white, where no chroma fits.
    const tint = stepped > lightness ? chroma * ((1 - stepped) / (1 - lightness)) : chroma;
    tokens[token as keyof PaletteTokens] = `${round(stepped)} ${round(tint)} ${round(hue)}`;
  }
  return tokens;
}

/** A dark theme's surfaces around its terminal background, layered as Komla Dark's are. */
export function darkSurfaces(terminal: string): PaletteTokens {
  return steppedSurfaces(terminal, DARK_STEPS);
}

/** A light theme's surfaces around its card (its editor background), layered as Komla Light's are. */
export function lightSurfaces(card: string): PaletteTokens {
  return steppedSurfaces(card, LIGHT_STEPS);
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
    // Komla Dark before Graphite: every surface carries the same slight blue tint.
    id: 'slate',
    label: 'Komla Slate',
    mode: 'dark',
    tokens: {
      '--background': '0.175 0.02 258',
      '--card': '0.235 0.02 258',
      '--popover': '0.235 0.02 258',
      '--muted': '0.29 0.02 258',
      '--secondary': '0.29 0.02 258',
      '--accent': '0.32 0.02 258',
      '--border': '0.29 0.02 258',
      '--input': '0.35 0.02 258',
      '--sidebar': '0.285 0.02 258',
      '--sidebar-accent': '0.329 0.02 258',
      '--sidebar-muted': '0.305 0.02 258',
      '--sidebar-border': '0.245 0.02 258',
      '--chrome': '0.285 0.02 258',
    },
    xterm: { background: '#10161f', foreground: '#ffffff' },
    monaco: { editorBackground: '#10161f' },
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
    id: 'github-dark',
    label: 'GitHub Dark',
    mode: 'dark',
    tokens: darkSurfaces('#0d1117'),
    xterm: {
      background: '#0d1117',
      foreground: '#e6edf3',
      cursor: '#2f81f7',
      selection: '#264f78',
      ansi: ansi(
        ['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4'],
        ['#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff']
      ),
    },
    monaco: { editorBackground: '#0d1117' },
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    mode: 'dark',
    tokens: darkSurfaces('#282828'),
    xterm: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      selection: '#504945',
      ansi: ansi(
        ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984'],
        ['#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']
      ),
    },
    monaco: { editorBackground: '#282828' },
  },
  {
    id: 'kanagawa',
    label: 'Kanagawa',
    mode: 'dark',
    tokens: darkSurfaces('#1f1f28'),
    // Kanagawa Wave.
    xterm: {
      background: '#1f1f28',
      foreground: '#dcd7ba',
      cursor: '#c8c093',
      selection: '#2d4f67',
      ansi: ansi(
        ['#16161d', '#c34043', '#76946a', '#c0a36e', '#7e9cd8', '#957fb8', '#6a9589', '#c8c093'],
        ['#727169', '#e82424', '#98bb6c', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#dcd7ba']
      ),
    },
    monaco: { editorBackground: '#1f1f28' },
  },
  {
    id: 'monokai',
    label: 'Monokai',
    mode: 'dark',
    tokens: darkSurfaces('#272822'),
    // base16 Monokai.
    xterm: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      selection: '#49483e',
      ansi: ansi(
        ['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2'],
        ['#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5']
      ),
    },
    monaco: { editorBackground: '#272822' },
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
    id: 'one-dark',
    label: 'One Dark',
    mode: 'dark',
    tokens: darkSurfaces('#282c34'),
    // Atom's One Dark.
    xterm: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      selection: '#3e4451',
      ansi: ansi(
        ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf'],
        ['#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']
      ),
    },
    monaco: { editorBackground: '#282c34' },
  },
  {
    id: 'rose-pine',
    label: 'Rosé Pine',
    mode: 'dark',
    tokens: darkSurfaces('#191724'),
    xterm: {
      background: '#191724',
      foreground: '#e0def4',
      cursor: '#524f67',
      selection: '#403d52',
      ansi: ansi(
        ['#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4'],
        ['#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4']
      ),
    },
    monaco: { editorBackground: '#191724' },
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    mode: 'dark',
    tokens: darkSurfaces('#002b36'),
    xterm: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      selection: '#274642',
      // Solarized's canonical bright slots hold its gray base tones, which turns bright
      // colors gray in most CLIs; use the accent hues there instead.
      ansi: ansi(
        ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
        ['#586e75', '#cb4b16', '#859900', '#b58900', '#268bd2', '#6c71c4', '#2aa198', '#fdf6e3']
      ),
    },
    monaco: { editorBackground: '#002b36' },
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
  {
    // Komla Light before Graphite.
    id: 'slate-light',
    label: 'Komla Slate Light',
    mode: 'light',
    // Komla Slate's hue, faint enough to read as white.
    tokens: {
      '--background': '0.99 0.003 258',
      '--card': '0.975 0.006 258',
      '--popover': '1 0 0',
      '--muted': '0.96 0.008 258',
      '--secondary': '0.96 0.008 258',
      '--accent': '0.93 0.012 258',
      '--border': '0.915 0.013 258',
      '--input': '0.915 0.013 258',
      '--sidebar': '0.96 0.008 258',
      '--sidebar-accent': '0.925 0.013 258',
      '--sidebar-muted': '0.945 0.01 258',
      '--chrome': '0.936 0.008 258',
    },
    // Komla Slate's terminal lifted to a soft slate, with the Terminal settings' ANSI colors, and
    // pane surfaces a step lighter than it, as Komla Dark's chrome sits beside its terminal.
    xterm: { background: '#252c35', foreground: '#e4e8ef' },
    terminalTokens: {
      '--background': '0.27 0.02 258',
      '--card': '0.33 0.02 258',
      '--popover': '0.33 0.02 258',
      '--muted': '0.37 0.02 258',
      '--secondary': '0.37 0.02 258',
      '--accent': '0.4 0.02 258',
      '--border': '0.37 0.02 258',
      '--input': '0.42 0.02 258',
    },
    monaco: { editorBackground: '#ffffff' },
  },
  {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    mode: 'light',
    tokens: lightSurfaces('#eff1f5'),
    darkTerminal: 'catppuccin-mocha',
    monaco: { editorBackground: '#eff1f5' },
  },
  {
    id: 'github-light',
    label: 'GitHub Light',
    mode: 'light',
    tokens: lightSurfaces('#ffffff'),
    darkTerminal: 'github-dark',
    monaco: { editorBackground: '#ffffff' },
  },
  {
    id: 'one-light',
    label: 'One Light',
    mode: 'light',
    tokens: lightSurfaces('#fafafa'),
    darkTerminal: 'one-dark',
    monaco: { editorBackground: '#fafafa' },
  },
  {
    id: 'rose-pine-dawn',
    label: 'Rosé Pine Dawn',
    mode: 'light',
    tokens: lightSurfaces('#faf4ed'),
    darkTerminal: 'rose-pine',
    monaco: { editorBackground: '#faf4ed' },
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    mode: 'light',
    tokens: lightSurfaces('#fdf6e3'),
    darkTerminal: 'solarized-dark',
    monaco: { editorBackground: '#fdf6e3' },
  },
];

export function getPalette(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

/** The terminal colors a palette brings; undefined when the terminal uses the Terminal settings. */
export function paletteXterm(palette: Palette): Palette['xterm'] {
  return palette.darkTerminal === undefined
    ? palette.xterm
    : getPalette(palette.darkTerminal).xterm;
}

/** The dark surfaces a light theme gives its terminal panes: its own, or its dark sibling's. */
export function paletteTerminalTokens(palette: Palette): PaletteTokens {
  return palette.darkTerminal === undefined
    ? (palette.terminalTokens ?? {})
    : getPalette(palette.darkTerminal).tokens;
}
