import { describe, expect, it } from 'vitest';

import { getLaunchModeColor } from '../../../src/renderer/lib/launch-mode-colors';

describe('getLaunchModeColor', () => {
  it('uses the saved color', () => {
    expect(getLaunchModeColor('cyan', 0)).toBe('cyan');
  });

  it('cycles through fallback colors by position when none is saved', () => {
    expect([0, 1, 2, 3, 4].map((index) => getLaunchModeColor(undefined, index))).toEqual([
      'blue',
      'purple',
      'amber',
      'emerald',
      'blue',
    ]);
  });

  it('falls back to amber for an unknown saved color', () => {
    expect(getLaunchModeColor('chartreuse', 1)).toBe('amber');
  });
});
