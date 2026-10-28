import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PALETTE_ID,
  MODE_SURFACES,
  PALETTES,
  darkSurfaces,
  getPalette,
  lightSurfaces,
  paletteSurface,
  paletteXterm,
  type PreviewToken,
} from '../../../src/renderer/lib/palette-presets';
import { oklchTripletToHex } from '../../../src/renderer/lib/palette-runtime';
import { hexToOklchValues } from '../../../src/renderer/lib/project-colors';
import { primaryForMode } from '../../../src/renderer/lib/primary-color';
import { DEFAULT_TERMINAL_CONFIG } from '../../../src/shared/constants/terminal';
import { BUILT_IN_THEMES, isDarkColor } from '../../../src/shared/lib/appearance';

function luminance(color: string): number {
  const hex = color.startsWith('#') ? color : oklchTripletToHex(color)!;
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Values globals.css supplies for tokens a palette leaves out.
const MODE_DEFAULTS = {
  dark: {
    foreground: '0.985 0 0',
    mutedForeground: '0.75 0 0',
    background: '0.14 0.01 250',
    card: '0.284 0.01 250',
    accent: '0.37 0.01 250',
  },
  light: {
    foreground: '0.145 0 0',
    mutedForeground: '0.5 0 0',
    background: '1 0 0',
    card: '0.985 0 0',
    accent: '0.94 0 0',
  },
};

describe('PALETTES', () => {
  it('matches the built-in themes the main process accepts', () => {
    expect(PALETTES.map(({ id, label, mode }) => ({ id, name: label, mode }))).toEqual(
      BUILT_IN_THEMES.map(({ id, name, mode }) => ({ id, name, mode }))
    );
  });

  it('gives every theme an accent that fits its mode', () => {
    for (const { id, mode, accent } of BUILT_IN_THEMES) {
      const triplet = accent.match(/^oklch\((.+)\)$/)?.[1];
      expect(triplet, id).toBeDefined();
      expect(primaryForMode(triplet!, mode), id).toBe(triplet);
    }
  });

  it('has unique ids', () => {
    const ids = PALETTES.map((palette) => palette.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives named themes every surface token', () => {
    const surfaceTokens = [
      '--background',
      '--card',
      '--popover',
      '--muted',
      '--secondary',
      '--accent',
      '--border',
      '--input',
    ] as const;
    for (const palette of PALETTES.filter((p) => p.id !== DEFAULT_PALETTE_ID)) {
      for (const token of surfaceTokens) {
        expect(palette.tokens[token], `${palette.id} ${token}`).toBeDefined();
      }
    }
  });

  it('keeps interface text readable on every palette', () => {
    for (const palette of PALETTES) {
      const defaults = MODE_DEFAULTS[palette.mode];
      const card = palette.tokens['--card'] ?? defaults.card;
      const background = palette.tokens['--background'] ?? defaults.background;
      expect(contrast(defaults.foreground, card), `${palette.id} text`).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(defaults.foreground, background),
        `${palette.id} text on background`
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(defaults.mutedForeground, card),
        `${palette.id} muted text`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  // A hovered menu row's shortcut and hint text.
  it("keeps muted text readable on Komla Dark's and Komla Light's hover fill", () => {
    for (const [mode, defaults] of Object.entries(MODE_DEFAULTS)) {
      expect(contrast(defaults.mutedForeground, defaults.accent), mode).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('sets every sidebar a step off its card, with readable text', () => {
    const lightness = (color: string) =>
      Number((color.startsWith('#') ? hexToOklchValues(color)! : color).split(' ')[0]);
    for (const palette of PALETTES) {
      const defaults = MODE_DEFAULTS[palette.mode];
      const chrome = palette.tokens['--chrome'] ?? MODE_SURFACES[palette.mode]['--chrome'];
      const card = palette.tokens['--card'] ?? defaults.card;
      expect(
        Math.abs(lightness(chrome) - lightness(card)),
        `${palette.id} step`
      ).toBeGreaterThanOrEqual(0.015);
      expect(contrast(defaults.foreground, chrome), `${palette.id} text`).toBeGreaterThanOrEqual(
        4.5
      );
      expect(
        contrast(defaults.mutedForeground, chrome),
        `${palette.id} muted text`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("steps surfaces as Komla Dark's, spread out, and Komla Light's own", () => {
    const lightness = (triplet: string) => Number(triplet.split(' ')[0]);
    const css = readFileSync(join(__dirname, '../../../src/renderer/styles/globals.css'), 'utf8');
    const dark = css.slice(css.indexOf('.dark {')).split('}')[0];
    const stepped = darkSurfaces('#161618');
    const background = lightness(stepped['--background']!);
    // Menus and hover fills sit lower, so accent and muted text stay readable on them.
    const lowered = ['--popover', '--accent'];
    for (const [token, value] of Object.entries(stepped)) {
      const komla = Number(dark.match(new RegExp(`\\s${token}: ([\\d.]+) `))![1]);
      const spread = background + (lightness(value) - background) * 1.5;
      if (lowered.includes(token)) expect(komla, token).toBeLessThan(spread);
      else expect(spread, token).toBeCloseTo(komla, 2);
    }
    const frost = getPalette('frost');
    for (const [token, value] of Object.entries(lightSurfaces(frost.monaco.editorBackground))) {
      expect(lightness(value), token).toBeCloseTo(lightness(frost.tokens[token as '--card']!), 2);
    }
  });

  // Komla Slate and Komla Slate Light keep the looks from before Graphite.
  it('layers every theme as Komla Dark and Komla Light do', () => {
    const lightness = (color: string) =>
      Number((color.startsWith('#') ? hexToOklchValues(color)! : color).split(' ')[0]);
    for (const palette of PALETTES.filter((p) => !p.id.startsWith('slate'))) {
      const surface = (token: PreviewToken) => lightness(paletteSurface(palette, token));
      expect(surface('--chrome'), palette.id).toBeLessThan(surface('--card'));
      if (palette.mode === 'dark') {
        const terminal = lightness(
          paletteXterm(palette)?.background ?? DEFAULT_TERMINAL_CONFIG.colors.background
        );
        expect(surface('--chrome'), palette.id).toBeLessThan(terminal);
        expect(terminal, palette.id).toBeLessThan(surface('--card'));
      }
    }
  });

  it('keeps terminal text readable on every palette', () => {
    for (const palette of PALETTES) {
      const xterm = paletteXterm(palette);
      if (!xterm) continue;
      expect(contrast(xterm.foreground, xterm.background), palette.id).toBeGreaterThanOrEqual(4.5);
    }
  });

  // A dark theme's active tab takes the terminal's color and opens into it, so the tab bar
  // (--card) around it needs a different color or the tab has no edges.
  it('sets the tab bar apart from the terminal in dark themes', () => {
    const lightness = (triplet: string) => Number(triplet.split(' ')[0]);
    for (const palette of PALETTES.filter((p) => p.mode === 'dark')) {
      const terminal =
        paletteXterm(palette)?.background ?? DEFAULT_TERMINAL_CONFIG.colors.background;
      const difference = Math.abs(
        lightness(paletteSurface(palette, '--card')) - lightness(hexToOklchValues(terminal)!)
      );
      expect(difference, palette.id).toBeGreaterThanOrEqual(0.02);
    }
  });

  it('keeps terminals dark in light themes, mostly with a dark theme from the same list', () => {
    for (const palette of PALETTES.filter((p) => p.mode === 'light')) {
      if (palette.id !== 'frost' && palette.id !== 'slate-light') {
        const sibling = PALETTES.find((p) => p.id === palette.darkTerminal);
        expect(sibling?.mode, palette.id).toBe('dark');
        expect(palette.xterm, palette.id).toBeUndefined();
      }
      const background = paletteXterm(palette)?.background;
      expect(background && isDarkColor(background), palette.id).toBe(true);
    }
  });

  it('leaves Komla Dark on the Terminal settings colors, and Komla Light on their ANSI colors', () => {
    expect(paletteXterm(getPalette(DEFAULT_PALETTE_ID))).toBeUndefined();
    expect(paletteXterm(getPalette('frost'))?.ansi).toBeUndefined();
  });

  it("softens Komla Light's terminal against Komla Dark's", () => {
    const background = paletteXterm(getPalette('frost'))!.background;

    expect(contrast(background, '#ffffff')).toBeLessThan(
      contrast(DEFAULT_TERMINAL_CONFIG.colors.background, '#ffffff')
    );
  });

  it.each([
    ['frost', 286],
    ['slate-light', 258],
  ])("tints %s's surfaces with its dark sibling's hue", (id, hue) => {
    const tinted = Object.values(getPalette(id).tokens).filter((value) => value !== '1 0 0');

    expect(tinted.length).toBeGreaterThan(0);
    for (const value of tinted) expect(value).toMatch(new RegExp(` ${hue}$`));
  });

  it('previews Komla Dark with the surface colors globals.css gives it', () => {
    const css = readFileSync(join(__dirname, '../../../src/renderer/styles/globals.css'), 'utf8');
    const block = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split('}')[0];
    const blocks = { dark: block('.dark'), light: block(':root') };
    for (const [mode, tokens] of Object.entries(MODE_SURFACES)) {
      for (const [token, value] of Object.entries(tokens)) {
        expect(blocks[mode as keyof typeof blocks], `${mode} ${token}`).toContain(
          `${token}: ${value};`
        );
      }
    }
  });
});
