import { isPaneSurfaceId } from '../../shared/lib/pane-surface-id';

import type {
  LayoutNode,
  LeafPane,
  SplitPane,
  SplitDirection,
  PaneId,
  DropEdge,
} from '../types/layout';

let paneIdCounter = 0;

export function generatePaneId(): PaneId {
  return `pane-${Date.now()}-${++paneIdCounter}`;
}

export function createLeaf(terminalId: string): LeafPane {
  return {
    type: 'leaf',
    id: generatePaneId(),
    terminalId,
  };
}

export function findNode(root: LayoutNode, paneId: PaneId): LayoutNode | null {
  if (root.id === paneId) return root;
  if (root.type === 'split') {
    return findNode(root.children[0], paneId) || findNode(root.children[1], paneId);
  }
  return null;
}

export function findParent(root: LayoutNode, paneId: PaneId): SplitPane | null {
  if (root.type === 'leaf') return null;

  for (const child of root.children) {
    if (child.id === paneId) return root;
    const found = findParent(child, paneId);
    if (found) return found;
  }
  return null;
}

export function splitLeaf(
  root: LayoutNode,
  paneId: PaneId,
  direction: SplitDirection,
  newTerminalId: string
): LayoutNode {
  return splitLeafAt(root, paneId, direction, newTerminalId, 'after');
}

export function splitLeafAt(
  root: LayoutNode,
  paneId: PaneId,
  direction: SplitDirection,
  newTerminalId: string,
  placement: 'before' | 'after'
): LayoutNode {
  if (root.id === paneId && root.type === 'leaf') {
    const newLeaf = createLeaf(newTerminalId);
    return {
      type: 'split',
      id: generatePaneId(),
      direction,
      children: placement === 'before' ? [newLeaf, root] : [root, newLeaf],
      sizes: [50, 50],
    };
  }

  if (root.type === 'split') {
    return {
      ...root,
      children: [
        splitLeafAt(root.children[0], paneId, direction, newTerminalId, placement),
        splitLeafAt(root.children[1], paneId, direction, newTerminalId, placement),
      ],
    };
  }

  return root;
}

export function removePane(root: LayoutNode, paneId: PaneId): LayoutNode | null {
  if (root.type === 'leaf') {
    return root.id === paneId ? null : root;
  }

  const [left, right] = root.children;

  // If target is a direct child
  if (left.id === paneId) return right;
  if (right.id === paneId) return left;

  // Recursively remove from children
  const newLeft = removePane(left, paneId);
  const newRight = removePane(right, paneId);

  // If one child was removed (became null), return the other
  if (newLeft === null) return newRight;
  if (newRight === null) return newLeft;

  // If neither changed, return as-is
  if (newLeft === left && newRight === right) return root;

  // Return updated split
  return {
    ...root,
    children: [newLeft, newRight],
  };
}

export function getAllLeaves(root: LayoutNode): LeafPane[] {
  if (root.type === 'leaf') return [root];
  return [...getAllLeaves(root.children[0]), ...getAllLeaves(root.children[1])];
}

/** Whether a workspace's tabs show a browser or note pane, which keeps it open without a terminal. */
export function showsPaneSurface(layouts: Record<string, LayoutNode> | undefined): boolean {
  return Object.values(layouts ?? {}).some((root) =>
    getAllLeaves(root).some((leaf) => isPaneSurfaceId(leaf.terminalId))
  );
}

export function findPaneByTerminalId(root: LayoutNode, terminalId: string): LeafPane | null {
  if (root.type === 'leaf') {
    if (root.terminalId === terminalId) {
      return root;
    }
    return null;
  }
  return (
    findPaneByTerminalId(root.children[0], terminalId) ||
    findPaneByTerminalId(root.children[1], terminalId)
  );
}

export function updateSizes(root: LayoutNode, paneId: PaneId, sizes: [number, number]): LayoutNode {
  if (root.id === paneId && root.type === 'split') {
    return { ...root, sizes };
  }

  if (root.type === 'split') {
    return {
      ...root,
      children: [
        updateSizes(root.children[0], paneId, sizes),
        updateSizes(root.children[1], paneId, sizes),
      ],
    };
  }

  return root;
}

export function replaceTerminalInPane(
  root: LayoutNode,
  paneId: PaneId,
  newTerminalId: string
): LayoutNode {
  if (root.id === paneId && root.type === 'leaf') {
    return { ...root, terminalId: newTerminalId };
  }

  if (root.type === 'split') {
    return {
      ...root,
      children: [
        replaceTerminalInPane(root.children[0], paneId, newTerminalId),
        replaceTerminalInPane(root.children[1], paneId, newTerminalId),
      ],
    };
  }

  return root;
}

// Swap the terminals shown in two leaf panes, keeping pane positions and ids.
export function swapTerminals(root: LayoutNode, paneIdA: PaneId, paneIdB: PaneId): LayoutNode {
  if (paneIdA === paneIdB) return root;

  const leafA = findNode(root, paneIdA);
  const leafB = findNode(root, paneIdB);
  if (leafA?.type !== 'leaf' || leafB?.type !== 'leaf') return root;

  return replaceTerminalInPane(
    replaceTerminalInPane(root, paneIdA, leafB.terminalId),
    paneIdB,
    leafA.terminalId
  );
}

// Maps a screen-space drop edge to the split that produces it. NOTE: this
// codebase's SplitDirection is inverted relative to the visual axis — a
// 'vertical' split renders side-by-side and a 'horizontal' split renders
// stacked (see PaneRenderer: `vertical={node.direction === 'horizontal'}`).
// So a left/right drop needs a 'vertical' split; a top/bottom drop needs a
// 'horizontal' one.
const EDGE_SPLIT: Record<DropEdge, { direction: SplitDirection; placement: 'before' | 'after' }> = {
  left: { direction: 'vertical', placement: 'before' },
  right: { direction: 'vertical', placement: 'after' },
  top: { direction: 'horizontal', placement: 'before' },
  bottom: { direction: 'horizontal', placement: 'after' },
};

// Split the target pane to insert a new leaf for the terminal on the given edge.
export function splitLeafAtEdge(
  root: LayoutNode,
  targetPaneId: PaneId,
  newTerminalId: string,
  edge: DropEdge
): LayoutNode {
  const { direction, placement } = EDGE_SPLIT[edge];
  return splitLeafAt(root, targetPaneId, direction, newTerminalId, placement);
}

// Move a pane out of its current position and re-insert it as a new split
// alongside the target pane, on the given edge. Returns the root unchanged if
// the source or target is missing, or if they are the same pane.
export function movePane(
  root: LayoutNode,
  sourcePaneId: PaneId,
  targetPaneId: PaneId,
  edge: DropEdge
): LayoutNode {
  if (sourcePaneId === targetPaneId) return root;

  const source = findNode(root, sourcePaneId);
  const target = findNode(root, targetPaneId);
  if (source?.type !== 'leaf' || target?.type !== 'leaf') return root;

  const withoutSource = removePane(root, sourcePaneId);
  if (withoutSource === null) return root;

  return splitLeafAtEdge(withoutSource, targetPaneId, source.terminalId, edge);
}
