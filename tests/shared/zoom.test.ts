import { describe, expect, it } from 'vitest';

import { stepZoomLevel, ZOOM_LEVELS, zoomPercent } from '../../src/shared/constants/zoom';

describe('ZOOM_LEVELS', () => {
  it('runs from 58% to 173% in half levels, keeping the old whole levels', () => {
    expect(ZOOM_LEVELS.map(zoomPercent)).toEqual([
      58, 63, 69, 76, 83, 91, 100, 110, 120, 131, 144, 158, 173,
    ]);
    for (const level of [-2, -1, 0, 1, 2]) expect(ZOOM_LEVELS).toContain(level);
  });
});

describe('stepZoomLevel', () => {
  it('moves half a level from a level on the list', () => {
    expect(stepZoomLevel(0, 1)).toBe(0.5);
    expect(stepZoomLevel(0, -1)).toBe(-0.5);
    expect(stepZoomLevel(-1.5, 1)).toBe(-1);
  });

  it('snaps a level between two on the list to the next one', () => {
    expect(stepZoomLevel(0.2, 1)).toBe(0.5);
    expect(stepZoomLevel(0.2, -1)).toBe(0);
  });

  it('stops at the smallest and largest levels', () => {
    expect(stepZoomLevel(3, 1)).toBe(3);
    expect(stepZoomLevel(-3, -1)).toBe(-3);
    expect(stepZoomLevel(9, -1)).toBe(2.5);
  });
});
