import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { rectsIntersect } from '@/lib/native-view-layout';

import type { DevPreviewBounds, DevPreviewSnapshot } from '../../../shared/types';

interface NativeDevPreviewHostProps {
  workspaceId: string;
  tabId: string;
  url: string;
  visible: boolean;
}

// A fresh frame normally paints within ~100ms. Capturing can stall (minimized
// window, busy GPU) while the overlay waits hidden behind the page, so after
// this long the page steps aside without it.
const FRESH_FRAME_TIMEOUT_MS = 200;

interface OverlayFreeze {
  cancelled: boolean;
}

function hasBlockingOverlay(hostBounds: DOMRect): boolean {
  return [...document.querySelectorAll<HTMLElement>('[data-native-overlay]')].some((overlay) =>
    rectsIntersect(hostBounds, overlay.getBoundingClientRect())
  );
}

function mutationTouchesOverlay(mutation: MutationRecord): boolean {
  const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
  return (
    (mutation.target instanceof Element && mutation.target.closest('[data-native-overlay]')) !==
      null ||
    changedNodes.some(
      (node) =>
        node instanceof Element &&
        (node.matches('[data-native-overlay]') || node.querySelector('[data-native-overlay]'))
    )
  );
}

function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBounds(rect: DOMRect): DevPreviewBounds | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function NativeDevPreviewHost({
  workspaceId,
  tabId,
  url,
  visible,
}: NativeDevPreviewHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLImageElement | null>(null);
  const lastLayoutKeyRef = useRef('');
  const overlayFreezeRef = useRef<OverlayFreeze | null>(null);
  const [snapshot, setSnapshot] = useState<DevPreviewSnapshot | null>(null);

  useLayoutEffect(() => {
    return window.api.onDevPreviewSnapshotUpdated((nextSnapshot) => {
      if (nextSnapshot.workspaceId === workspaceId && nextSnapshot.tabId === tabId) {
        setSnapshot(nextSnapshot);
      }
    });
  }, [tabId, workspaceId]);

  // The native view draws above every renderer overlay, so it steps aside while
  // one overlaps it. It stays up until a fresh frame of the page is painted in
  // its place, so the swap doesn't show stale or blank content.
  const freezeForOverlay = useCallback(() => {
    if (overlayFreezeRef.current) return;
    const freeze: OverlayFreeze = { cancelled: false };
    overlayFreezeRef.current = freeze;
    const paintFreshFrame = async () => {
      const dataUrl = await window.api.captureDevPreview(workspaceId, tabId).catch(() => null);
      if (freeze.cancelled || !dataUrl) return;
      flushSync(() => setSnapshot({ workspaceId, tabId, dataUrl }));
      await frameRef.current?.decode().catch(() => undefined);
      await afterNextPaint();
    };
    void Promise.race([paintFreshFrame(), delay(FRESH_FRAME_TIMEOUT_MS)]).then(() => {
      if (!freeze.cancelled) window.api.hideDevPreview(workspaceId, tabId);
    });
  }, [tabId, workspaceId]);

  const releaseOverlayFreeze = useCallback(() => {
    if (overlayFreezeRef.current) overlayFreezeRef.current.cancelled = true;
    overlayFreezeRef.current = null;
  }, []);

  const sync = useCallback(() => {
    const host = hostRef.current;
    const rect = host?.getBoundingClientRect();
    const bounds = rect ? readBounds(rect) : null;
    const blocked = rect ? hasBlockingOverlay(rect) : false;
    lastLayoutKeyRef.current = bounds
      ? `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${blocked}`
      : '';
    if (visible && bounds && blocked) {
      freezeForOverlay();
      return;
    }
    releaseOverlayFreeze();
    if (!visible || !bounds) {
      window.api.hideDevPreview(workspaceId, tabId);
      return;
    }
    window.api.syncDevPreview(workspaceId, tabId, url, bounds);
  }, [freezeForOverlay, releaseOverlayFreeze, tabId, url, visible, workspaceId]);

  useLayoutEffect(() => {
    if (!visible) {
      window.api.hideDevPreview(workspaceId, tabId);
      return () => window.api.hideDevPreview(workspaceId, tabId);
    }

    sync();

    const host = hostRef.current;
    if (!host) return () => window.api.hideDevPreview(workspaceId, tabId);

    const resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(host);
    const overlayObserver = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesOverlay)) sync();
    });
    overlayObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-native-overlay', 'data-state', 'style'],
      childList: true,
      subtree: true,
    });
    let animationFrame = 0;
    const trackPosition = () => {
      const rect = host.getBoundingClientRect();
      const nextKey = `${rect.left}:${rect.top}:${rect.width}:${rect.height}:${hasBlockingOverlay(rect)}`;
      if (nextKey !== lastLayoutKeyRef.current) sync();
      animationFrame = requestAnimationFrame(trackPosition);
    };
    animationFrame = requestAnimationFrame(trackPosition);
    window.addEventListener('resize', sync);
    document.addEventListener('scroll', sync, true);

    return () => {
      resizeObserver.disconnect();
      overlayObserver.disconnect();
      cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', sync);
      document.removeEventListener('scroll', sync, true);
      releaseOverlayFreeze();
      window.api.hideDevPreview(workspaceId, tabId);
    };
  }, [releaseOverlayFreeze, sync, tabId, visible, workspaceId]);

  return (
    <div
      ref={hostRef}
      className="relative min-h-0 flex-1 bg-background"
      data-native-view={visible ? 'dev-preview' : undefined}
      data-testid="native-dev-preview-host"
      title="HTTP server preview"
    >
      {snapshot?.workspaceId === workspaceId && snapshot.tabId === tabId && (
        <img
          ref={frameRef}
          alt=""
          className="pointer-events-none absolute inset-0 size-full object-cover"
          draggable={false}
          src={snapshot.dataUrl}
        />
      )}
    </div>
  );
}
