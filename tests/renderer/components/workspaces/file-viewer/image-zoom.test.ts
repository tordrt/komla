import { describe, expect, it } from 'vitest';

import {
  centeredView,
  clampView,
  fitView,
  MAX_SCALE,
  panBy,
  stepScale,
  wheelZoomFactor,
  zoomTo,
} from '../../../../../src/renderer/components/workspaces/file-viewer/image-zoom';

const viewport = { w: 800, h: 600 };
const large = { w: 1600, h: 600 };
const small = { w: 200, h: 100 };

describe('image zoom', () => {
  it('shrinks a large image to fit and centers it', () => {
    expect(fitView(viewport, large)).toEqual({ scale: 0.5, x: 0, y: 150 });
  });

  it('shows a small image at its real size instead of blowing it up', () => {
    expect(fitView(viewport, small)).toEqual({ scale: 1, x: 300, y: 250 });
  });

  it('centers an image larger than the viewport at actual size', () => {
    expect(centeredView(1, viewport, large)).toEqual({ scale: 1, x: -400, y: 0 });
  });

  it('keeps the point under the cursor in place while zooming', () => {
    const view = fitView(viewport, large);
    const anchor = { x: 200, y: 300 };
    const imagePoint = { x: (anchor.x - view.x) / view.scale, y: (anchor.y - view.y) / view.scale };

    const zoomed = zoomTo(view, 2, anchor, viewport, large);

    expect(zoomed.scale).toBe(2);
    expect(zoomed.x + imagePoint.x * zoomed.scale).toBeCloseTo(anchor.x);
    expect(zoomed.y + imagePoint.y * zoomed.scale).toBeCloseTo(anchor.y);
  });

  it('stops panning at the image edges', () => {
    const view = zoomTo(fitView(viewport, large), 1, { x: 0, y: 0 }, viewport, large);

    expect(panBy(view, 5000, 0, viewport, large).x).toBe(0);
    expect(panBy(view, -5000, 0, viewport, large).x).toBe(viewport.w - large.w);
  });

  it('keeps an axis that fits centered', () => {
    expect(panBy(fitView(viewport, small), 50, 50, viewport, small)).toEqual({
      scale: 1,
      x: 300,
      y: 250,
    });
  });

  it('limits how far the image can be zoomed', () => {
    expect(clampView({ scale: 1000, x: 0, y: 0 }, viewport, small).scale).toBe(MAX_SCALE);
    expect(clampView({ scale: 0.001, x: 0, y: 0 }, viewport, small).scale).toBe(0.1);
  });

  it('matches a pinch gesture and caps one mouse-wheel notch', () => {
    expect(wheelZoomFactor(-100 * Math.log(1.05))).toBeCloseTo(1.05);
    expect(wheelZoomFactor(100)).toBeCloseTo(Math.exp(-0.25));
    expect(wheelZoomFactor(-100)).toBeCloseTo(Math.exp(0.25));
  });

  it('steps between preset zoom levels', () => {
    expect(stepScale(1, 1)).toBe(1.5);
    expect(stepScale(1, -1)).toBe(0.75);
    expect(stepScale(0.4, 1)).toBe(0.5);
    expect(stepScale(0.4, -1)).toBe(0.33);
    expect(stepScale(MAX_SCALE, 1)).toBe(MAX_SCALE);
    expect(stepScale(0.1, -1)).toBe(0.1);
  });
});
