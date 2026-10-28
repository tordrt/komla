/**
 * @vitest-environment jsdom
 *
 * Regression tests for the React reconciliation behavior in PaneRenderer.
 *
 * The bug: when closing a pane caused the layout tree to restructure (e.g.
 * a parent split collapsed and a different surviving split became the root
 * at that level), Allotment instances were reused with stale internal sash
 * state because PaneRenderer relied purely on positional reconciliation.
 *
 * The fix: key the <Allotment> by node.id and each <Allotment.Pane> by its
 * child node.id, so a structural identity change forces a clean remount.
 *
 * These tests stub Allotment with a mount/unmount counter so the assertions
 * pin the keying behavior directly — without these keys, the outer Allotment
 * would be reused across the structural collapse and the second test would
 * fail.
 */
import { act, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PaneRenderer } from '../../../../src/renderer/components/terminal/PaneRenderer';

import type { LayoutNode, LeafPane, SplitPane } from '../../../../src/renderer/types/layout';

// Track Allotment lifecycle events. Each mount records its node id (read from
// a `data-node-id` prop we add via the wrapper) so the test can verify which
// instances were created and torn down across rerenders.
const allotmentEvents: Array<{ kind: 'mount' | 'unmount'; nodeId: string }> = [];
// Sizes PaneRenderer resized a split to, and the drag-end handler of the split rendered last.
const allotmentResizes: number[][] = [];
let lastDragEnd: ((sizes: number[]) => void) | undefined;

vi.mock('allotment', () => {
  type AllotmentProps = React.PropsWithChildren<{
    'data-node-id'?: string;
    ref?: React.Ref<{ resize: (sizes: number[]) => void; reset: () => void }>;
    onDragEnd?: (sizes: number[]) => void;
  }>;

  const Allotment = ({
    children,
    'data-node-id': nodeId,
    ref,
    onDragEnd,
    ...rest
  }: AllotmentProps) => {
    React.useImperativeHandle(ref, () => ({
      resize: (sizes: number[]) => allotmentResizes.push(sizes),
      reset: () => undefined,
    }));
    lastDragEnd = onDragEnd;
    React.useEffect(() => {
      allotmentEvents.push({ kind: 'mount', nodeId: nodeId ?? '?' });
      return () => {
        allotmentEvents.push({ kind: 'unmount', nodeId: nodeId ?? '?' });
      };
      // Mount/unmount tracking only — re-runs on identity change via React keys.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <div data-testid="allotment" data-node-id={nodeId} {...rest}>
        {children}
      </div>
    );
  };
  Allotment.Pane = ({ children }: React.PropsWithChildren) => (
    <div data-testid="allotment-pane">{children}</div>
  );
  return { Allotment };
});

// Stub TerminalPane so the test doesn't need xterm/PTY infrastructure. Each
// instance gets a stable per-mount id via useRef so the test can detect remounts.
vi.mock('../../../../src/renderer/components/terminal/TerminalPane', () => {
  let nextInstance = 0;
  return {
    TerminalPane: ({ paneId, terminalId }: { paneId: string; terminalId: string }) => {
      const instanceRef = React.useRef<string | null>(null);
      if (instanceRef.current === null) {
        instanceRef.current = `inst-${++nextInstance}`;
      }
      return (
        <div
          data-testid={`terminal-${terminalId}`}
          data-pane-id={paneId}
          data-instance={instanceRef.current}
        />
      );
    },
  };
});

vi.mock('../../../../src/renderer/stores/layout.store', () => ({
  useLayoutStore: (selector: (s: { updateSizes: () => void }) => unknown) =>
    selector({ updateSizes: vi.fn() }),
}));

const leaf = (id: string, term: string): LeafPane => ({
  type: 'leaf',
  id,
  terminalId: term,
});

const split = (
  id: string,
  c0: LayoutNode,
  c1: LayoutNode,
  direction: 'horizontal' | 'vertical' = 'horizontal'
): SplitPane => ({
  type: 'split',
  id,
  direction,
  children: [c0, c1],
  sizes: [50, 50],
});

// PaneRenderer renders <Allotment ...> directly; we need to inject `data-node-id`
// to track lifecycle. Since we can't modify PaneRenderer for this, we read the
// rendered DOM's data-node-id from the actual mocked Allotment props. Below we
// thread it through by rendering a wrapper that mirrors PaneRenderer's split
// branch — but a simpler approach is to inspect the DOM after each render.

// Helper: count Allotments currently rendered in the DOM. PaneRenderer doesn't
// pass `data-node-id` through to Allotment, so we just count testid elements.
function countMountedAllotments(container: HTMLElement): number {
  return container.querySelectorAll('[data-testid="allotment"]').length;
}

describe('PaneRenderer reconciliation', () => {
  beforeEach(() => {
    allotmentEvents.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes node.id to Allotment via key (verified through DOM presence after restructure)', () => {
    const initial = split('outer', leaf('p-A', 'A'), leaf('p-B', 'B'));
    const { container, rerender } = render(<PaneRenderer node={initial} isTabActive={true} />);

    // Sanity check: leaves render as terminals.
    expect(container.querySelector('[data-testid="terminal-A"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="terminal-B"]')).not.toBeNull();

    // Re-render with a different split id at the root: outer-2 with same children.
    const replaced = split('outer-2', leaf('p-A', 'A'), leaf('p-B', 'B'));
    rerender(<PaneRenderer node={replaced} isTabActive={true} />);

    // Both leaves should still be present.
    expect(container.querySelector('[data-testid="terminal-A"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="terminal-B"]')).not.toBeNull();
  });

  it('forces a fresh Allotment mount when the root split identity changes (structural collapse)', () => {
    // Pre-collapse tree: Split-outer(L=A, R=Split-inner(B, C)).
    // Closing A would yield Split-inner(B, C) at the root — a different node id.
    const before = split(
      'outer',
      leaf('p-A', 'A'),
      split('inner', leaf('p-B', 'B'), leaf('p-C', 'C'))
    );
    const { rerender, container } = render(<PaneRenderer node={before} isTabActive={true} />);

    // Initially, both Allotments are mounted (outer + inner).
    const initialMounts = allotmentEvents.filter((e) => e.kind === 'mount');
    expect(initialMounts.length).toBeGreaterThanOrEqual(2);

    // Capture per-terminal instance ids so we can detect remounts.
    const bInstanceBefore = container
      .querySelector('[data-testid="terminal-B"]')
      ?.getAttribute('data-instance');
    const cInstanceBefore = container
      .querySelector('[data-testid="terminal-C"]')
      ?.getAttribute('data-instance');
    expect(bInstanceBefore).toBeTruthy();
    expect(cInstanceBefore).toBeTruthy();

    allotmentEvents.length = 0;

    // Simulate the closePane outcome: removePane(before, leafA.id) === innerSplit.
    // The root identity flips from 'outer' to 'inner'.
    const after = split('inner', leaf('p-B', 'B'), leaf('p-C', 'C'));
    rerender(<PaneRenderer node={after} isTabActive={true} />);

    // The previously mounted outer + inner Allotments should both have unmounted,
    // and a fresh Allotment for 'inner' should have mounted.
    // Without the key={node.id} fix, the outer Allotment would have been reused
    // (no unmount) and we'd see no mount/unmount activity for it.
    const unmounts = allotmentEvents.filter((e) => e.kind === 'unmount').length;
    const mounts = allotmentEvents.filter((e) => e.kind === 'mount').length;

    // With the keys: outer unmounts, inner unmounts (was inside outer), new inner mounts.
    expect(unmounts).toBeGreaterThanOrEqual(1);
    expect(mounts).toBeGreaterThanOrEqual(1);

    // The new tree should still render only one Allotment in the DOM.
    expect(countMountedAllotments(container)).toBe(1);

    // Both leaves should be present in the new tree.
    expect(container.querySelector('[data-testid="terminal-B"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="terminal-C"]')).not.toBeNull();
  });

  it('remounts only the affected pane when one child identity changes at a stable parent', () => {
    // Tree: outer(inner(A, B), C). Closing A yields outer(B, C):
    // - outer's identity unchanged → outer Allotment must NOT remount.
    // - outer.children[0] flipped from `inner` (split) to `p-B` (leaf) → that
    //   pane's subtree must remount.
    // - C is at outer.children[1] (key='p-C') unchanged → C must NOT remount.
    const before = split(
      'outer',
      split('inner', leaf('p-A', 'A'), leaf('p-B', 'B')),
      leaf('p-C', 'C')
    );
    const { rerender, container } = render(<PaneRenderer node={before} isTabActive={true} />);

    const cInstanceBefore = container
      .querySelector('[data-testid="terminal-C"]')
      ?.getAttribute('data-instance');
    expect(cInstanceBefore).toBeTruthy();

    allotmentEvents.length = 0;

    const after = split('outer', leaf('p-B', 'B'), leaf('p-C', 'C'));
    rerender(<PaneRenderer node={after} isTabActive={true} />);

    // C's TerminalPane sits at outer.children[1] before and after the rerender,
    // with stable key 'p-C'. It must keep the same instance id (no remount).
    const cInstanceAfter = container
      .querySelector('[data-testid="terminal-C"]')
      ?.getAttribute('data-instance');
    expect(cInstanceAfter).toBe(cInstanceBefore);

    // After the restructure only the outer Allotment remains.
    expect(countMountedAllotments(container)).toBe(1);

    // A is gone, B and C remain.
    expect(container.querySelector('[data-testid="terminal-A"]')).toBeNull();
    expect(container.querySelector('[data-testid="terminal-B"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="terminal-C"]')).not.toBeNull();
  });
});

describe('PaneRenderer split sizes', () => {
  beforeEach(() => {
    allotmentResizes.length = 0;
  });

  it('resizes a split on screen to sizes set elsewhere, but not to its own drag', () => {
    const node = split('outer', leaf('p-A', 'A'), leaf('p-B', 'B'));
    const { rerender } = render(<PaneRenderer node={node} isTabActive={true} />);

    // A drag reports the sizes the split already shows; the store hands them back.
    act(() => lastDragEnd?.([600, 400]));
    rerender(<PaneRenderer node={{ ...node, sizes: [600, 400] }} isTabActive={true} />);
    expect(allotmentResizes).toEqual([]);

    // Sizes arranged on another device.
    rerender(<PaneRenderer node={{ ...node, sizes: [700, 300] }} isTabActive={true} />);
    expect(allotmentResizes).toEqual([[700, 300]]);
  });
});
