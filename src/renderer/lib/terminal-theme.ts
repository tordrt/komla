import type { TerminalConfig } from '@/types';
import type { ITheme } from '@xterm/xterm';

function getActiveColors(config: TerminalConfig): TerminalConfig['colors'] {
  return config.colors;
}

// Convert TerminalConfig to xterm ITheme (mode-aware)
export function configToTheme(config: TerminalConfig): ITheme {
  const colors = getActiveColors(config);
  return {
    background: colors.background,
    foreground: colors.foreground,
    cursor: colors.cursor,
    cursorAccent: colors.background,
    selectionBackground: colors.selection,
    selectionForeground: colors.foreground,
    black: colors.ansi.black,
    red: colors.ansi.red,
    green: colors.ansi.green,
    yellow: colors.ansi.yellow,
    blue: colors.ansi.blue,
    magenta: colors.ansi.magenta,
    cyan: colors.ansi.cyan,
    white: colors.ansi.white,
    brightBlack: colors.ansi.brightBlack,
    brightRed: colors.ansi.brightRed,
    brightGreen: colors.ansi.brightGreen,
    brightYellow: colors.ansi.brightYellow,
    brightBlue: colors.ansi.brightBlue,
    brightMagenta: colors.ansi.brightMagenta,
    brightCyan: colors.ansi.brightCyan,
    brightWhite: colors.ansi.brightWhite,
  };
}

// Default terminal theme (fallback when customization not loaded)
// Aligned with DEFAULT_TERMINAL_CONFIG in shared/constants/terminal.ts
export const DEFAULT_TERMINAL_THEME: ITheme = {
  background: '#13171b',
  foreground: '#d4d4d8',
  cursor: '#ffffff',
  cursorAccent: '#13171b',
  selectionBackground: '#5a7898',
  selectionForeground: '#d4d4d8',
  black: '#1d1f21',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#666666',
  brightRed: '#d54e53',
  brightGreen: '#b9ca4a',
  brightYellow: '#e7c547',
  brightBlue: '#7aa6da',
  brightMagenta: '#c397d8',
  brightCyan: '#70c0b1',
  brightWhite: '#eaeaea',
};
