import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

// Width of the edge fade, and how far past it an activated tab is scrolled so
// the fade never sits on top of the active tab.
const EDGE_FADE_PX = 24;
// Chromium reports pixel deltas, but some mice/platforms report lines or pages.
const WHEEL_LINE_PX = 16;

/**
 * How far the tabs can still shrink before they scroll, in pixels, kept current for the controls
 * beside the strip; 0 once they scroll.
 */
export interface TabRoom {
  px: number;
  onChange?: () => void;
}

interface TabStripScrollerProps {
  /** The `data-tab-id` of the active tab, scrolled into view whenever it changes. */
  activeTabId: string | null;
  /** Changes whenever tabs are added, removed or reordered, so overflow is re-measured. */
  tabsKey: string;
  room?: TabRoom;
  className?: string;
  children: React.ReactNode;
}

interface Overflow {
  start: boolean;
  end: boolean;
}

function edgeMask({ start, end }: Overflow): string | undefined {
  if (!start && !end) return undefined;
  return `linear-gradient(to right, ${start ? 'transparent' : 'black'}, black ${EDGE_FADE_PX}px, black calc(100% - ${EDGE_FADE_PX}px), ${end ? 'transparent' : 'black'})`;
}

/**
 * The horizontally scrolling part of the terminal tab bar. A vertical wheel scrolls
 * it sideways, the edges fade where more tabs are hidden, and the active tab is
 * scrolled into view whenever it changes (click, shortcut, new tab).
 */
export function TabStripScroller({
  activeTabId,
  tabsKey,
  room,
  className,
  children,
}: TabStripScrollerProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<Overflow>({ start: false, end: false });

  const measureOverflow = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
    const start = maxScrollLeft > 0 && scroller.scrollLeft > 1;
    const end = maxScrollLeft > 0 && scroller.scrollLeft < maxScrollLeft - 1;
    setOverflow((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    if (!room) return;
    let px = 0;
    if (maxScrollLeft <= 1) {
      for (const tab of scroller.querySelectorAll<HTMLElement>('[data-tab-id]')) {
        px += tab.offsetWidth - (parseFloat(getComputedStyle(tab).minWidth) || 0);
      }
    }
    px = Math.max(0, Math.round(px));
    if (px === room.px) return;
    room.px = px;
    room.onChange?.();
  }, [room]);

  useLayoutEffect(() => {
    measureOverflow();
  }, [measureOverflow, tabsKey]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [measureOverflow]);

  // Scroll only the strip (not its ancestors, as scrollIntoView would) so the
  // active tab clears the edge fades.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !activeTabId) return;
    const tab = Array.from(scroller.querySelectorAll<HTMLElement>('[data-tab-id]')).find(
      (element) => element.dataset.tabId === activeTabId
    );
    if (!tab) return;
    const strip = scroller.getBoundingClientRect();
    const target = tab.getBoundingClientRect();
    if (target.left < strip.left + EDGE_FADE_PX) {
      scroller.scrollLeft -= strip.left + EDGE_FADE_PX - target.left;
    } else if (target.right > strip.right - EDGE_FADE_PX) {
      scroller.scrollLeft += target.right - (strip.right - EDGE_FADE_PX);
    }
    measureOverflow();
  }, [activeTabId, tabsKey, measureOverflow]);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    // Horizontal and Shift+wheel gestures already scroll sideways natively.
    if (event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (scroller.scrollWidth <= scroller.clientWidth) return;
    const unit =
      event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? scroller.clientWidth : 1;
    scroller.scrollLeft += event.deltaY * unit;
    measureOverflow();
  };

  const mask = edgeMask(overflow);

  return (
    <div
      ref={scrollerRef}
      data-overflow-start={overflow.start || undefined}
      data-overflow-end={overflow.end || undefined}
      className={cn('scrollbar-none overflow-x-auto overflow-y-hidden', className)}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      onWheel={handleWheel}
      onScroll={measureOverflow}
    >
      {children}
    </div>
  );
}
