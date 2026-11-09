import { useEffect, type RefObject } from 'react';

/** How close to the top or bottom edge, in px, a drag starts scrolling the list. */
export const AUTO_SCROLL_EDGE = 56;
/** The most px scrolled per frame, reached with the pointer at the very edge or beyond it. */
export const AUTO_SCROLL_MAX_STEP = 18;

/**
 * How far to scroll this frame for a drag at `pointerY` over a box spanning `top` to `bottom`:
 * negative to scroll up, positive to scroll down, 0 away from both edges. The step grows as the
 * pointer nears the edge, so a slow approach scrolls gently.
 */
export function getAutoScrollDelta(
  pointerY: number,
  top: number,
  bottom: number,
  edge = AUTO_SCROLL_EDGE,
  maxStep = AUTO_SCROLL_MAX_STEP
): number {
  // A box shorter than both zones would have them overlap; each gets at most half.
  const zone = Math.min(edge, (bottom - top) / 2);
  if (zone <= 0) return 0;
  const intoTop = top + zone - pointerY;
  if (intoTop > 0) return -Math.ceil(Math.min(1, intoTop / zone) * maxStep);
  const intoBottom = pointerY - (bottom - zone);
  if (intoBottom > 0) return Math.ceil(Math.min(1, intoBottom / zone) * maxStep);
  return 0;
}

const VIEWPORT_SELECTOR = '[data-radix-scroll-area-viewport]';

/**
 * Scrolls a Radix scroll area while anything is dragged over its top or bottom edge, so a drop
 * target further along the list can be reached without letting go. Native drags fire no wheel or
 * scroll events, so this follows `dragover` instead. It listens in the capture phase and never
 * cancels the event, leaving the list's own drop handling untouched.
 */
export function useDragAutoScroll(rootRef: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    const root = enabled ? rootRef.current : null;
    const viewport = root?.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    if (!root || !viewport) return;

    let pointerY: number | null = null;
    let frame: number | null = null;

    const step = () => {
      frame = null;
      if (pointerY === null) return;
      const rect = viewport.getBoundingClientRect();
      const delta = getAutoScrollDelta(pointerY, rect.top, rect.bottom);
      if (delta === 0) return;
      viewport.scrollTop += delta;
      // dragover keeps arriving while the pointer is still, so scrolling goes on until a stop
      // event or the pointer leaves the edge zone, where the next dragover starts it again.
      frame = requestAnimationFrame(step);
    };

    const stop = () => {
      pointerY = null;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };

    const onDragOver = (e: DragEvent) => {
      pointerY = e.clientY;
      if (frame === null) frame = requestAnimationFrame(step);
    };
    // relatedTarget is unreliable on dragleave, so the pointer's position says whether it left.
    const onDragLeave = (e: DragEvent) => {
      const rect = root.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (!inside) stop();
    };

    root.addEventListener('dragover', onDragOver, true);
    root.addEventListener('dragleave', onDragLeave, true);
    root.addEventListener('drop', stop, true);
    // dragend fires on the drag source, which may be removed from the list by then or sit outside it.
    document.addEventListener('dragend', stop, true);
    document.addEventListener('drop', stop, true);
    return () => {
      stop();
      root.removeEventListener('dragover', onDragOver, true);
      root.removeEventListener('dragleave', onDragLeave, true);
      root.removeEventListener('drop', stop, true);
      document.removeEventListener('dragend', stop, true);
      document.removeEventListener('drop', stop, true);
    };
  }, [rootRef, enabled]);
}
