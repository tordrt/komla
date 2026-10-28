import { beforeEach, describe, expect, it } from 'vitest';

import { getAllLeaves } from '../../../src/renderer/lib/layout-utils';
import { useLayoutStore } from '../../../src/renderer/stores/layout.store';

function resetLayoutStore(): void {
  useLayoutStore.setState(useLayoutStore.getInitialState(), true);
}

describe('layout.store', () => {
  beforeEach(() => {
    resetLayoutStore();
  });

  it('handles active workspace/tab/pane fallbacks and stale active tab IDs', () => {
    const state = useLayoutStore.getState();

    expect(state.getCurrentLayout()).toBeNull();
    expect(state.getCurrentTabs()).toEqual([]);
    expect(state.getActiveTabId()).toBeNull();
    expect(state.getFocusedPaneId()).toBeNull();

    state.setCurrentWorkspace('ws-1', 'term-1');
    expect(state.getCurrentTabs()).toEqual(['term-1']);
    expect(state.getActiveTabId()).toBe('term-1');
    expect(state.getFocusedPaneId()).toBeTruthy();

    useLayoutStore.setState((s) => ({
      ...s,
      tabsByWorkspace: { ...s.tabsByWorkspace, 'ws-1': ['tab-a', 'tab-b'] },
      activeTabByWorkspace: { ...s.activeTabByWorkspace, 'ws-1': 'stale-tab' },
    }));

    useLayoutStore.getState().selectNextTab();
    expect(useLayoutStore.getState().getActiveTabId()).toBe('tab-a');

    useLayoutStore.getState().selectPreviousTab();
    expect(useLayoutStore.getState().getActiveTabId()).toBe('tab-b');
  });

  it('keeps split/close pane state consistent and recreates a leaf when last pane closes', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');

    const initialLayout = state.getCurrentLayout();
    expect(initialLayout?.type).toBe('leaf');

    state.splitPane('vertical', 'term-2');

    const splitLayout = useLayoutStore.getState().getCurrentLayout();
    expect(splitLayout?.type).toBe('split');

    const splitLeaves = getAllLeaves(splitLayout!);
    expect(splitLeaves.map((leaf) => leaf.terminalId)).toEqual(['term-1', 'term-2']);

    const focusedAfterSplit = useLayoutStore.getState().getFocusedPaneId();
    const splitFocusedLeaf = splitLeaves.find((leaf) => leaf.id === focusedAfterSplit);
    expect(splitFocusedLeaf?.terminalId).toBe('term-2');

    useLayoutStore.getState().closePane(focusedAfterSplit!);

    const afterCloseLayout = useLayoutStore.getState().getCurrentLayout();
    expect(afterCloseLayout?.type).toBe('leaf');
    expect(afterCloseLayout?.terminalId).toBe('term-1');
    expect(useLayoutStore.getState().getCurrentTabs()).toEqual(['term-1']);

    const lastPaneId = useLayoutStore.getState().getFocusedPaneId();
    useLayoutStore.getState().closePane(lastPaneId!);

    const recreatedLayout = useLayoutStore.getState().getCurrentLayout();
    expect(recreatedLayout?.type).toBe('leaf');
    expect(recreatedLayout?.terminalId).toBe('term-1');
    expect(useLayoutStore.getState().getFocusedPaneId()).toBe(recreatedLayout?.id);
  });

  it('applies a deferred split to its originating workspace', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-origin', 'term-origin');
    const originPaneId = state.getFocusedPaneId()!;
    state.setCurrentWorkspace('ws-current', 'term-current');

    state.splitPane('vertical', 'term-new', {
      workspaceId: 'ws-origin',
      tabId: 'term-origin',
      paneId: originPaneId,
    });

    const current = useLayoutStore.getState();
    expect(current.currentWorkspaceId).toBe('ws-current');
    expect(getAllLeaves(current.layoutsByTab['ws-current']['term-current'])).toHaveLength(1);
    expect(
      getAllLeaves(current.layoutsByTab['ws-origin']['term-origin']).map((leaf) => leaf.terminalId)
    ).toEqual(['term-origin', 'term-new']);
  });

  it('falls back to adjacent tabs correctly when removing active tabs', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'tab-a');
    state.addTab('ws-1', 'tab-b');
    state.addTab('ws-1', 'tab-c');

    state.setActiveTab('tab-b');
    state.removeTab('ws-1', 'tab-b');
    expect(useLayoutStore.getState().getActiveTabId()).toBe('tab-c');

    state.removeTab('ws-1', 'tab-c');
    expect(useLayoutStore.getState().getActiveTabId()).toBe('tab-a');

    state.removeTab('ws-1', 'tab-a');
    expect(useLayoutStore.getState().getActiveTabId()).toBeNull();
    expect(useLayoutStore.getState().getCurrentTabs()).toEqual([]);
  });

  it('re-keys a split tab when its identifier terminal exits', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.splitPane('vertical', 'term-2');

    state.removeTerminalPane('ws-1', 'term-1');

    const current = useLayoutStore.getState();
    const layout = current.getCurrentLayout();
    expect(layout?.type).toBe('leaf');
    expect(layout?.terminalId).toBe('term-2');
    expect(current.getCurrentTabs()).toEqual(['term-2']);
    expect(current.getActiveTabId()).toBe('term-2');
    expect(current.layoutsByTab['ws-1']['term-1']).toBeUndefined();
    expect(current.focusedPaneByTab['ws-1']['term-1']).toBeUndefined();
  });

  it('keeps a layout that shows no terminal when the workspace is selected again', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.splitPane('vertical', 'surface:browser:b');
    state.removeTerminalPane('ws-1', 'term-1');
    state.setCurrentWorkspace(null);

    state.setCurrentWorkspace('ws-1');

    expect(useLayoutStore.getState().getCurrentTabs()).toEqual(['surface:browser:b']);
  });

  it('keeps a layout whose first terminal is split into a tab another pane names', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.splitPane('vertical', 'surface:note:n');
    state.splitPane('vertical', 'term-2');
    state.removeTerminalPane('ws-1', 'term-1');
    state.setCurrentWorkspace(null);

    state.setCurrentWorkspace('ws-1', 'term-2');

    const current = useLayoutStore.getState();
    expect(current.getCurrentTabs()).toEqual(['surface:note:n']);
    expect(getAllLeaves(current.getCurrentLayout()!).map((leaf) => leaf.terminalId)).toEqual([
      'surface:note:n',
      'term-2',
    ]);
  });

  it('removes the tab when its only terminal exits', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.addTab('ws-1', 'term-2');
    state.setActiveTab('term-1');

    state.removeTerminalPane('ws-1', 'term-1');

    expect(useLayoutStore.getState().getCurrentTabs()).toEqual(['term-2']);
    expect(useLayoutStore.getState().getActiveTabId()).toBe('term-2');
    expect(useLayoutStore.getState().layoutsByTab['ws-1']['term-1']).toBeUndefined();
  });

  it('removes every layout occurrence of an exited terminal', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.addTab('ws-1', 'term-2');
    state.setActiveTab('term-2');
    state.splitPane('vertical', 'term-1');

    state.removeTerminalPane('ws-1', 'term-1');

    const current = useLayoutStore.getState();
    expect(current.getCurrentTabs()).toEqual(['term-2']);
    expect(current.getCurrentLayout()?.type).toBe('leaf');
    expect(current.getCurrentLayout()?.terminalId).toBe('term-2');
  });

  it('can apply a workspace layout without changing the current workspace', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-current', 'term-current');

    const hiddenLeaf = {
      type: 'leaf' as const,
      id: 'pane-hidden',
      terminalId: 'term-hidden',
    };

    state.applyWorkspaceLayout(
      'ws-hidden',
      {
        tabs: ['term-hidden'],
        layouts: { 'term-hidden': hiddenLeaf },
        focusedPanes: { 'term-hidden': hiddenLeaf.id },
        activeTab: 'term-hidden',
      },
      { setCurrentWorkspace: false }
    );

    expect(useLayoutStore.getState().currentWorkspaceId).toBe('ws-current');
    expect(useLayoutStore.getState().tabsByWorkspace['ws-hidden']).toEqual(['term-hidden']);
  });

  it('swaps two panes and moves focus to the drop target', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.splitPane('vertical', 'term-2');

    const leaves = getAllLeaves(useLayoutStore.getState().getCurrentLayout()!);
    const paneA = leaves.find((l) => l.terminalId === 'term-1')!;
    const paneB = leaves.find((l) => l.terminalId === 'term-2')!;

    useLayoutStore.getState().swapPanes(paneA.id, paneB.id);

    const swapped = getAllLeaves(useLayoutStore.getState().getCurrentLayout()!);
    expect(swapped.find((l) => l.id === paneA.id)?.terminalId).toBe('term-2');
    expect(swapped.find((l) => l.id === paneB.id)?.terminalId).toBe('term-1');
    expect(useLayoutStore.getState().getFocusedPaneId()).toBe(paneB.id);
  });

  it('moves a pane to an edge and keeps focus on the moved terminal', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.splitPane('vertical', 'term-2');

    const leaves = getAllLeaves(useLayoutStore.getState().getCurrentLayout()!);
    const paneA = leaves.find((l) => l.terminalId === 'term-1')!;
    const paneB = leaves.find((l) => l.terminalId === 'term-2')!;

    useLayoutStore.getState().movePaneToEdge(paneA.id, paneB.id, 'bottom');

    const layout = useLayoutStore.getState().getCurrentLayout()!;
    expect(layout.type).toBe('split');
    expect(getAllLeaves(layout).map((l) => l.terminalId)).toEqual(['term-2', 'term-1']);

    const focused = useLayoutStore.getState().getFocusedPaneId();
    const focusedLeaf = getAllLeaves(layout).find((l) => l.id === focused);
    expect(focusedLeaf?.terminalId).toBe('term-1');
  });

  it("moves a single-pane tab to an edge of the active tab's pane and drops the tab", () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.addTab('ws-1', 'term-9');

    const before = useLayoutStore.getState();
    const targetPane = getAllLeaves(before.layoutsByTab['ws-1']['term-1'])[0];

    useLayoutStore.getState().moveTabToEdge('term-9', targetPane.id, 'left');

    const after = useLayoutStore.getState();
    expect(after.getCurrentTabs()).toEqual(['term-1']);
    expect(after.layoutsByTab['ws-1']['term-9']).toBeUndefined();
    expect(after.focusedPaneByTab['ws-1']['term-9']).toBeUndefined();
    const layout = after.getCurrentLayout()!;
    expect(layout.type === 'split' && layout.direction).toBe('vertical');
    expect(getAllLeaves(layout).map((l) => l.terminalId)).toEqual(['term-9', 'term-1']);
    const focused = after.getFocusedPaneId();
    expect(getAllLeaves(layout).find((l) => l.id === focused)?.terminalId).toBe('term-9');
  });

  it('leaves a split tab alone when it is dropped onto a pane', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.addTab('ws-1', 'term-9');
    const term9Pane = getAllLeaves(useLayoutStore.getState().layoutsByTab['ws-1']['term-9'])[0];
    state.splitPane('vertical', 'term-2', { workspaceId: 'ws-1', tabId: 'term-9', paneId: term9Pane.id });

    const before = useLayoutStore.getState();
    const targetPane = getAllLeaves(before.layoutsByTab['ws-1']['term-1'])[0];

    useLayoutStore.getState().moveTabToEdge('term-9', targetPane.id, 'left');

    expect(useLayoutStore.getState().layoutsByTab).toBe(before.layoutsByTab);
    expect(useLayoutStore.getState().tabsByWorkspace).toBe(before.tabsByWorkspace);
  });

  it('moves a pane into another tab and switches to that tab', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.addTab('ws-1', 'term-9');
    state.splitPane('vertical', 'term-2');

    const sourcePane = getAllLeaves(useLayoutStore.getState().getCurrentLayout()!).find(
      (l) => l.terminalId === 'term-2'
    )!;

    useLayoutStore.getState().movePaneToTab(sourcePane.id, 'term-9');

    const after = useLayoutStore.getState();
    // Active tab follows the moved pane.
    expect(after.getActiveTabId()).toBe('term-9');
    // Source tab keeps its remaining pane.
    expect(getAllLeaves(after.layoutsByTab['ws-1']['term-1']).map((l) => l.terminalId)).toEqual([
      'term-1',
    ]);
    // Target tab gained the moved terminal alongside its own.
    const targetLeaves = getAllLeaves(after.layoutsByTab['ws-1']['term-9']);
    expect(targetLeaves.map((l) => l.terminalId)).toEqual(['term-9', 'term-2']);
    // Focus follows the moved terminal.
    const focused = after.getFocusedPaneId();
    expect(targetLeaves.find((l) => l.id === focused)?.terminalId).toBe('term-2');
  });

  it('removes the source tab when its last pane is moved to another tab', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.addTab('ws-1', 'term-9');

    const solePane = getAllLeaves(useLayoutStore.getState().getCurrentLayout()!)[0];

    useLayoutStore.getState().movePaneToTab(solePane.id, 'term-9');

    const after = useLayoutStore.getState();
    expect(after.getCurrentTabs()).toEqual(['term-9']);
    expect(after.layoutsByTab['ws-1']['term-1']).toBeUndefined();
    expect(getAllLeaves(after.layoutsByTab['ws-1']['term-9']).map((l) => l.terminalId)).toEqual([
      'term-9',
      'term-1',
    ]);
  });

  it('pops a pane into its own new tab and switches to it', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.splitPane('vertical', 'term-2');

    const sourcePane = getAllLeaves(useLayoutStore.getState().getCurrentLayout()!).find(
      (l) => l.terminalId === 'term-2'
    )!;

    useLayoutStore.getState().movePaneToNewTab(sourcePane.id);

    const after = useLayoutStore.getState();
    expect(after.getCurrentTabs()).toEqual(['term-1', 'term-2']);
    // Active tab follows the moved pane into the new tab.
    expect(after.getActiveTabId()).toBe('term-2');
    // Source tab keeps its remaining pane.
    expect(getAllLeaves(after.layoutsByTab['ws-1']['term-1']).map((l) => l.terminalId)).toEqual([
      'term-1',
    ]);
    // New tab holds only the moved terminal, and focus follows it.
    const newLeaves = getAllLeaves(after.layoutsByTab['ws-1']['term-2']);
    expect(newLeaves.map((l) => l.terminalId)).toEqual(['term-2']);
    expect(after.getFocusedPaneId()).toBe(newLeaves[0].id);
  });

  it('re-keys the source tab when the moved pane was the tab anchor terminal', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.splitPane('vertical', 'term-2');

    // term-1 is both a pane and the source tab's id — popping it forces a re-key.
    const anchorPane = getAllLeaves(useLayoutStore.getState().getCurrentLayout()!).find(
      (l) => l.terminalId === 'term-1'
    )!;

    useLayoutStore.getState().movePaneToNewTab(anchorPane.id);

    const after = useLayoutStore.getState();
    // Source tab re-keyed to its surviving terminal; new tab took 'term-1'.
    expect(after.getCurrentTabs()).toEqual(['term-2', 'term-1']);
    expect(after.getActiveTabId()).toBe('term-1');
    expect(getAllLeaves(after.layoutsByTab['ws-1']['term-2']).map((l) => l.terminalId)).toEqual([
      'term-2',
    ]);
    expect(getAllLeaves(after.layoutsByTab['ws-1']['term-1']).map((l) => l.terminalId)).toEqual([
      'term-1',
    ]);
  });

  it('bails on a pop when re-keying the source tab would clobber an existing tab', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-2');
    state.splitPane('vertical', 'term-3'); // tab 'term-2' layout: [term-2, term-3]
    state.addTab('ws-1', 'term-1'); // tabs: ['term-2', 'term-1']
    state.setActiveTab('term-2');

    // Move the term-2 pane into tab 'term-1' — terminal term-2 now lives there,
    // while tab key 'term-2' survives holding only term-3.
    const term2Pane = getAllLeaves(useLayoutStore.getState().layoutsByTab['ws-1']['term-2']).find(
      (l) => l.terminalId === 'term-2'
    )!;
    useLayoutStore.getState().movePaneToTab(term2Pane.id, 'term-1');

    const before = useLayoutStore.getState();
    const tabsBefore = [...before.getCurrentTabs()];
    const term2TabLayout = before.layoutsByTab['ws-1']['term-2'];
    const term1Pane = getAllLeaves(before.getCurrentLayout()!).find(
      (l) => l.terminalId === 'term-1'
    )!;

    // Popping the term-1 anchor would re-key the source tab to 'term-2', which
    // already keys another tab — must bail instead of clobbering it.
    useLayoutStore.getState().movePaneToNewTab(term1Pane.id);

    const after = useLayoutStore.getState();
    expect(after.getCurrentTabs()).toEqual(tabsBefore);
    expect(after.layoutsByTab['ws-1']['term-2']).toBe(term2TabLayout);
  });

  it('ignores popping a sole pane into a new tab', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');

    const solePane = getAllLeaves(useLayoutStore.getState().getCurrentLayout()!)[0];

    useLayoutStore.getState().movePaneToNewTab(solePane.id);

    const after = useLayoutStore.getState();
    expect(after.getCurrentTabs()).toEqual(['term-1']);
    expect(after.getActiveTabId()).toBe('term-1');
  });

  it('ignores a pane move onto its own tab', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.addTab('ws-1', 'term-9');
    state.splitPane('vertical', 'term-2');

    const sourcePane = getAllLeaves(useLayoutStore.getState().getCurrentLayout()!).find(
      (l) => l.terminalId === 'term-2'
    )!;

    // Dropping onto the source (active) tab is a no-op.
    useLayoutStore.getState().movePaneToTab(sourcePane.id, 'term-1');
    expect(useLayoutStore.getState().getActiveTabId()).toBe('term-1');
    expect(getAllLeaves(useLayoutStore.getState().getCurrentLayout()!)).toHaveLength(2);
  });

  it('ignores a pane move onto a tab already showing that terminal', () => {
    const state = useLayoutStore.getState();
    state.setCurrentWorkspace('ws-1', 'term-1');
    state.splitPane('vertical', 'term-2'); // active tab 'term-1' layout: [term-1, term-2]
    // Tab 'term-2' is created with its own leaf for term-2 — the same terminal
    // now appears in two tabs, which is exactly the duplicate-render guard case.
    state.addTab('ws-1', 'term-2');

    const sourcePane = getAllLeaves(useLayoutStore.getState().layoutsByTab['ws-1']['term-1']).find(
      (l) => l.terminalId === 'term-2'
    )!;

    // Moving the term-2 pane onto tab 'term-2' must bail — that tab already
    // renders term-2, and one PTY cannot drive two panes.
    useLayoutStore.getState().movePaneToTab(sourcePane.id, 'term-2');

    const after = useLayoutStore.getState();
    expect(after.getActiveTabId()).toBe('term-1');
    expect(getAllLeaves(after.layoutsByTab['ws-1']['term-1']).map((l) => l.terminalId)).toEqual([
      'term-1',
      'term-2',
    ]);
    expect(getAllLeaves(after.layoutsByTab['ws-1']['term-2']).map((l) => l.terminalId)).toEqual([
      'term-2',
    ]);
  });
});
