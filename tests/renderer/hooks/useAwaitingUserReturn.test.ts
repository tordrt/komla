// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  awaitUserReturn,
  useAwaitingUserReturn,
} from '../../../src/renderer/hooks/useAwaitingUserReturn';

const move = (movementX: number) => new MouseEvent('pointermove', { movementX });

describe('useAwaitingUserReturn', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  it.each([
    ['a key press', () => new KeyboardEvent('keydown', { key: 'a' })],
    ['a click', () => new Event('pointerdown')],
    ['mouse movement', () => move(4)],
  ])('waits for the user until %s', (_input, event) => {
    const { result } = renderHook(() => useAwaitingUserReturn());
    expect(result.current).toBe(false);

    act(() => awaitUserReturn());
    expect(result.current).toBe(true);

    act(() => {
      window.dispatchEvent(event());
    });
    expect(result.current).toBe(false);
  });

  it('runs what waits for the user once they are back', () => {
    const first = vi.fn();
    const second = vi.fn();
    act(() => awaitUserReturn(first));
    act(() => awaitUserReturn(second));
    expect(first).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
      window.dispatchEvent(new Event('pointerdown'));
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('ignores input that is not the user coming back to Komla', () => {
    const { result } = renderHook(() => useAwaitingUserReturn());
    const onReturn = vi.fn();
    act(() => awaitUserReturn(onReturn));

    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => {
      window.dispatchEvent(move(4));
    });
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => {
      window.dispatchEvent(move(0));
    });
    expect(result.current).toBe(true);
    expect(onReturn).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(move(4));
    });
    expect(result.current).toBe(false);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });
});
