import { describe, it, expect } from 'vitest';

import { oklchTripletToHex } from '../../../src/renderer/lib/palette-runtime';
import {
  PROJECT_COLORS,
  getProjectColor,
  withAlpha,
  hexToOklchValues,
  hslToOklchValues,
  colorToOklchValues,
  getNextAvailableColor,
} from '../../../src/renderer/lib/project-colors';

describe('getProjectColor', () => {
  it('returns a color from the palette', () => {
    const color = getProjectColor('my-project');
    expect(PROJECT_COLORS).toContain(color);
  });

  it('returns the same color for the same name', () => {
    expect(getProjectColor('foo')).toBe(getProjectColor('foo'));
  });

  it('handles empty string', () => {
    const color = getProjectColor('');
    expect(PROJECT_COLORS).toContain(color);
  });

  it('handles special characters', () => {
    const color = getProjectColor('my/project@2.0');
    expect(PROJECT_COLORS).toContain(color);
  });

  it('different names can produce different colors', () => {
    const colors = new Set(
      ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'].map(getProjectColor)
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe('withAlpha', () => {
  it('converts hsl to hsla with alpha', () => {
    expect(withAlpha('hsl(340, 70%, 55%)', 0.5)).toBe('hsla(340, 70%, 55%, 0.5)');
  });

  it('converts rgb to rgba with alpha', () => {
    expect(withAlpha('rgb(255, 0, 128)', 0.8)).toBe('rgba(255, 0, 128, 0.8)');
  });

  it('returns hex colors unchanged', () => {
    expect(withAlpha('#ff0000', 0.5)).toBe('#ff0000');
  });

  it('returns unknown formats unchanged', () => {
    expect(withAlpha('red', 0.5)).toBe('red');
  });

  it('handles alpha of 0', () => {
    expect(withAlpha('hsl(0, 0%, 0%)', 0)).toBe('hsla(0, 0%, 0%, 0)');
  });

  it('handles alpha of 1', () => {
    expect(withAlpha('rgb(0, 0, 0)', 1)).toBe('rgba(0, 0, 0, 1)');
  });
});

describe('hslToOklchValues', () => {
  it('returns null for invalid input', () => {
    expect(hslToOklchValues('rgb(255, 0, 0)')).toBeNull();
    expect(hslToOklchValues('not a color')).toBeNull();
    expect(hslToOklchValues('')).toBeNull();
  });

  it('converts a valid HSL color to OKLCH values string', () => {
    const result = hslToOklchValues('hsl(0, 100%, 50%)');
    expect(result).not.toBeNull();
    const parts = result!.split(' ');
    expect(parts).toHaveLength(3);
    // All parts should be valid numbers
    parts.forEach((p) => expect(Number.isNaN(parseFloat(p))).toBe(false));
  });

  it('converts pure red correctly', () => {
    const result = hslToOklchValues('hsl(0, 100%, 50%)')!;
    const [L, C, H] = result.split(' ').map(parseFloat);
    // Red in OKLCH: L ~0.6279, C ~0.2577, H ~29.23
    expect(L).toBeCloseTo(0.6279, 2);
    expect(C).toBeGreaterThan(0.2);
    expect(H).toBeGreaterThan(0);
  });

  it('converts black (0% lightness)', () => {
    const result = hslToOklchValues('hsl(0, 0%, 0%)')!;
    const [L, C] = result.split(' ').map(parseFloat);
    expect(L).toBeCloseTo(0, 2);
    expect(C).toBeCloseTo(0, 2);
  });

  it('converts white (100% lightness)', () => {
    const result = hslToOklchValues('hsl(0, 0%, 100%)')!;
    const [L, C] = result.split(' ').map(parseFloat);
    expect(L).toBeCloseTo(1, 2);
    expect(C).toBeCloseTo(0, 2);
  });

  it('converts all PROJECT_COLORS without error', () => {
    for (const color of PROJECT_COLORS) {
      const result = hslToOklchValues(color);
      expect(result).not.toBeNull();
    }
  });
});

describe('hexToOklchValues', () => {
  it('returns null for invalid input', () => {
    expect(hexToOklchValues('#fff')).toBeNull();
    expect(hexToOklchValues('ff0000')).toBeNull();
    expect(hexToOklchValues('#gg0000')).toBeNull();
  });

  it('matches the HSL conversion of the same color', () => {
    expect(hexToOklchValues('#ff0000')).toBe(hslToOklchValues('hsl(0, 100%, 50%)'));
  });

  it('round-trips back to the same hex', () => {
    for (const hex of ['#282a36', '#eff1f5', '#002b36', '#ffffff', '#000000']) {
      expect(oklchTripletToHex(hexToOklchValues(hex)!)).toBe(hex);
    }
  });
});

describe('colorToOklchValues', () => {
  it('converts palette and icon colors alike', () => {
    expect(colorToOklchValues(PROJECT_COLORS[0])).toBe(hslToOklchValues(PROJECT_COLORS[0]));
    expect(colorToOklchValues('#61dafb')).toBe(hexToOklchValues('#61dafb'));
    expect(colorToOklchValues('red')).toBeNull();
  });
});

describe('getNextAvailableColor', () => {
  it('returns the first color when none are used', () => {
    expect(getNextAvailableColor([])).toBe(PROJECT_COLORS[0]);
  });

  it('skips already used colors', () => {
    expect(getNextAvailableColor([PROJECT_COLORS[0]])).toBe(PROJECT_COLORS[1]);
  });

  it('returns the first unused color in palette order', () => {
    const used = [PROJECT_COLORS[0], PROJECT_COLORS[1], PROJECT_COLORS[2]];
    expect(getNextAvailableColor(used)).toBe(PROJECT_COLORS[3]);
  });

  it('handles non-contiguous used colors', () => {
    const used = [PROJECT_COLORS[0], PROJECT_COLORS[2]];
    expect(getNextAvailableColor(used)).toBe(PROJECT_COLORS[1]);
  });

  it('cycles when all colors are used', () => {
    const allUsed = [...PROJECT_COLORS];
    const result = getNextAvailableColor(allUsed);
    expect(PROJECT_COLORS).toContain(result);
    expect(result).toBe(PROJECT_COLORS[allUsed.length % PROJECT_COLORS.length]);
  });
});
