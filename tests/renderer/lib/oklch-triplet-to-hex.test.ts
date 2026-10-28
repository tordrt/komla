import { describe, it, expect } from 'vitest';

import { oklchTripletToHex } from '../../../src/renderer/lib/palette-runtime';

describe('oklchTripletToHex', () => {
  it('converts the default dark palette --card to its expected hex', () => {
    expect(oklchTripletToHex('0.23 0.014 260')).toBe('#191d24');
  });

  it('converts the default dark palette --card-foreground', () => {
    expect(oklchTripletToHex('0.92 0.005 265')).toBe('#e3e4e8');
  });

  it('converts the default light palette --card', () => {
    expect(oklchTripletToHex('0.99 0.004 265')).toBe('#fafcff');
  });

  it('converts the default light palette --card-foreground', () => {
    expect(oklchTripletToHex('0.18 0.008 265')).toBe('#101215');
  });

  it('converts the cool-neutral palette --card', () => {
    // Pin to the original hardcoded title-bar overlay color from window.service.ts
    // — the math should reproduce exactly the value the app shipped with.
    expect(oklchTripletToHex('0.24 0.005 270')).toBe('#1e1f22');
  });

  it('handles pure white and black extremes', () => {
    expect(oklchTripletToHex('1 0 0')).toBe('#ffffff');
    expect(oklchTripletToHex('0 0 0')).toBe('#000000');
  });

  it('clamps out-of-gamut OKLCH instead of producing NaN', () => {
    // High-chroma OKLCH that maps outside sRGB. Without clamping before gamma,
    // Math.pow(negative, 1/2.4) yields NaN and the helper produces "#NaNNaNNaN".
    const result = oklchTripletToHex('0.5 0.5 30');
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
    expect(result).not.toContain('NaN');
  });

  it('returns null for malformed input', () => {
    expect(oklchTripletToHex('not a triplet')).toBeNull();
    expect(oklchTripletToHex('0.5 0.5')).toBeNull();
    expect(oklchTripletToHex('')).toBeNull();
  });

  it('rejects bare-dot tokens that would parseFloat to NaN', () => {
    // Pre-tightening, "[\\d.]+" matched "." / ".." / "...", which parseFloat
    // returned NaN for, ultimately producing "#NaNNaNNaN".
    expect(oklchTripletToHex('. . .')).toBeNull();
    expect(oklchTripletToHex('.. .. ..')).toBeNull();
    expect(oklchTripletToHex('0.5 . 270')).toBeNull();
    expect(oklchTripletToHex('0..5 0.5 270')).toBeNull();
  });

  it('reads minified values without leading zeros, as the built stylesheet serves them', () => {
    expect(oklchTripletToHex('.23 .014 260')).toBe('#191d24');
  });

  it('tolerates surrounding whitespace from getComputedStyle', () => {
    // getPropertyValue often returns values with a leading space.
    expect(oklchTripletToHex(' 0.23 0.014 260 ')).toBe('#191d24');
  });
});
