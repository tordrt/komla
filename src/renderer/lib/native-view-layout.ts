/**
 * Electron draws native views (the browser preview's WebContentsView) above the
 * whole renderer, so DOM content overlapping one is hidden behind it. Hosts mark
 * themselves with `data-native-view` while their native view is shown.
 */
type Box = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;

export function rectsIntersect(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function nativeViewRects(): DOMRect[] {
  return [...document.querySelectorAll<HTMLElement>('[data-native-view]')].map((host) =>
    host.getBoundingClientRect()
  );
}
