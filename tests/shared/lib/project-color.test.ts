import { describe, expect, it } from 'vitest';

import { getProjectColor, projectColorHex } from '../../../src/shared/lib/project-color';

describe('projectColorHex', () => {
  it('converts a saved hsl color to hex', () => {
    expect(projectColorHex('hsl(200, 75%, 50%)', 'komla')).toBe('#209fdf');
    expect(projectColorHex('hsl(0, 0%, 100%)', 'komla')).toBe('#ffffff');
  });

  it('keeps a saved hex color', () => {
    expect(projectColorHex('#339fee', 'komla')).toBe('#339fee');
  });

  it('falls back to the color the sidebar derives from the name', () => {
    expect(projectColorHex(undefined, 'landing')).toBe(
      projectColorHex(getProjectColor('landing'), 'landing')
    );
    expect(projectColorHex('', 'landing')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('leaves out a saved color it cannot read', () => {
    expect(projectColorHex('rebeccapurple', 'komla')).toBeUndefined();
  });
});
