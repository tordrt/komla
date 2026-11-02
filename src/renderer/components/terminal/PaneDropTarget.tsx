import React, { useCallback, useMemo, useState } from 'react';

import { useDraggedPaneId } from '@/hooks/useDraggedPaneId';
import {
  getDraggedPaneId,
  getDropZone,
  isPaneDrag,
  isTabPaneDrag,
  resolvePaneDropFromEvent,
} from '@/lib/pane-drag';
import { useLayoutStore } from '@/stores/layout.store';
import { useTerminalCloseStore } from '@/stores/terminal-close.store';

import type { DropZone } from '@/types';

interface PaneDropTargetOptions {
  paneId: string;
  paneRef: React.RefObject<HTMLElement | null>;
  disabled: boolean;
}

interface PaneDropTarget {
  /** Spread on the pane's root, which `paneRef` points at, or on a layer that covers it. */
  dropTargetProps: Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>;
  /** Where a pane dragged over this one would land, drawn inside the pane's root. */
  dropIndicator: React.ReactNode;
}

/** Lets a pane take another pane, or a tab holding one, dropped on it: swapped in its middle, or moved beside it near an edge. */
export function usePaneDropTarget({
  paneId,
  paneRef,
  disabled,
}: PaneDropTargetOptions): PaneDropTarget {
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const swapPanes = useLayoutStore((s) => s.swapPanes);
  const movePaneToEdge = useLayoutStore((s) => s.movePaneToEdge);
  const moveTabToEdge = useLayoutStore((s) => s.moveTabToEdge);

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      // Ignore non-pane drags (e.g. OS file drops) and hovering the drag
      // source itself. The MIME check is the real gate — getDraggedPaneId()
      // can be stale if a `dragend` was missed after a layout reflow.
      if (disabled || !isPaneDrag(e.dataTransfer)) return;
      const source = getDraggedPaneId();
      if (!source || source === paneId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = paneRef.current?.getBoundingClientRect();
      if (!rect) return;
      // dragover fires continuously; skip the state update unless the zone
      // actually changed so hovering within one zone doesn't churn React.
      const zone = getDropZone(rect, e.clientX, e.clientY, {
        edgesOnly: isTabPaneDrag(e.dataTransfer),
      });
      setDropZone((prev) => (prev === zone ? prev : zone));
    },
    [disabled, paneId, paneRef]
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      // dragleave also fires when crossing into a child element — only clear
      // when the pointer has actually left the pane.
      if (e.relatedTarget instanceof Node && paneRef.current?.contains(e.relatedTarget)) return;
      setDropZone(null);
    },
    [paneRef]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      setDropZone(null);
      if (disabled || !isPaneDrag(e.dataTransfer)) return;
      e.preventDefault();
      const rect = paneRef.current?.getBoundingClientRect();
      const action = rect
        ? resolvePaneDropFromEvent(e.dataTransfer, paneId, rect, e.clientX, e.clientY)
        : null;
      if (action?.kind === 'swap') {
        swapPanes(action.sourcePaneId, action.targetPaneId);
      } else if (action?.kind === 'move') {
        movePaneToEdge(action.sourcePaneId, action.targetPaneId, action.edge);
      } else if (action?.kind === 'moveTab') {
        // The tab was checked for a pending close when its drag began; one may have started since.
        const { layoutsByTab, currentWorkspaceId: layoutWorkspaceId } = useLayoutStore.getState();
        const sourceLayout = layoutWorkspaceId
          ? layoutsByTab[layoutWorkspaceId]?.[action.sourceTabId]
          : undefined;
        const closingIds = useTerminalCloseStore.getState().closingTerminalIds;
        if (sourceLayout?.type === 'leaf' && !closingIds.has(sourceLayout.terminalId)) {
          moveTabToEdge(action.sourceTabId, action.targetPaneId, action.edge);
        }
      }
    },
    [disabled, paneId, paneRef, swapPanes, movePaneToEdge, moveTabToEdge]
  );

  // Style for the edge-drop indicator rail — a thin bar on the target's edge,
  // not a filled half-pane. movePane removes the dragged pane first, which
  // reflows the whole split tree, so a half-pane preview would lie about the
  // final geometry. The rail only claims "inserted on this side", which stays
  // true through the reflow.
  const edgeRailStyle = useMemo((): React.CSSProperties | null => {
    switch (dropZone) {
      case 'left':
        return { left: 0, top: 0, bottom: 0, width: 4 };
      case 'right':
        return { right: 0, top: 0, bottom: 0, width: 4 };
      case 'top':
        return { left: 0, right: 0, top: 0, height: 4 };
      case 'bottom':
        return { left: 0, right: 0, bottom: 0, height: 4 };
      default:
        return null;
    }
  }, [dropZone]);

  const dropTargetProps = { onDragOver, onDragLeave, onDrop };

  const dropIndicator =
    dropZone === 'center' ? (
      <div
        data-pane-drop-indicator="center"
        className="pointer-events-none absolute inset-0 z-20 rounded-sm border-2 border-primary bg-primary/20"
      />
    ) : edgeRailStyle ? (
      <div data-pane-drop-indicator={dropZone} className="contents">
        <div className="pointer-events-none absolute inset-0 z-20 rounded-sm border-2 border-primary/40" />
        <div
          className="pointer-events-none absolute z-20 rounded-full bg-primary"
          style={edgeRailStyle}
        />
      </div>
    ) : null;

  return { dropTargetProps, dropIndicator };
}

/**
 * Lets a pane whose content would take a drag of its own, such as an editor or a file's preview
 * frame, take a dropped pane instead: while another pane is dragged, a layer over the content
 * takes the drop. It covers a locked pane too, refusing the drop, so the content never offers to
 * take a pane.
 */
export function PaneDropLayer(options: PaneDropTargetOptions) {
  const draggedPaneId = useDraggedPaneId();
  if (draggedPaneId === null || draggedPaneId === options.paneId) return null;
  return <PaneDropCatcher {...options} />;
}

function PaneDropCatcher(options: PaneDropTargetOptions) {
  const { dropTargetProps, dropIndicator } = usePaneDropTarget(options);
  return (
    <>
      <div data-pane-drop-catcher className="absolute inset-0 z-30" {...dropTargetProps} />
      {dropIndicator}
    </>
  );
}
