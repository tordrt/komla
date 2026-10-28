// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useWindowFocused } from '../../../src/renderer/hooks/useWindowFocused';

describe('useWindowFocused', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tracks window focus and blur', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { result } = renderHook(() => useWindowFocused());
    expect(result.current).toBe(true);

    hasFocus.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(result.current).toBe(false);

    hasFocus.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(result.current).toBe(true);
  });
});
