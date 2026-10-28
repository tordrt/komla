import type { TerminalConfig } from '../types/customization';

/**
 * Bundled terminal font — JetBrains Mono NL Nerd Font Mono (OFL license).
 * Loaded via @font-face in globals.css. Includes Nerd Font glyphs for icon support.
 */
export const BUNDLED_TERMINAL_FONT = 'JetBrainsMonoNL Nerd Font Mono';

/**
 * Default terminal font family stack.
 * Uses the bundled JetBrains Mono Nerd Font as primary, with system monospace fallbacks.
 * Users can override this in Settings > Appearance > Terminal > Font family.
 */
export const DEFAULT_TERMINAL_FONT_FAMILY = `"${BUNDLED_TERMINAL_FONT}", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`;

const TERMINAL_FONT_FALLBACKS = `"${BUNDLED_TERMINAL_FONT}", monospace`;

/**
 * Build a CSS font-family string from a user-chosen font name.
 * If empty, returns the full default stack. Otherwise prepends the
 * user's font before the bundled Nerd Font fallback.
 */
export function buildTerminalFontFamily(userFont: string): string {
  if (!userFont) return DEFAULT_TERMINAL_FONT_FAMILY;
  const quoted = userFont.includes(' ') ? `"${userFont}"` : userFont;
  return `${quoted}, ${TERMINAL_FONT_FALLBACKS}`;
}

/** terminal.json before any changes. */
export const DEFAULT_TERMINAL_CONFIG: TerminalConfig = {
  font: {
    family: '',
    size: 14,
    lineHeight: 1.2,
  },
  cursor: {
    style: 'block',
    blink: false,
  },
  scrollback: 5000,
  showPaneHeaders: false,
  showButtonsOnFocus: true,
  unfocusedPaneDimOpacity: 0.85,
  focusedPaneBorder: false,
  notificationPaneBorder: true,
  sendRightClickToPrograms: false,
  // Ghostty's default dark colors on Graphite's cool tint, between the window's chrome and its card,
  // with a lighter selection so it stands out on gray blocks.
  colors: {
    background: '#13171b',
    foreground: '#d4d4d8',
    cursor: '#ffffff',
    selection: '#5a7898',
    ansi: {
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
    },
  },
};
