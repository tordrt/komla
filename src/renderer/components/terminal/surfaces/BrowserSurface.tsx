import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { closePaneBrowserTab } from '@/lib/pane-surfaces';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { usePaneSurfacesStore } from '@/stores/pane-surfaces.store';

import { getActiveBrowserTab } from '../../../../shared/lib/browser-tabs';
import { getPaneSurfaceIdOfTab } from '../../../../shared/lib/pane-surface-id';
import { BrowserTabList } from '../BrowserTabList';
import { InlineDevServerPreviewPanel } from '../InlineDevServerPreviewPanel';

import type { SurfaceBodyProps } from './surface-props';

interface BrowserSurfaceProps extends SurfaceBodyProps {
  /** Clicking into the page, which the pane's own DOM never hears about. */
  onPageFocus: () => void;
}

/** Whether the file panel covers the panes, in Full layout. */
function useRightSlotCoversPanes(workspaceId: string): boolean {
  const filePreview = useFileViewerStore((s) => s.inlineFilePreviewByWorkspace[workspaceId]);
  const layout = filePreview?.layout ?? 'full';
  return !!filePreview?.open && layout === 'full';
}

/** Whether a split divider is being dragged. The page lags behind the resize, so it hides meanwhile. */
function useSplitResizeActive(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const start = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('.sash, [data-inline-resize-handle="true"]')
      ) {
        setActive(true);
      }
    };
    const end = () => setActive(false);
    window.addEventListener('mousedown', start, true);
    window.addEventListener('mouseup', end);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('mousedown', start, true);
      window.removeEventListener('mouseup', end);
      window.removeEventListener('blur', end);
    };
  }, []);
  return active;
}

/** A browser pane, with its tabs in the pane's header. It finds running servers and forwards SSH ports. */
export function BrowserSurface({
  surfaceId,
  workspace,
  isTabActive,
  header,
  onPageFocus,
}: BrowserSurfaceProps) {
  const workspaceId = workspace.id;
  const coveredByPanel = useRightSlotCoversPanes(workspaceId);
  const isResizing = useSplitResizeActive();

  const onPageFocusRef = useRef(onPageFocus);
  useLayoutEffect(() => {
    onPageFocusRef.current = onPageFocus;
  });
  useEffect(() => {
    return window.api.onDevPreviewFocused((page) => {
      if (page.workspaceId === workspaceId && getPaneSurfaceIdOfTab(page.tabId) === surfaceId) {
        onPageFocusRef.current();
      }
    });
  }, [surfaceId, workspaceId]);

  // A new pane asks for an address. The menu that opened it hands focus back to
  // where it was once it closes, so this waits for that.
  useEffect(() => {
    const surface = usePaneSurfacesStore.getState().surfaces[surfaceId];
    if (surface?.kind !== 'browser' || getActiveBrowserTab(surface)?.url) return;
    const timer = setTimeout(() => {
      document
        .querySelector<HTMLInputElement>(`[data-browser-address="${CSS.escape(surfaceId)}"]`)
        ?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [surfaceId]);

  return (
    <>
      {header(
        <div className="flex h-7 min-w-0 flex-1 items-stretch">
          <BrowserTabList
            browserId={surfaceId}
            onCloseTab={(tabId) => closePaneBrowserTab(workspaceId, tabId)}
          />
        </div>,
        { tabs: true }
      )}
      <div className="min-h-0 flex-1">
        <InlineDevServerPreviewPanel
          workspaceId={workspaceId}
          browserId={surfaceId}
          isActive={isTabActive}
          isSplitResizeActive={isResizing}
          isCovered={coveredByPanel}
        />
      </div>
    </>
  );
}
