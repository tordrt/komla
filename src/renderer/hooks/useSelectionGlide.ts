import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Short and front-loaded, so the highlight lands about when the switched-to view paints. */
export const SELECTION_GLIDE_MS = 140;
const SELECTION_GLIDE_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
/** Farther jumps (a ⌘-number switch across the list) show at once instead of sweeping past cards. */
const MAX_GLIDE_DISTANCE = 480;

let lastSelected: { item: HTMLElement; at: number } | null = null;

/**
 * Slides a list's selection highlight from the previously selected item to this one. The
 * highlight is the returned ref's element, drawn inside the item; only one item in the app
 * holds a selection at a time. Moves that come faster than the glide itself, like a held
 * arrow key, jump, and so does everything under reduced motion.
 */
export function useSelectionGlide(
  itemRef: RefObject<HTMLElement | null>,
  selected: boolean
): RefObject<HTMLSpanElement | null> {
  const highlightRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    if (!selected) return;
    const item = itemRef.current;
    const highlight = highlightRef.current;
    if (!item) return;
    // When the selection moves away and no other item takes it in the same commit, as on the
    // overview, the next selection appears in place: nothing was highlighted to glide from.
    const release = () =>
      queueMicrotask(() => {
        if (lastSelected?.item === item) lastSelected = null;
      });
    const previous = lastSelected;
    const now = performance.now();
    lastSelected = { item, at: now };
    if (!highlight || !previous || previous.item === item || !previous.item.isConnected) {
      return release;
    }
    if (now - previous.at < SELECTION_GLIDE_MS) return release;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return release;
    const from = previous.item.getBoundingClientRect();
    const to = item.getBoundingClientRect();
    const dy = from.top - to.top;
    if (!from.height || !to.height || Math.abs(dy) > MAX_GLIDE_DISTANCE) return release;
    highlight.animate?.(
      [
        { transform: `translateY(${dy}px) scaleY(${from.height / to.height})` },
        { transform: 'none' },
      ],
      { duration: SELECTION_GLIDE_MS, easing: SELECTION_GLIDE_EASING }
    );
    return release;
  }, [itemRef, selected]);
  return highlightRef;
}
