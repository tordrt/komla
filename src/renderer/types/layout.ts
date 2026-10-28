import type { TabRef } from './index';

export type SplitDirection = 'horizontal' | 'vertical';
export type PaneId = string;

export interface LeafPane {
  type: 'leaf';
  id: PaneId;
  terminalId: TabRef; // The terminal ID displayed in this pane
}

export interface SplitPane {
  type: 'split';
  id: PaneId;
  direction: SplitDirection;
  children: [LayoutNode, LayoutNode];
  sizes: [number, number];
}

export type LayoutNode = LeafPane | SplitPane;

// Where a pane is dropped relative to the target pane during drag-and-drop.
// An edge splits the target; 'center' swaps the two panes' terminals.
export type DropEdge = 'left' | 'right' | 'top' | 'bottom';
export type DropZone = DropEdge | 'center';
