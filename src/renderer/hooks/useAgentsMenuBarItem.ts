import { useEffect } from 'react';

import { drawAgentsMenuBarImage } from '@/lib/agents-menu-bar-image';
import { watchRootTheme } from '@/lib/root-theme';
import { useConfigStore } from '@/stores/config.store';

/**
 * Serves the macOS menu bar's agents item: draws its image when main asks, which it asks only of
 * Komla's main window, and while it shows, sends Komla's theme for its popover to match.
 */
export function useAgentsMenuBarItem(): void {
  const enabled = useConfigStore(
    (s) => window.api.platform === 'darwin' && s.config?.showAgentsInMenuBar === true
  );

  // Listens even before the config loads: main asks as soon as the item appears.
  useEffect(
    () =>
      window.api.onAgentsMenuBarDraw(({ counts, dark }) => {
        void drawAgentsMenuBarImage(counts, dark)
          .then((image) => window.api.setAgentsMenuBarImage(image))
          .catch((error) => console.error('Failed to draw the menu bar item:', error));
      }),
    []
  );

  useEffect(() => {
    if (!enabled) return;
    return watchRootTheme((theme) => window.api.setAgentsMenuBarTheme(theme));
  }, [enabled]);
}
