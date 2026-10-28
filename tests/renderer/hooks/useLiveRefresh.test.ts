// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { LIVE_REFRESH_MS, useLiveRefresh } from '../../../src/renderer/hooks/useDevPreviewServices';

let visibilityState: DocumentVisibilityState = 'visible';

function setVisibility(state: DocumentVisibilityState): void {
  visibilityState = state;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('useLiveRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    vi.useRealTimers();
  });

  it('bumps the tick a refresh interval after it starts waiting, only while waiting', () => {
    const setTick = vi.fn();
    const { rerender } = renderHook(({ waiting }) => useLiveRefresh(waiting, setTick), {
      initialProps: { waiting: true },
    });

    vi.advanceTimersByTime(LIVE_REFRESH_MS - 1);
    expect(setTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setTick).toHaveBeenCalledTimes(1);

    rerender({ waiting: false });
    vi.advanceTimersByTime(LIVE_REFRESH_MS * 2);
    setVisibility('hidden');
    setVisibility('visible');
    expect(setTick).toHaveBeenCalledTimes(1);
  });

  it('waits the given delay instead of the refresh interval', () => {
    const setTick = vi.fn();
    renderHook(() => useLiveRefresh(true, setTick, 1_000));

    vi.advanceTimersByTime(999);
    expect(setTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setTick).toHaveBeenCalledTimes(1);
  });

  it('bumps once a hidden window shows again after the interval', () => {
    const setTick = vi.fn();
    renderHook(() => useLiveRefresh(true, setTick));

    setVisibility('hidden');
    vi.advanceTimersByTime(LIVE_REFRESH_MS * 3);
    expect(setTick).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(setTick).toHaveBeenCalledTimes(1);
  });

  it('keeps the interval when the window shows again before it ends', () => {
    const setTick = vi.fn();
    renderHook(() => useLiveRefresh(true, setTick));

    setVisibility('hidden');
    vi.advanceTimersByTime(LIVE_REFRESH_MS / 2);
    setVisibility('visible');
    expect(setTick).not.toHaveBeenCalled();

    vi.advanceTimersByTime(LIVE_REFRESH_MS / 2);
    expect(setTick).toHaveBeenCalledTimes(1);
  });
});
