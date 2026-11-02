// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDraggedPaneId } from '../../../src/renderer/hooks/useDraggedPaneId';
import { getDraggedPaneId, setDraggedPaneId } from '../../../src/renderer/lib/pane-drag';

describe('useDraggedPaneId', () => {
  afterEach(() => {
    act(() => setDraggedPaneId(null));
  });

  it('follows the dragged pane from the start of its drag to the end', () => {
    const { result } = renderHook(() => useDraggedPaneId());
    expect(result.current).toBeNull();

    act(() => setDraggedPaneId('pane-1'));
    expect(result.current).toBe('pane-1');

    act(() => setDraggedPaneId(null));
    expect(result.current).toBeNull();
  });

  // The source pane can unmount on a drop, and then its dragend, which clears the dragged pane,
  // never comes.
  it.each(['drop', 'dragend', 'pointerdown'])(
    'ends the drag at a %s anywhere in the window',
    (type) => {
      const { result } = renderHook(() => useDraggedPaneId());
      act(() => setDraggedPaneId('pane-1'));

      act(() => {
        document.body.dispatchEvent(new Event(type, { bubbles: true }));
      });
      expect(result.current).toBeNull();
    }
  );

  it("lets the drop's target read the dragged pane before the drag ends", () => {
    renderHook(() => useDraggedPaneId());
    act(() => setDraggedPaneId('pane-1'));
    const target = document.createElement('div');
    document.body.append(target);
    let seen: string | null = null;
    target.addEventListener('drop', () => {
      seen = getDraggedPaneId();
    });

    act(() => {
      target.dispatchEvent(new Event('drop', { bubbles: true }));
    });
    expect(seen).toBe('pane-1');
    expect(getDraggedPaneId()).toBeNull();
    target.remove();
  });

  it('leaves the window alone between drags', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    setDraggedPaneId('pane-1');
    setDraggedPaneId(null);
    expect(add.mock.calls.map(([type]) => type).sort()).toEqual(['dragend', 'drop', 'pointerdown']);
    expect(remove.mock.calls.map(([type]) => type).sort()).toEqual([
      'dragend',
      'drop',
      'pointerdown',
    ]);
    add.mockRestore();
    remove.mockRestore();
  });

  // A pointer can move under a drag that has just begun, as the page changes under it.
  it('keeps the drag through a pointer move', () => {
    setDraggedPaneId('pane-1');
    document.body.dispatchEvent(new Event('pointermove', { bubbles: true }));
    expect(getDraggedPaneId()).toBe('pane-1');
  });

  it('starts with the drag a pane mounted into has under way', () => {
    setDraggedPaneId('pane-1');
    const { result } = renderHook(() => useDraggedPaneId());
    expect(result.current).toBe('pane-1');
  });
});
