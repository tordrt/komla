import { useSyncExternalStore } from 'react';

import { getDraggedPaneId, subscribeDraggedPaneId } from '@/lib/pane-drag';

/** The pane being dragged, by itself or by the tab holding only it, or null when none is. */
export function useDraggedPaneId(): string | null {
  return useSyncExternalStore(subscribeDraggedPaneId, getDraggedPaneId);
}
