import { usePaneSurfacesStore } from '@/stores/pane-surfaces.store';

import type { BrowserTabsSource } from '../../shared/lib/browser-tabs';

/** A browser pane's tabs, by its surface id. */
export function useBrowserTabsSource(browserId: string): BrowserTabsSource {
  const surface = usePaneSurfacesStore((s) => s.surfaces[browserId]);
  return surface?.kind === 'browser' ? surface : undefined;
}
