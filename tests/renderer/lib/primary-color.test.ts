/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';

import { ACCENT_COLORS } from '../../../src/renderer/components/ui/color-picker';
import { oklchTripletToHex } from '../../../src/renderer/lib/palette-runtime';
import {
  applyAccent,
  primaryForMode,
  readStoredAccent,
} from '../../../src/renderer/lib/primary-color';
import { PROJECT_COLORS, hslToOklchValues } from '../../../src/renderer/lib/project-colors';

function luminance(triplet: string): number {
  const hex = oklchTripletToHex(triplet)!;
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

// Default palette values from globals.css.
const DARK = { card: '0.284 0.01 250', popover: '0.3 0.01 250', primaryForeground: '0.205 0 0' };
const LIGHT = { background: '1 0 0', primaryForeground: '0.985 0 0' };

describe('primaryForMode', () => {
  it('lightens a dark accent in dark mode, keeping its hue and chroma', () => {
    expect(primaryForMode('0.55 0.18 230', 'dark')).toBe('0.7 0.18 230');
  });

  it('keeps an accent that is already light enough for dark mode', () => {
    expect(primaryForMode('0.7 0.15 250', 'dark')).toBe('0.7 0.15 250');
  });

  it('darkens a light accent in light mode, keeping its hue and chroma', () => {
    expect(primaryForMode('0.65 0.15 250', 'light')).toBe('0.5 0.15 250');
  });

  it('keeps an accent that is already dark enough for light mode', () => {
    expect(primaryForMode('0.45 0.2 25', 'light')).toBe('0.45 0.2 25');
  });

  it('draws a neutral accent as near-white ink on dark and near-black ink on light', () => {
    expect(primaryForMode('0.922 0 0', 'dark')).toBe('0.922 0 0');
    expect(primaryForMode('0.922 0 0', 'light')).toBe('0.205 0 0');
  });

  it('passes through values that are not an OKLCH triplet', () => {
    expect(primaryForMode('#ff0000', 'light')).toBe('#ff0000');
    expect(primaryForMode('oklch(65% 0.15 250)', 'dark')).toBe('oklch(65% 0.15 250)');
  });

  it('keeps every accent swatch and project color readable as text and as a button fill', () => {
    const sources = [
      ...ACCENT_COLORS.map((color) => color.replace(/^oklch\(|\)$/g, '')),
      ...PROJECT_COLORS.map((color) => hslToOklchValues(color)!),
    ];
    for (const source of sources) {
      const dark = primaryForMode(source, 'dark');
      const light = primaryForMode(source, 'light');
      expect(contrast(dark, DARK.card), `${source} dark text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(dark, DARK.popover), `${source} dark text in menus`).toBeGreaterThanOrEqual(
        4.5
      );
      expect(contrast(dark, DARK.primaryForeground), `${source} dark fill`).toBeGreaterThanOrEqual(
        4.5
      );
      expect(contrast(light, LIGHT.background), `${source} light text`).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(light, LIGHT.primaryForeground),
        `${source} light fill`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('applyAccent', () => {
  it('fits the accent to the mode and remembers it for the next launch', () => {
    localStorage.clear();
    expect(readStoredAccent()).toBeNull();

    applyAccent('oklch(0.65 0.15 250)', 'light');

    const { style } = document.documentElement;
    expect(style.getPropertyValue('--primary')).toBe('0.5 0.15 250');
    expect(style.getPropertyValue('--ring')).toBe('0.5 0.15 250');
    expect(readStoredAccent()).toBe('oklch(0.65 0.15 250)');
  });

  it('keeps the dark form for the dark terminal panes of a light theme', () => {
    applyAccent('oklch(0.5 0.19 257)', 'light');

    expect(document.documentElement.style.getPropertyValue('--dark-primary')).toBe('0.7 0.19 257');
  });

  it('colors the Komla logo in a hued accent', () => {
    applyAccent('oklch(0.73 0.18 52)', 'dark');

    expect(document.documentElement.style.getPropertyValue('--komla')).toBe('0.73 0.18 52');
  });

  it('keeps the Komla logo Komla blue under a gray accent', () => {
    applyAccent('oklch(0.922 0 0)', 'dark');

    expect(document.documentElement.style.getPropertyValue('--komla')).toBe('var(--brand)');
  });

  it('keeps the Komla logo Komla blue under an accent that is not oklch()', () => {
    applyAccent('#ff8800', 'dark');

    expect(document.documentElement.style.getPropertyValue('--komla')).toBe('var(--brand)');
  });
});
