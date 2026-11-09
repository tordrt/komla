// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTO_SCROLL_EDGE,
  AUTO_SCROLL_MAX_STEP,
  getAutoScrollDelta,
  useDragAutoScroll,
} from '../../../src/renderer/hooks/useDragAutoScroll';

describe('getAutoScrollDelta', () => {
  const top = 100;
  const bottom = 500;

  it('does not scroll away from the edges', () => {
    expect(getAutoScrollDelta(300, top, bottom)).toBe(0);
    expect(getAutoScrollDelta(top + AUTO_SCROLL_EDGE, top, bottom)).toBe(0);
    expect(getAutoScrollDelta(bottom - AUTO_SCROLL_EDGE, top, bottom)).toBe(0);
  });

  it('scrolls up near the top and down near the bottom', () => {
    expect(getAutoScrollDelta(top + 10, top, bottom)).toBeLessThan(0);
    expect(getAutoScrollDelta(bottom - 10, top, bottom)).toBeGreaterThan(0);
  });

  it('scrolls faster the nearer the edge, up to the maximum', () => {
    const gentle = getAutoScrollDelta(bottom - 40, top, bottom);
    const fast = getAutoScrollDelta(bottom - 5, top, bottom);
    expect(fast).toBeGreaterThan(gentle);
    expect(getAutoScrollDelta(bottom + 200, top, bottom)).toBe(AUTO_SCROLL_MAX_STEP);
    expect(getAutoScrollDelta(top - 200, top, bottom)).toBe(-AUTO_SCROLL_MAX_STEP);
  });

  it('gives a box too short for two zones half each, and a collapsed box none', () => {
    // 40px tall: zones are 20px, so the middle is the boundary and scrolls neither way.
    expect(getAutoScrollDelta(120, 100, 140)).toBe(0);
    expect(getAutoScrollDelta(105, 100, 140)).toBeLessThan(0);
    expect(getAutoScrollDelta(135, 100, 140)).toBeGreaterThan(0);
    expect(getAutoScrollDelta(100, 100, 100)).toBe(0);
  });
});

describe('useDragAutoScroll', () => {
  let root: HTMLDivElement;
  let viewport: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement('div');
    viewport = document.createElement('div');
    viewport.setAttribute('data-radix-scroll-area-viewport', '');
    const box = { left: 0, right: 300, top: 100, bottom: 500 } as DOMRect;
    viewport.getBoundingClientRect = () => box;
    root.getBoundingClientRect = () => box;
    root.appendChild(viewport);
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
    vi.useRealTimers();
  });

  const pointerEvent = (type: string, clientX: number, clientY: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, 'clientX', { value: clientX });
    Object.defineProperty(event, 'clientY', { value: clientY });
    return event;
  };
  const dragOver = (clientY: number) => {
    const event = pointerEvent('dragover', 150, clientY);
    viewport.dispatchEvent(event);
    return event;
  };
  const frames = (count: number) => vi.advanceTimersByTime(count * 20);

  it('scrolls the viewport while a drag rests at the bottom edge', () => {
    renderHook(() => useDragAutoScroll({ current: root }));

    dragOver(495);
    frames(3);

    expect(viewport.scrollTop).toBeGreaterThan(0);
  });

  it('scrolls back up at the top edge', () => {
    viewport.scrollTop = 200;
    renderHook(() => useDragAutoScroll({ current: root }));

    dragOver(105);
    frames(3);

    expect(viewport.scrollTop).toBeLessThan(200);
  });

  it('leaves a drag in the middle of the list alone', () => {
    renderHook(() => useDragAutoScroll({ current: root }));

    dragOver(300);
    frames(3);

    expect(viewport.scrollTop).toBe(0);
  });

  it('does not cancel the drag, so the list still takes the drop', () => {
    renderHook(() => useDragAutoScroll({ current: root }));

    expect(dragOver(495).defaultPrevented).toBe(false);
  });

  it.each([
    ['the pointer leaves the list', () => root.dispatchEvent(pointerEvent('dragleave', 400, 495))],
    ['the drag ends', () => document.dispatchEvent(new Event('dragend'))],
    ['the drag is dropped', () => document.dispatchEvent(new Event('drop'))],
  ])('stops scrolling when %s', (_name, stop) => {
    renderHook(() => useDragAutoScroll({ current: root }));
    dragOver(495);
    frames(2);

    stop();
    const stopped = viewport.scrollTop;
    frames(5);

    expect(viewport.scrollTop).toBe(stopped);
  });

  it('keeps scrolling when the pointer moves between elements inside the list', () => {
    renderHook(() => useDragAutoScroll({ current: root }));
    dragOver(495);

    // A dragleave with no relatedTarget, as Chromium may send, still inside the list's box.
    viewport.dispatchEvent(pointerEvent('dragleave', 150, 495));
    const before = viewport.scrollTop;
    frames(3);

    expect(viewport.scrollTop).toBeGreaterThan(before);
  });

  it('schedules no frames while the drag is away from both edges', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    renderHook(() => useDragAutoScroll({ current: root }));

    dragOver(300);
    frames(1);
    const calls = raf.mock.calls.length;
    frames(5);

    expect(raf.mock.calls.length).toBe(calls);
  });

  it('does nothing when disabled', () => {
    renderHook(() => useDragAutoScroll({ current: root }, false));

    dragOver(495);
    frames(3);

    expect(viewport.scrollTop).toBe(0);
  });

  it('stops listening on unmount', () => {
    const { unmount } = renderHook(() => useDragAutoScroll({ current: root }));
    unmount();

    dragOver(495);
    frames(3);

    expect(viewport.scrollTop).toBe(0);
  });
});
