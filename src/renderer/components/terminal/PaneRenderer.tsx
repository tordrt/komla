import { Allotment, type AllotmentHandle } from 'allotment';
import React, { memo, useCallback, useEffect, useRef } from 'react';

import 'allotment/dist/style.css';
import { useLayoutStore } from '@/stores/layout.store';

import { isPaneSurfaceId } from '../../../shared/lib/pane-surface-id';

import { SurfacePane } from './surfaces/SurfacePane';
import { TerminalPane } from './TerminalPane';

import type { LayoutNode } from '@/types';

interface PaneRendererProps {
  node: LayoutNode;
  isTabActive: boolean;
  isLayoutLocked?: boolean;
  workspaceId?: string;
  /** The node is the tab's whole layout: a single pane. */
  isOnlyPane?: boolean;
}

export const PaneRenderer = memo(function PaneRenderer({
  node,
  isTabActive,
  isLayoutLocked = false,
  workspaceId,
  isOnlyPane = false,
}: PaneRendererProps) {
  const updateSizes = useLayoutStore((s) => s.updateSizes);
  const allotmentRef = useRef<AllotmentHandle>(null);
  // The split this Allotment mounted for and the sizes it shows. Allotment reads
  // defaultSizes only when it mounts, so sizes set elsewhere, e.g. on another
  // device, are applied to it here.
  const shown = useRef<{ id: string; sizes?: [number, number] }>({ id: node.id });
  const sizes = node.type === 'split' ? node.sizes : undefined;

  useEffect(() => {
    const previous = shown.current;
    shown.current = { id: node.id, sizes };
    if (!sizes || previous.id !== node.id || !previous.sizes) return;
    if (previous.sizes[0] === sizes[0] && previous.sizes[1] === sizes[1]) return;
    allotmentRef.current?.resize(sizes);
  }, [node.id, sizes]);

  const handleSizeChange = useCallback(
    (sizes: number[]) => {
      if (sizes.length === 2) {
        shown.current = { id: node.id, sizes: [sizes[0], sizes[1]] };
        updateSizes(node.id, [sizes[0], sizes[1]]);
      }
    },
    [updateSizes, node.id]
  );

  if (node.type === 'leaf' && isPaneSurfaceId(node.terminalId)) {
    return (
      <SurfacePane
        paneId={node.id}
        surfaceId={node.terminalId}
        isTabActive={isTabActive}
        isLayoutLocked={isLayoutLocked}
        workspaceId={workspaceId}
        isOnlyPane={isOnlyPane}
      />
    );
  }

  if (node.type === 'leaf') {
    return (
      <TerminalPane
        paneId={node.id}
        terminalId={node.terminalId}
        isTabActive={isTabActive}
        isLayoutLocked={isLayoutLocked}
        workspaceId={workspaceId}
        isOnlyPane={isOnlyPane}
      />
    );
  }

  // Key the Allotment by node.id so a structural collapse (e.g. parent split
  // replaced by a different surviving split) forces a fresh mount instead of
  // reusing internal sash state. Same for each Allotment.Pane: when the child
  // at a position changes identity (split→leaf or split-A→split-B), the
  // subtree must remount so xterm hosts re-attach to the right container.
  return (
    <Allotment
      key={node.id}
      ref={allotmentRef}
      vertical={node.direction === 'horizontal'}
      defaultSizes={node.sizes}
      onDragEnd={handleSizeChange}
    >
      <Allotment.Pane key={node.children[0].id} minSize={100}>
        <PaneRenderer
          node={node.children[0]}
          isTabActive={isTabActive}
          isLayoutLocked={isLayoutLocked}
          workspaceId={workspaceId}
        />
      </Allotment.Pane>
      <Allotment.Pane key={node.children[1].id} minSize={100}>
        <PaneRenderer
          node={node.children[1]}
          isTabActive={isTabActive}
          isLayoutLocked={isLayoutLocked}
          workspaceId={workspaceId}
        />
      </Allotment.Pane>
    </Allotment>
  );
});
