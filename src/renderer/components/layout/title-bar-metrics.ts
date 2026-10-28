import { useWindowStore } from '@/stores/window.store';

import type { CSSProperties } from 'react';

/** Room the title bar and the tab row leave at the right for the Windows caption buttons (3 × 46px). */
export const WINDOWS_CAPTION_BUTTONS_WIDTH_PX = 138;

/** Room the macOS traffic lights take at the left of the window. */
export const MAC_TRAFFIC_LIGHT_INSET_PX = 80;

/** Whether the macOS traffic lights show, which they don't in fullscreen. */
export function useHasTrafficLights(): boolean {
  const isFullscreen = useWindowStore((state) => state.isFullscreen);
  return window.api.platform === 'darwin' && !isFullscreen;
}

/** Title-bar icon buttons keep the foreground color of the text buttons beside them. */
export const TITLE_BAR_ICON_BUTTON_CLASS = 'no-drag text-foreground';

/** Title bar height in px, which the tab row matches: h-10 (40px) on Windows, h-9 (36px) elsewhere. */
export function titleBarHeightPx(): number {
  return window.api.platform === 'win32' ? 40 : 36;
}

/**
 * The size and padding of a full-window view's top row, which takes the title bar's place: as
 * tall, and clear of the macOS traffic lights and the Windows caption buttons.
 */
export function useTopRowStyle(): CSSProperties {
  const hasTrafficLights = useHasTrafficLights();
  return {
    height: titleBarHeightPx(),
    ...(hasTrafficLights && { paddingLeft: MAC_TRAFFIC_LIGHT_INSET_PX }),
    ...(window.api.platform === 'win32' && { paddingRight: WINDOWS_CAPTION_BUTTONS_WIDTH_PX }),
  };
}
