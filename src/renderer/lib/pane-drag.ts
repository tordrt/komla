import type { DropEdge, DropZone } from '../types/layout';

// Custom drag MIME type for pane drags, so they never collide with tab drags
// (TerminalTabs) or OS file drags.
export const PANE_DRAG_MIME = 'application/x-komla-pane';

// Marks a pane drag that began on a tab holding only that pane, and carries that tab's id. The
// pane lives in another tab than the one shown, so there's no pane of its own to swap with: its
// drops land on an edge.
export const TAB_PANE_DRAG_MIME = 'application/x-komla-tab-pane';

// The id of the pane currently being dragged. dataTransfer payloads can't be
// read during `dragover` (only on `drop`), so the hovered pane needs this to
// know whether it's the drag source and skip its own drop highlight.
let draggedPaneId: string | null = null;

export function setDraggedPaneId(id: string | null): void {
  draggedPaneId = id;
}

export function getDraggedPaneId(): string | null {
  return draggedPaneId;
}

// True when a drag carries a pane payload. `dataTransfer.getData` is blocked
// during `dragover`, but `types` is readable — so this is the reliable gate
// for "is this actually a pane drag", independent of the module-level id
// (which can go stale if a `dragend` is missed after a layout reflow).
export function isPaneDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(PANE_DRAG_MIME);
}

export function isTabPaneDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(TAB_PANE_DRAG_MIME);
}

// True for a pane dragged by its grip or header, which a tab can take in; a dragged tab reorders.
export function isPaneDragFromPane(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types);
  return types.includes(PANE_DRAG_MIME) && !types.includes(TAB_PANE_DRAG_MIME);
}

// Classify a pointer position over a pane into a drop zone: the inner 40% is
// 'center' (swap), the outer bands resolve to the nearest edge (split). With `edgesOnly`, the
// whole pane resolves to its nearest edge.
export function getDropZone(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  { edgesOnly = false }: { edgesOnly?: boolean } = {}
): DropZone {
  const fx = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
  const fy = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;

  if (!edgesOnly && fx >= 0.3 && fx <= 0.7 && fy >= 0.3 && fy <= 0.7) return 'center';

  const distances: Record<DropEdge, number> = {
    left: fx,
    right: 1 - fx,
    top: fy,
    bottom: 1 - fy,
  };
  let best: DropEdge = 'left';
  for (const edge of ['right', 'top', 'bottom'] as DropEdge[]) {
    if (distances[edge] < distances[best]) best = edge;
  }
  return best;
}

// The layout action a completed pane drop resolves to.
export type PaneDropAction =
  | { kind: 'none' }
  | { kind: 'swap'; sourcePaneId: string; targetPaneId: string }
  | { kind: 'move'; sourcePaneId: string; targetPaneId: string; edge: DropEdge }
  | { kind: 'moveTab'; sourceTabId: string; targetPaneId: string; edge: DropEdge };

// Decide what a drop does, given the source pane id (from the drop payload),
// the target pane, and the pointer position over it. A center drop swaps the
// two panes; an edge drop moves the source alongside the target. A missing
// source, or a drop onto the source itself, resolves to 'none'. Pure so the
// renderer's drop handler can be exercised without mounting a component.
export function resolvePaneDrop(
  sourcePaneId: string | null,
  targetPaneId: string,
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  options: { edgesOnly?: boolean } = {}
): PaneDropAction {
  if (!sourcePaneId || sourcePaneId === targetPaneId) return { kind: 'none' };
  const zone = getDropZone(rect, clientX, clientY, options);
  if (zone === 'center') {
    return { kind: 'swap', sourcePaneId, targetPaneId };
  }
  return { kind: 'move', sourcePaneId, targetPaneId, edge: zone };
}

// The dragged pane's id, read from a completed drop event. The drop payload is
// the authoritative source — `getData` IS readable on `drop` (unlike
// `dragover`) — falling back to module state only if the payload is empty.
export function getDroppedPaneId(dataTransfer: DataTransfer): string | null {
  return dataTransfer.getData(PANE_DRAG_MIME) || getDraggedPaneId();
}

// Resolve a completed drop event into a layout action. A dragged tab moves as a whole, so its
// edge drop names the tab rather than its pane.
export function resolvePaneDropFromEvent(
  dataTransfer: DataTransfer,
  targetPaneId: string,
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number
): PaneDropAction {
  const sourceTabId = isTabPaneDrag(dataTransfer) ? dataTransfer.getData(TAB_PANE_DRAG_MIME) : null;
  const action = resolvePaneDrop(
    getDroppedPaneId(dataTransfer),
    targetPaneId,
    rect,
    clientX,
    clientY,
    { edgesOnly: sourceTabId !== null }
  );
  if (sourceTabId === null || action.kind !== 'move') return action;
  if (!sourceTabId) return { kind: 'none' };
  return { kind: 'moveTab', sourceTabId, targetPaneId, edge: action.edge };
}
