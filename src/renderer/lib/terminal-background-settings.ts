import { CUSTOM_PALETTE_ID, getPalette } from './palette-presets';

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isValidTerminalBackgroundColor(color: string): boolean {
  return HEX_COLOR_PATTERN.test(color);
}

/** Whether the theme brings its own terminal colors; a custom theme always does. */
export function paletteOverridesTerminalBackground(activePaletteId: string): boolean {
  return activePaletteId === CUSTOM_PALETTE_ID || getPalette(activePaletteId).xterm !== undefined;
}
