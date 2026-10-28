import { afterEach, describe, it, expect } from 'vitest';

import {
  getDropZone,
  getDraggedPaneId,
  getDroppedPaneId,
  isPaneDrag,
  isPaneDragFromPane,
  isTabPaneDrag,
  PANE_DRAG_MIME,
  resolvePaneDrop,
  resolvePaneDropFromEvent,
  setDraggedPaneId,
  TAB_PANE_DRAG_MIME,
} from '../../../src/renderer/lib/pane-drag';

function dataTransferWith(types: string[], data: Record<string, string> = {}): DataTransfer {
  return { types, getData: (type: string) => data[type] ?? '' } as unknown as DataTransfer;
}

const rect = { left: 0, top: 0, width: 100, height: 100 };

describe('pane-drag', () => {
  describe('getDropZone', () => {
    it('returns "center" for the inner region', () => {
      expect(getDropZone(rect, 50, 50)).toBe('center');
    });

    it('returns the nearest edge for outer regions', () => {
      expect(getDropZone(rect, 5, 50)).toBe('left');
      expect(getDropZone(rect, 95, 50)).toBe('right');
      expect(getDropZone(rect, 50, 5)).toBe('top');
      expect(getDropZone(rect, 50, 95)).toBe('bottom');
    });

    it('resolves a corner to the closest edge', () => {
      // Slightly closer to the left edge than the top edge.
      expect(getDropZone(rect, 5, 10)).toBe('left');
    });

    it('falls back to center for a zero-sized rect', () => {
      expect(getDropZone({ left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBe('center');
    });

    it('resolves the inner region to the nearest edge when only edges are allowed', () => {
      expect(getDropZone(rect, 40, 50, { edgesOnly: true })).toBe('left');
      expect(getDropZone(rect, 50, 65, { edgesOnly: true })).toBe('bottom');
    });
  });

  describe('draggedPaneId', () => {
    it('stores and clears the dragged pane id', () => {
      expect(getDraggedPaneId()).toBeNull();
      setDraggedPaneId('pane-7');
      expect(getDraggedPaneId()).toBe('pane-7');
      setDraggedPaneId(null);
      expect(getDraggedPaneId()).toBeNull();
    });
  });

  describe('isPaneDrag', () => {
    it('recognizes a drag carrying the pane MIME type', () => {
      expect(isPaneDrag(dataTransferWith([PANE_DRAG_MIME]))).toBe(true);
      expect(isPaneDrag(dataTransferWith(['text/plain', PANE_DRAG_MIME]))).toBe(true);
    });

    it('rejects non-pane drags (e.g. OS file drops)', () => {
      expect(isPaneDrag(dataTransferWith(['Files']))).toBe(false);
      expect(isPaneDrag(dataTransferWith([]))).toBe(false);
    });
  });

  describe('isTabPaneDrag', () => {
    it("recognizes a tab drag that carries the tab's only pane", () => {
      expect(isTabPaneDrag(dataTransferWith([PANE_DRAG_MIME, TAB_PANE_DRAG_MIME]))).toBe(true);
    });

    it('rejects a pane dragged by its grip', () => {
      expect(isTabPaneDrag(dataTransferWith([PANE_DRAG_MIME]))).toBe(false);
    });
  });

  describe('isPaneDragFromPane', () => {
    it('recognizes a pane dragged by its grip', () => {
      expect(isPaneDragFromPane(dataTransferWith([PANE_DRAG_MIME]))).toBe(true);
    });

    it('rejects a tab drag and non-pane drags', () => {
      expect(isPaneDragFromPane(dataTransferWith([PANE_DRAG_MIME, TAB_PANE_DRAG_MIME]))).toBe(
        false
      );
      expect(isPaneDragFromPane(dataTransferWith(['Files']))).toBe(false);
    });
  });

  describe('resolvePaneDrop', () => {
    it('resolves a center drop to a swap', () => {
      expect(resolvePaneDrop('pane-a', 'pane-b', rect, 50, 50)).toEqual({
        kind: 'swap',
        sourcePaneId: 'pane-a',
        targetPaneId: 'pane-b',
      });
    });

    it('resolves an edge drop to a move on that edge', () => {
      expect(resolvePaneDrop('pane-a', 'pane-b', rect, 95, 50)).toEqual({
        kind: 'move',
        sourcePaneId: 'pane-a',
        targetPaneId: 'pane-b',
        edge: 'right',
      });
      expect(resolvePaneDrop('pane-a', 'pane-b', rect, 50, 5)).toEqual({
        kind: 'move',
        sourcePaneId: 'pane-a',
        targetPaneId: 'pane-b',
        edge: 'top',
      });
    });

    it('resolves to "none" for a missing source or a drop onto the source itself', () => {
      expect(resolvePaneDrop(null, 'pane-b', rect, 50, 50)).toEqual({ kind: 'none' });
      expect(resolvePaneDrop('', 'pane-b', rect, 50, 50)).toEqual({ kind: 'none' });
      expect(resolvePaneDrop('pane-b', 'pane-b', rect, 95, 50)).toEqual({ kind: 'none' });
    });
  });

  describe('getDroppedPaneId', () => {
    afterEach(() => setDraggedPaneId(null));

    it('reads the source pane id from the drop payload', () => {
      const dt = dataTransferWith([PANE_DRAG_MIME], { [PANE_DRAG_MIME]: 'pane-a' });
      expect(getDroppedPaneId(dt)).toBe('pane-a');
    });

    it('falls back to module drag state when the payload is empty', () => {
      setDraggedPaneId('pane-fallback');
      expect(getDroppedPaneId(dataTransferWith([PANE_DRAG_MIME]))).toBe('pane-fallback');
    });

    it('prefers the payload over stale module state', () => {
      setDraggedPaneId('stale-pane');
      const dt = dataTransferWith([PANE_DRAG_MIME], { [PANE_DRAG_MIME]: 'pane-a' });
      expect(getDroppedPaneId(dt)).toBe('pane-a');
    });

    it('returns null when neither the payload nor module state has a source', () => {
      expect(getDroppedPaneId(dataTransferWith([PANE_DRAG_MIME]))).toBeNull();
    });
  });

  describe('resolvePaneDropFromEvent', () => {
    afterEach(() => setDraggedPaneId(null));

    it('reads the source pane id from the drop payload', () => {
      const dt = dataTransferWith([PANE_DRAG_MIME], { [PANE_DRAG_MIME]: 'pane-a' });

      expect(resolvePaneDropFromEvent(dt, 'pane-b', rect, 50, 50)).toEqual({
        kind: 'swap',
        sourcePaneId: 'pane-a',
        targetPaneId: 'pane-b',
      });
    });

    it('falls back to module drag state when the payload is empty', () => {
      setDraggedPaneId('pane-a');
      const dt = dataTransferWith([PANE_DRAG_MIME]);

      expect(resolvePaneDropFromEvent(dt, 'pane-b', rect, 95, 50)).toEqual({
        kind: 'move',
        sourcePaneId: 'pane-a',
        targetPaneId: 'pane-b',
        edge: 'right',
      });
    });

    it('prefers the payload over stale module state', () => {
      setDraggedPaneId('stale-pane');
      const dt = dataTransferWith([PANE_DRAG_MIME], { [PANE_DRAG_MIME]: 'pane-a' });

      expect(resolvePaneDropFromEvent(dt, 'pane-b', rect, 50, 50)).toMatchObject({
        sourcePaneId: 'pane-a',
      });
    });

    it('resolves to "none" when neither the payload nor module state has a source', () => {
      const dt = dataTransferWith([PANE_DRAG_MIME]);

      expect(resolvePaneDropFromEvent(dt, 'pane-b', rect, 50, 50)).toEqual({ kind: 'none' });
    });

    it('moves a dragged tab to the nearest edge rather than swapping', () => {
      const dt = dataTransferWith([PANE_DRAG_MIME, TAB_PANE_DRAG_MIME], {
        [PANE_DRAG_MIME]: 'pane-a',
        [TAB_PANE_DRAG_MIME]: 'tab-a',
      });

      expect(resolvePaneDropFromEvent(dt, 'pane-b', rect, 60, 50)).toEqual({
        kind: 'moveTab',
        sourceTabId: 'tab-a',
        targetPaneId: 'pane-b',
        edge: 'right',
      });
    });

    it("resolves a tab dropped onto its own pane to 'none'", () => {
      const dt = dataTransferWith([PANE_DRAG_MIME, TAB_PANE_DRAG_MIME], {
        [PANE_DRAG_MIME]: 'pane-a',
        [TAB_PANE_DRAG_MIME]: 'tab-a',
      });

      expect(resolvePaneDropFromEvent(dt, 'pane-a', rect, 10, 50)).toEqual({ kind: 'none' });
    });
  });
});
