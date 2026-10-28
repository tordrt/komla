import { describe, it, expect } from 'vitest';

import {
  createLeaf,
  findNode,
  findParent,
  splitLeaf,
  splitLeafAt,
  removePane,
  getAllLeaves,
  findPaneByTerminalId,
  updateSizes,
  replaceTerminalInPane,
  swapTerminals,
  movePane,
} from '../../../src/renderer/lib/layout-utils';

import type { LeafPane, SplitPane } from '../../../src/renderer/types/layout';

describe('layout-utils', () => {
  describe('createLeaf', () => {
    it('should create a leaf pane with the given terminal ID', () => {
      const leaf = createLeaf('terminal-1');

      expect(leaf.type).toBe('leaf');
      expect(leaf.terminalId).toBe('terminal-1');
      expect(leaf.id).toMatch(/^pane-\d+-\d+$/);
    });

    it('should generate unique IDs for each leaf', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');

      expect(leaf1.id).not.toBe(leaf2.id);
    });
  });

  describe('findNode', () => {
    it('should find a leaf node by ID', () => {
      const leaf = createLeaf('terminal-1');

      const found = findNode(leaf, leaf.id);

      expect(found).toBe(leaf);
    });

    it('should find a node within a split', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const split: SplitPane = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };

      expect(findNode(split, leaf1.id)).toBe(leaf1);
      expect(findNode(split, leaf2.id)).toBe(leaf2);
      expect(findNode(split, 'split-1')).toBe(split);
    });

    it('should return null for non-existent ID', () => {
      const leaf = createLeaf('terminal-1');

      expect(findNode(leaf, 'non-existent')).toBeNull();
    });

    it('should find nodes in nested splits', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const leaf3 = createLeaf('terminal-3');
      const innerSplit: SplitPane = {
        type: 'split',
        id: 'inner-split',
        direction: 'horizontal',
        children: [leaf2, leaf3],
        sizes: [50, 50],
      };
      const outerSplit: SplitPane = {
        type: 'split',
        id: 'outer-split',
        direction: 'vertical',
        children: [leaf1, innerSplit],
        sizes: [50, 50],
      };

      expect(findNode(outerSplit, leaf3.id)).toBe(leaf3);
      expect(findNode(outerSplit, 'inner-split')).toBe(innerSplit);
    });
  });

  describe('findParent', () => {
    it('should return null for a leaf with no parent', () => {
      const leaf = createLeaf('terminal-1');

      expect(findParent(leaf, leaf.id)).toBeNull();
    });

    it('should find the parent split of a leaf', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const split: SplitPane = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };

      expect(findParent(split, leaf1.id)).toBe(split);
      expect(findParent(split, leaf2.id)).toBe(split);
    });

    it('should find parent in nested structure', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const leaf3 = createLeaf('terminal-3');
      const innerSplit: SplitPane = {
        type: 'split',
        id: 'inner-split',
        direction: 'horizontal',
        children: [leaf2, leaf3],
        sizes: [50, 50],
      };
      const outerSplit: SplitPane = {
        type: 'split',
        id: 'outer-split',
        direction: 'vertical',
        children: [leaf1, innerSplit],
        sizes: [50, 50],
      };

      expect(findParent(outerSplit, leaf2.id)).toBe(innerSplit);
      expect(findParent(outerSplit, innerSplit.id)).toBe(outerSplit);
    });
  });

  describe('splitLeaf', () => {
    it('should split a leaf horizontally', () => {
      const leaf = createLeaf('terminal-1');

      const result = splitLeaf(leaf, leaf.id, 'horizontal', 'terminal-2');

      expect(result.type).toBe('split');
      const split = result as SplitPane;
      expect(split.direction).toBe('horizontal');
      expect(split.children[0]).toBe(leaf);
      expect(split.children[1].type).toBe('leaf');
      expect((split.children[1] as LeafPane).terminalId).toBe('terminal-2');
      expect(split.sizes).toEqual([50, 50]);
    });

    it('should split a leaf vertically', () => {
      const leaf = createLeaf('terminal-1');

      const result = splitLeaf(leaf, leaf.id, 'vertical', 'terminal-2');

      expect(result.type).toBe('split');
      const split = result as SplitPane;
      expect(split.direction).toBe('vertical');
    });

    it('should split a nested leaf', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const split: SplitPane = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };

      const result = splitLeaf(split, leaf2.id, 'vertical', 'terminal-3');

      expect(result.type).toBe('split');
      const rootSplit = result as SplitPane;
      expect(rootSplit.children[0]).toBe(leaf1);
      expect(rootSplit.children[1].type).toBe('split');
      const innerSplit = rootSplit.children[1] as SplitPane;
      expect(innerSplit.direction).toBe('vertical');
      expect((innerSplit.children[0] as LeafPane).terminalId).toBe('terminal-2');
      expect((innerSplit.children[1] as LeafPane).terminalId).toBe('terminal-3');
    });

    it('should return unchanged if pane ID not found', () => {
      const leaf = createLeaf('terminal-1');

      const result = splitLeaf(leaf, 'non-existent', 'horizontal', 'terminal-2');

      expect(result).toBe(leaf);
    });
  });

  describe('splitLeafAt', () => {
    it('places the new leaf after the target with placement "after"', () => {
      const leaf = createLeaf('terminal-1');

      const result = splitLeafAt(leaf, leaf.id, 'horizontal', 'terminal-2', 'after');

      const split = result as SplitPane;
      expect(split.children[0]).toBe(leaf);
      expect((split.children[1] as LeafPane).terminalId).toBe('terminal-2');
    });

    it('places the new leaf before the target with placement "before"', () => {
      const leaf = createLeaf('terminal-1');

      const result = splitLeafAt(leaf, leaf.id, 'vertical', 'terminal-2', 'before');

      const split = result as SplitPane;
      expect((split.children[0] as LeafPane).terminalId).toBe('terminal-2');
      expect(split.children[1]).toBe(leaf);
      expect(split.direction).toBe('vertical');
    });

    it('splits a nested leaf', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const split: SplitPane = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };

      const result = splitLeafAt(split, leaf2.id, 'vertical', 'terminal-3', 'before') as SplitPane;

      expect(result.children[0]).toBe(leaf1);
      const inner = result.children[1] as SplitPane;
      expect((inner.children[0] as LeafPane).terminalId).toBe('terminal-3');
      expect((inner.children[1] as LeafPane).terminalId).toBe('terminal-2');
    });

    it('returns unchanged if pane ID not found', () => {
      const leaf = createLeaf('terminal-1');

      expect(splitLeafAt(leaf, 'missing', 'horizontal', 'terminal-2', 'after')).toBe(leaf);
    });
  });

  describe('swapTerminals', () => {
    it('swaps the terminals of two leaves, preserving pane ids', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const split: SplitPane = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };

      const result = swapTerminals(split, leaf1.id, leaf2.id) as SplitPane;

      expect(result.children[0].id).toBe(leaf1.id);
      expect(result.children[1].id).toBe(leaf2.id);
      expect((result.children[0] as LeafPane).terminalId).toBe('terminal-2');
      expect((result.children[1] as LeafPane).terminalId).toBe('terminal-1');
    });

    it('swaps leaves across nested splits', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const leaf3 = createLeaf('terminal-3');
      const inner: SplitPane = {
        type: 'split',
        id: 'inner',
        direction: 'horizontal',
        children: [leaf2, leaf3],
        sizes: [50, 50],
      };
      const outer: SplitPane = {
        type: 'split',
        id: 'outer',
        direction: 'vertical',
        children: [leaf1, inner],
        sizes: [50, 50],
      };

      const result = swapTerminals(outer, leaf1.id, leaf3.id) as SplitPane;

      expect((result.children[0] as LeafPane).terminalId).toBe('terminal-3');
      const resultInner = result.children[1] as SplitPane;
      expect((resultInner.children[1] as LeafPane).terminalId).toBe('terminal-1');
    });

    it('returns the root unchanged when swapping a pane with itself', () => {
      const leaf = createLeaf('terminal-1');

      expect(swapTerminals(leaf, leaf.id, leaf.id)).toBe(leaf);
    });

    it('returns the root unchanged if a pane is missing', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const split: SplitPane = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };

      expect(swapTerminals(split, leaf1.id, 'missing')).toBe(split);
    });
  });

  describe('movePane', () => {
    it('moves a pane onto the right edge of a sibling', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const leaf3 = createLeaf('terminal-3');
      const root: SplitPane = {
        type: 'split',
        id: 'root',
        direction: 'vertical',
        children: [
          leaf1,
          {
            type: 'split',
            id: 'inner',
            direction: 'horizontal',
            children: [leaf2, leaf3],
            sizes: [50, 50],
          },
        ],
        sizes: [50, 50],
      };

      // Move leaf1 to the right of leaf2.
      const result = movePane(root, leaf1.id, leaf2.id, 'right') as SplitPane;

      // leaf1 removed from the top — root collapses to the inner split.
      expect(result.id).toBe('inner');
      const newSplit = result.children[0] as SplitPane;
      expect(newSplit.type).toBe('split');
      // A left/right drop renders side-by-side, which is a 'vertical' split in
      // this codebase's inverted SplitDirection convention.
      expect(newSplit.direction).toBe('vertical');
      expect((newSplit.children[0] as LeafPane).terminalId).toBe('terminal-2');
      expect((newSplit.children[1] as LeafPane).terminalId).toBe('terminal-1');
    });

    it('moves a pane onto the top edge of a sibling (stacked, before)', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const root: SplitPane = {
        type: 'split',
        id: 'root',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };

      const result = movePane(root, leaf1.id, leaf2.id, 'top') as SplitPane;

      // A top/bottom drop renders stacked, which is a 'horizontal' split here.
      expect(result.direction).toBe('horizontal');
      expect((result.children[0] as LeafPane).terminalId).toBe('terminal-1');
      expect((result.children[1] as LeafPane).terminalId).toBe('terminal-2');
    });

    it('returns the root unchanged when source and target are the same', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const root: SplitPane = {
        type: 'split',
        id: 'root',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };

      expect(movePane(root, leaf1.id, leaf1.id, 'right')).toBe(root);
    });

    it('returns the root unchanged if the target is missing', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const root: SplitPane = {
        type: 'split',
        id: 'root',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };

      expect(movePane(root, leaf1.id, 'missing', 'right')).toBe(root);
    });
  });

  describe('removePane', () => {
    it('should return null when removing the only leaf', () => {
      const leaf = createLeaf('terminal-1');

      expect(removePane(leaf, leaf.id)).toBeNull();
    });

    it('should return the other leaf when removing from a split', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const split: SplitPane = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };

      expect(removePane(split, leaf1.id)).toBe(leaf2);
      expect(removePane(split, leaf2.id)).toBe(leaf1);
    });

    it('should handle nested removal correctly', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const leaf3 = createLeaf('terminal-3');
      const innerSplit: SplitPane = {
        type: 'split',
        id: 'inner-split',
        direction: 'horizontal',
        children: [leaf2, leaf3],
        sizes: [50, 50],
      };
      const outerSplit: SplitPane = {
        type: 'split',
        id: 'outer-split',
        direction: 'vertical',
        children: [leaf1, innerSplit],
        sizes: [50, 50],
      };

      const result = removePane(outerSplit, leaf2.id);

      expect(result).not.toBeNull();
      const resultSplit = result as SplitPane;
      expect(resultSplit.children[0]).toBe(leaf1);
      expect(resultSplit.children[1]).toBe(leaf3);
    });

    it('should return unchanged if pane ID not found', () => {
      const leaf = createLeaf('terminal-1');

      expect(removePane(leaf, 'non-existent')).toBe(leaf);
    });

    // Regression: the layouts produced here drove a UI bug where Allotment's
    // internal sash state got reused across structural collapses. The fix is
    // in PaneRenderer (keying by node.id); these assertions pin the shapes
    // PaneRenderer must handle so the test is meaningful even if rendering
    // stays mocked elsewhere.
    it('promotes the surviving sibling split to root when a direct-child leaf is removed', () => {
      const leafA = createLeaf('terminal-A');
      const leafB = createLeaf('terminal-B');
      const leafC = createLeaf('terminal-C');
      const innerSplit: SplitPane = {
        type: 'split',
        id: 'inner-split',
        direction: 'horizontal',
        children: [leafB, leafC],
        sizes: [50, 50],
      };
      const outerSplit: SplitPane = {
        type: 'split',
        id: 'outer-split',
        direction: 'vertical',
        children: [leafA, innerSplit],
        sizes: [60, 40],
      };

      // Close A — outer split must collapse into innerSplit, not wrap it.
      const result = removePane(outerSplit, leafA.id);

      expect(result).toBe(innerSplit);
      expect((result as SplitPane).id).toBe('inner-split');
      expect((result as SplitPane).children).toEqual([leafB, leafC]);
    });

    it('collapses a nested split when one of its leaves is removed without disturbing siblings', () => {
      const leafA = createLeaf('terminal-A');
      const leafB = createLeaf('terminal-B');
      const leafC = createLeaf('terminal-C');
      const leafD = createLeaf('terminal-D');
      const innermost: SplitPane = {
        type: 'split',
        id: 'innermost',
        direction: 'horizontal',
        children: [leafC, leafD],
        sizes: [50, 50],
      };
      const middle: SplitPane = {
        type: 'split',
        id: 'middle',
        direction: 'vertical',
        children: [leafB, innermost],
        sizes: [50, 50],
      };
      const root: SplitPane = {
        type: 'split',
        id: 'root',
        direction: 'horizontal',
        children: [leafA, middle],
        sizes: [50, 50],
      };

      // Close C: innermost collapses to leafD; middle and root keep their identity.
      const result = removePane(root, leafC.id);

      expect(result).not.toBeNull();
      const resultSplit = result as SplitPane;
      expect(resultSplit.id).toBe('root');
      expect(resultSplit.children[0]).toBe(leafA);
      const newMiddle = resultSplit.children[1] as SplitPane;
      expect(newMiddle.id).toBe('middle');
      expect(newMiddle.children[0]).toBe(leafB);
      expect(newMiddle.children[1]).toBe(leafD);
    });
  });

  describe('getAllLeaves', () => {
    it('should return single leaf in array', () => {
      const leaf = createLeaf('terminal-1');

      const leaves = getAllLeaves(leaf);

      expect(leaves).toHaveLength(1);
      expect(leaves[0]).toBe(leaf);
    });

    it('should return all leaves from a split', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const split: SplitPane = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };

      const leaves = getAllLeaves(split);

      expect(leaves).toHaveLength(2);
      expect(leaves).toContain(leaf1);
      expect(leaves).toContain(leaf2);
    });

    it('should return all leaves from nested splits', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const leaf3 = createLeaf('terminal-3');
      const innerSplit: SplitPane = {
        type: 'split',
        id: 'inner-split',
        direction: 'horizontal',
        children: [leaf2, leaf3],
        sizes: [50, 50],
      };
      const outerSplit: SplitPane = {
        type: 'split',
        id: 'outer-split',
        direction: 'vertical',
        children: [leaf1, innerSplit],
        sizes: [50, 50],
      };

      const leaves = getAllLeaves(outerSplit);

      expect(leaves).toHaveLength(3);
      expect(leaves).toContain(leaf1);
      expect(leaves).toContain(leaf2);
      expect(leaves).toContain(leaf3);
    });
  });

  describe('findPaneByTerminalId', () => {
    it('should find a leaf by terminal ID', () => {
      const leaf = createLeaf('terminal-1');

      expect(findPaneByTerminalId(leaf, 'terminal-1')).toBe(leaf);
    });

    it('should return null if terminal ID not found', () => {
      const leaf = createLeaf('terminal-1');

      expect(findPaneByTerminalId(leaf, 'terminal-2')).toBeNull();
    });

    it('should find leaf in nested structure', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const split: SplitPane = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };

      expect(findPaneByTerminalId(split, 'terminal-2')).toBe(leaf2);
    });
  });

  describe('updateSizes', () => {
    it('should update sizes of a split pane', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const split: SplitPane = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };

      const result = updateSizes(split, 'split-1', [30, 70]);

      expect(result.type).toBe('split');
      expect((result as SplitPane).sizes).toEqual([30, 70]);
    });

    it('should not modify leaf nodes', () => {
      const leaf = createLeaf('terminal-1');

      const result = updateSizes(leaf, leaf.id, [30, 70]);

      expect(result).toBe(leaf);
    });

    it('should update nested split sizes', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const innerSplit: SplitPane = {
        type: 'split',
        id: 'inner-split',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };
      const outerSplit: SplitPane = {
        type: 'split',
        id: 'outer-split',
        direction: 'vertical',
        children: [innerSplit, createLeaf('terminal-3')],
        sizes: [50, 50],
      };

      const result = updateSizes(outerSplit, 'inner-split', [25, 75]);

      const updatedInner = (result as SplitPane).children[0] as SplitPane;
      expect(updatedInner.sizes).toEqual([25, 75]);
    });
  });

  describe('replaceTerminalInPane', () => {
    it('should replace terminal ID in a leaf', () => {
      const leaf = createLeaf('terminal-1');

      const result = replaceTerminalInPane(leaf, leaf.id, 'terminal-new');

      expect(result.type).toBe('leaf');
      expect((result as LeafPane).terminalId).toBe('terminal-new');
      expect((result as LeafPane).id).toBe(leaf.id);
    });

    it('should not modify non-matching leaves', () => {
      const leaf = createLeaf('terminal-1');

      const result = replaceTerminalInPane(leaf, 'other-id', 'terminal-new');

      expect(result).toBe(leaf);
    });

    it('should replace terminal in nested structure', () => {
      const leaf1 = createLeaf('terminal-1');
      const leaf2 = createLeaf('terminal-2');
      const split: SplitPane = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        children: [leaf1, leaf2],
        sizes: [50, 50],
      };

      const result = replaceTerminalInPane(split, leaf2.id, 'terminal-new');

      const resultSplit = result as SplitPane;
      expect((resultSplit.children[0] as LeafPane).terminalId).toBe('terminal-1');
      expect((resultSplit.children[1] as LeafPane).terminalId).toBe('terminal-new');
    });
  });
});
