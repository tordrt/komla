/**
 * UI zoom levels. Each Electron zoom level scales the window by 1.2×; Cmd+/−
 * move half a level, so Settings offers exactly the levels the shortcuts land on.
 */
export const ZOOM_LEVEL_STEP = 0.5;
export const MIN_ZOOM_LEVEL = -3;
export const MAX_ZOOM_LEVEL = 3;

export const ZOOM_LEVELS: readonly number[] = Array.from(
  { length: (MAX_ZOOM_LEVEL - MIN_ZOOM_LEVEL) / ZOOM_LEVEL_STEP + 1 },
  (_, i) => MIN_ZOOM_LEVEL + i * ZOOM_LEVEL_STEP
);

/** The window size at `level`, as a whole percentage (0.5 → 110). */
export function zoomPercent(level: number): number {
  return Math.round(1.2 ** level * 100);
}

/** The next level up or down from `level`, snapped to the list and kept within it. */
export function stepZoomLevel(level: number, direction: 1 | -1): number {
  const steps = clampZoomLevel(level) / ZOOM_LEVEL_STEP;
  // The epsilon keeps a level already on the list from snapping to itself.
  const next =
    direction === 1
      ? (Math.floor(steps + 1e-9) + 1) * ZOOM_LEVEL_STEP
      : (Math.ceil(steps - 1e-9) - 1) * ZOOM_LEVEL_STEP;
  return clampZoomLevel(next);
}

/** The level on the list nearest to `level`, for values saved from outside the picker. */
export function snapZoomLevel(level: number): number {
  return clampZoomLevel(Math.round(level / ZOOM_LEVEL_STEP) * ZOOM_LEVEL_STEP);
}

function clampZoomLevel(level: number): number {
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, level));
}
