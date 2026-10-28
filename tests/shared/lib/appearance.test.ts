import { readFileSync } from 'fs';

import { describe, expect, it } from 'vitest';

import { appearanceProblems, shownTheme } from '../../../src/shared/lib/appearance';

import type { AppearanceSettings, ThemeConfig } from '../../../src/shared/types';

const customPalette = {
  mode: 'dark',
  surfaces: {
    background: '#0f1410',
    card: '#18201a',
    muted: '#222c24',
    highlight: '#2a362d',
    border: '#3a4a3e',
  },
  terminal: { background: '#0f1410', foreground: '#c8d8c0' },
} as const;

function settings(overrides: Partial<AppearanceSettings> = {}): AppearanceSettings {
  return { palette: 'nord', accent: 'oklch(0.65 0.15 250)', borderRadius: 6, ...overrides };
}

describe('appearanceProblems', () => {
  it('accepts the example apply in the appearance skill', () => {
    const skill = readFileSync('resources/skills/komla-appearance-instructions.md', 'utf8');
    const example = JSON.parse(skill.match(/```json\r?\n([\s\S]*?)```/)![1]);

    expect(appearanceProblems(example)).toEqual([]);
  });

  it('accepts a built-in theme or a valid custom one', () => {
    expect(appearanceProblems(settings())).toEqual([]);
    expect(appearanceProblems(settings({ palette: 'custom', customPalette }))).toEqual([]);
  });

  it('rejects an unknown theme and a custom choice without a customPalette', () => {
    expect(appearanceProblems(settings({ palette: 'Dracula' }))).toEqual([
      'palette "Dracula" isn\'t a theme. Use "custom" or a built-in id from themes.',
    ]);
    expect(appearanceProblems(settings({ palette: 'custom' }))).toEqual([
      'palette "custom" needs a customPalette.',
    ]);
  });

  it('checks a customPalette even when another theme is chosen', () => {
    const unreadable = {
      ...customPalette,
      surfaces: { ...customPalette.surfaces, card: '#8a8a8a' },
    };
    expect(appearanceProblems(settings({ customPalette: unreadable }))).toEqual([
      expect.stringMatching(/^Text on surfaces\.card /),
      expect.stringMatching(/^Secondary text on surfaces\.card /),
    ]);
  });

  it('rejects a custom theme accent that is not oklch', () => {
    expect(
      appearanceProblems(
        settings({ palette: 'custom', customPalette: { ...customPalette, accent: '#ff0000' } })
      )
    ).toEqual(['customPalette.accent must look like "oklch(0.65 0.15 250)".']);
  });

  it('rejects an accent that is not oklch and an out-of-range corner radius', () => {
    expect(appearanceProblems(settings({ accent: '#ff0000', borderRadius: 40 }))).toEqual([
      'accent must look like "oklch(0.65 0.15 250)".',
      'borderRadius must be a number of pixels from 0 to 24.',
    ]);
    expect(appearanceProblems(settings({ borderRadius: -1 }))).toHaveLength(1);
  });
});

describe('shownTheme', () => {
  const following = {
    palette: 'nord',
    followSystem: true,
    lightPalette: 'one-light',
    colors: { accent: 'oklch(0.77 0.06 217)', lightAccent: 'oklch(0.5 0.2 270)' },
  } as ThemeConfig;

  it('shows the light theme and its accent while the system is light', () => {
    expect(shownTheme(following, false)).toMatchObject({
      palette: 'one-light',
      colors: { accent: 'oklch(0.5 0.2 270)' },
    });
    expect(shownTheme(following, true)).toBe(following);
    expect(shownTheme({ ...following, followSystem: false }, false).palette).toBe('nord');
  });

  it.each([
    ['a theme Komla does not have as Komla Light', 'papr'],
    ['a dark theme as Komla Light', 'dracula'],
  ])('shows %s', (_case, lightPalette) => {
    expect(shownTheme({ ...following, lightPalette }, false).palette).toBe('frost');
  });
});
