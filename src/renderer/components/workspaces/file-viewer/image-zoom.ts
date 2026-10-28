export interface Size {
  w: number;
  h: number;
}

/** The image is drawn at `scale` with its top-left corner at (`x`, `y`) in the viewport. */
export interface ImageView {
  scale: number;
  x: number;
  y: number;
}

export const MAX_SCALE = 32;
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

/** Shrinks large images to fit; never blows small ones up past their real size. */
export function fitScale(viewport: Size, image: Size): number {
  if (image.w <= 0 || image.h <= 0 || viewport.w <= 0 || viewport.h <= 0) return 1;
  return Math.min(1, viewport.w / image.w, viewport.h / image.h);
}

export function minScale(viewport: Size, image: Size): number {
  return Math.min(0.1, fitScale(viewport, image));
}

export function fitView(viewport: Size, image: Size): ImageView {
  return centeredView(fitScale(viewport, image), viewport, image);
}

export function centeredView(scale: number, viewport: Size, image: Size): ImageView {
  const view = {
    scale,
    x: (viewport.w - image.w * scale) / 2,
    y: (viewport.h - image.h * scale) / 2,
  };
  return clampView(view, viewport, image);
}

/** Centers an axis that fits in the viewport and keeps an overflowing one from leaving gaps. */
export function clampView(view: ImageView, viewport: Size, image: Size): ImageView {
  const scale = Math.min(MAX_SCALE, Math.max(minScale(viewport, image), view.scale));
  return {
    scale,
    x: clampAxis(view.x, viewport.w, image.w * scale),
    y: clampAxis(view.y, viewport.h, image.h * scale),
  };
}

function clampAxis(offset: number, viewportLength: number, imageLength: number): number {
  if (imageLength <= viewportLength) return (viewportLength - imageLength) / 2;
  return Math.min(0, Math.max(viewportLength - imageLength, offset));
}

/** Zooms to `scale`, keeping the image point under `anchor` (viewport coordinates) in place. */
export function zoomTo(
  view: ImageView,
  scale: number,
  anchor: { x: number; y: number },
  viewport: Size,
  image: Size
): ImageView {
  const next = Math.min(MAX_SCALE, Math.max(minScale(viewport, image), scale));
  const ratio = next / view.scale;
  return clampView(
    {
      scale: next,
      x: anchor.x - (anchor.x - view.x) * ratio,
      y: anchor.y - (anchor.y - view.y) * ratio,
    },
    viewport,
    image
  );
}

export function panBy(
  view: ImageView,
  dx: number,
  dy: number,
  viewport: Size,
  image: Size
): ImageView {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, viewport, image);
}

/**
 * Scale factor for a pinch or Ctrl/Cmd+wheel event. Chromium reports a pinch as
 * deltaY = -100 * ln(scale), so this matches the gesture; capping the delta keeps
 * one mouse-wheel notch (deltaY ±100) to a modest step.
 */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-Math.max(-25, Math.min(25, deltaY)) / 100);
}

/** The next preset zoom level above (`1`) or below (`-1`) `scale`. */
export function stepScale(scale: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > scale * 1.01) ?? MAX_SCALE;
  return ZOOM_STEPS.findLast((step) => step < scale / 1.01) ?? ZOOM_STEPS[0];
}
