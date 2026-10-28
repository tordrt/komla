import { create } from 'zustand';

import {
  createLeaf,
  splitLeaf,
  splitLeafAt,
  splitLeafAtEdge,
  removePane,
  getAllLeaves,
  findNode,
  findPaneByTerminalId,
  updateSizes,
  replaceTerminalInPane,
  swapTerminals,
  movePane,
} from '../lib/layout-utils';

import type { LayoutNode, PaneId, SplitDirection, DropEdge } from '../types/layout';

// Removes a tab whose panes all moved elsewhere from a workspace's copied layout and focus maps,
// returning the workspace's tabs without it.
function dropEmptiedTab(
  layouts: Record<string, LayoutNode>,
  focused: Record<string, PaneId>,
  tabs: string[],
  tabId: string
): string[] {
  delete layouts[tabId];
  delete focused[tabId];
  return tabs.filter((t) => t !== tabId);
}

interface LayoutState {
  // Per-tab layouts: layoutsByTab[workspaceId][tabTerminalId] = layout
  layoutsByTab: Record<string, Record<string, LayoutNode>>;
  // Tabs per workspace (terminal IDs)
  tabsByWorkspace: Record<string, string[]>;
  // Focused pane per tab: focusedPaneByTab[workspaceId][tabTerminalId] = paneId
  focusedPaneByTab: Record<string, Record<string, PaneId>>;
  // Active tab per workspace
  activeTabByWorkspace: Record<string, string>;
  // Current workspace
  currentWorkspaceId: string | null;

  // Computed current state
  getCurrentLayout: () => LayoutNode | null;
  getCurrentTabs: () => string[];
  getActiveTabId: () => string | null;
  getFocusedPaneId: () => PaneId | null;

  // Actions
  setCurrentWorkspace: (workspaceId: string | null, initialTerminalId?: string) => void;
  initializeWorkspaceLayout: (workspaceId: string, terminalId?: string, force?: boolean) => void;
  addTab: (workspaceId: string, tabTerminalId: string) => void;
  removeTab: (workspaceId: string, tabTerminalId: string) => void;
  setActiveTab: (tabTerminalId: string) => void;
  splitPane: (
    direction: SplitDirection,
    newTerminalId: string,
    // A null tabId falls back to the workspace's active tab.
    target?: { workspaceId: string; tabId: string | null; paneId: PaneId }
  ) => void;
  closePane: (paneId: PaneId) => void;
  removeTerminalPane: (workspaceId: string, terminalId: string) => void;
  swapPanes: (paneIdA: PaneId, paneIdB: PaneId) => void;
  movePaneToEdge: (sourcePaneId: PaneId, targetPaneId: PaneId, edge: DropEdge) => void;
  movePaneToTab: (sourcePaneId: PaneId, targetTabId: string) => void;
  // Moves a single-pane tab's pane beside a pane of the active tab, and drops the emptied tab.
  moveTabToEdge: (sourceTabId: string, targetPaneId: PaneId, edge: DropEdge) => void;
  movePaneToNewTab: (sourcePaneId: PaneId) => void;
  setFocusedPane: (paneId: PaneId) => void;
  replaceTerminalInPane: (paneId: PaneId, newTerminalId: string) => void;
  updateSizes: (paneId: PaneId, sizes: [number, number]) => void;
  openInFocusedPane: (terminalId: string) => void;
  showTabInFullPane: (terminalId: string) => void;
  isTabVisible: (terminalId: string) => boolean;
  /** Shows the tab with the terminal's pane and focuses that pane; false when no tab shows it. */
  revealTerminal: (workspaceId: string, terminalId: string) => boolean;
  clearWorkspaceLayout: (workspaceId: string) => void;
  applyWorkspaceLayout: (
    workspaceId: string,
    data: {
      tabs: string[];
      layouts: Record<string, LayoutNode>;
      focusedPanes: Record<string, PaneId>;
      activeTab: string;
    },
    options?: { setCurrentWorkspace?: boolean }
  ) => void;
  reorderTabs: (workspaceId: string, fromIndex: number, toIndex: number) => void;
  selectNextTab: () => void;
  selectPreviousTab: () => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  layoutsByTab: {},
  tabsByWorkspace: {},
  focusedPaneByTab: {},
  activeTabByWorkspace: {},
  currentWorkspaceId: null,
  getCurrentLayout: () => {
    const { currentWorkspaceId, activeTabByWorkspace, layoutsByTab } = get();
    if (!currentWorkspaceId) return null;
    const activeTabId = activeTabByWorkspace[currentWorkspaceId];
    if (!activeTabId) return null;
    return layoutsByTab[currentWorkspaceId]?.[activeTabId] || null;
  },

  getCurrentTabs: () => {
    const { currentWorkspaceId, tabsByWorkspace } = get();
    if (!currentWorkspaceId) return [];
    return tabsByWorkspace[currentWorkspaceId] || [];
  },

  getActiveTabId: () => {
    const { currentWorkspaceId, activeTabByWorkspace } = get();
    if (!currentWorkspaceId) return null;
    return activeTabByWorkspace[currentWorkspaceId] || null;
  },

  getFocusedPaneId: () => {
    const { currentWorkspaceId, activeTabByWorkspace, focusedPaneByTab } = get();
    if (!currentWorkspaceId) return null;
    const activeTabId = activeTabByWorkspace[currentWorkspaceId];
    if (!activeTabId) return null;
    return focusedPaneByTab[currentWorkspaceId]?.[activeTabId] || null;
  },

  setCurrentWorkspace: (workspaceId, initialTerminalId) => {
    set({ currentWorkspaceId: workspaceId });

    // Initialize layout for this workspace if it doesn't exist
    if (workspaceId) {
      const { layoutsByTab, tabsByWorkspace, activeTabByWorkspace } = get();
      const terminalId = initialTerminalId || workspaceId;
      // A layout stays when it shows the terminal in any tab, or shows panes and names none.
      const initialized = initialTerminalId
        ? Object.values(layoutsByTab[workspaceId] ?? {}).some((root) =>
            findPaneByTerminalId(root, terminalId)
          )
        : !!tabsByWorkspace[workspaceId]?.length;
      if (!initialized) {
        // Create initial layout with the terminal
        const leaf = createLeaf(terminalId);
        set({
          layoutsByTab: {
            ...layoutsByTab,
            [workspaceId]: { ...layoutsByTab[workspaceId], [terminalId]: leaf },
          },
          tabsByWorkspace: { ...tabsByWorkspace, [workspaceId]: [terminalId] },
          focusedPaneByTab: {
            ...get().focusedPaneByTab,
            [workspaceId]: { ...get().focusedPaneByTab[workspaceId], [terminalId]: leaf.id },
          },
          activeTabByWorkspace: { ...activeTabByWorkspace, [workspaceId]: terminalId },
        });
      }
    }
  },

  initializeWorkspaceLayout: (workspaceId, terminalId?: string, force?: boolean) => {
    const { layoutsByTab, tabsByWorkspace, focusedPaneByTab, activeTabByWorkspace } = get();
    const id = terminalId || workspaceId;
    if (!force && layoutsByTab[workspaceId]?.[id]) return; // Already initialized

    const leaf = createLeaf(id);
    // When force-replacing a placeholder, drop the old entry keyed by workspaceId
    // to avoid leaking dead layout nodes.
    const dropPlaceholder = force && id !== workspaceId;
    const stripOld = <T>(map: Record<string, T> | undefined): Record<string, T> => {
      if (!map) return {};
      if (!dropPlaceholder) return map;
      const { [workspaceId]: _, ...rest } = map;
      return rest;
    };
    set({
      layoutsByTab: {
        ...layoutsByTab,
        [workspaceId]: { ...stripOld(layoutsByTab[workspaceId]), [id]: leaf },
      },
      tabsByWorkspace: { ...tabsByWorkspace, [workspaceId]: [id] },
      focusedPaneByTab: {
        ...focusedPaneByTab,
        [workspaceId]: { ...stripOld(focusedPaneByTab[workspaceId]), [id]: leaf.id },
      },
      activeTabByWorkspace: { ...activeTabByWorkspace, [workspaceId]: id },
    });
  },

  addTab: (workspaceId, tabTerminalId) => {
    const { tabsByWorkspace, layoutsByTab, focusedPaneByTab } = get();
    const currentTabs = tabsByWorkspace[workspaceId] || [];

    // Don't add duplicates
    if (currentTabs.includes(tabTerminalId)) return;

    // Create a single-pane layout for the new tab
    const leaf = createLeaf(tabTerminalId);

    set({
      tabsByWorkspace: { ...tabsByWorkspace, [workspaceId]: [...currentTabs, tabTerminalId] },
      layoutsByTab: {
        ...layoutsByTab,
        [workspaceId]: { ...layoutsByTab[workspaceId], [tabTerminalId]: leaf },
      },
      focusedPaneByTab: {
        ...focusedPaneByTab,
        [workspaceId]: { ...focusedPaneByTab[workspaceId], [tabTerminalId]: leaf.id },
      },
    });
  },

  removeTab: (workspaceId, tabTerminalId) => {
    const { tabsByWorkspace, layoutsByTab, focusedPaneByTab, activeTabByWorkspace } = get();
    const currentTabs = tabsByWorkspace[workspaceId] || [];
    const removedIndex = currentTabs.indexOf(tabTerminalId);
    const newTabs = currentTabs.filter((t) => t !== tabTerminalId);

    // Remove the tab's layout
    const workspaceLayouts = { ...layoutsByTab[workspaceId] };
    delete workspaceLayouts[tabTerminalId];

    const workspaceFocused = { ...focusedPaneByTab[workspaceId] };
    delete workspaceFocused[tabTerminalId];

    // If the removed tab was active, switch to adjacent tab (Chrome-like behavior)
    // Prefer the tab to the right, or left if it was the rightmost
    let newActiveTab: string | undefined = activeTabByWorkspace[workspaceId];
    if (newActiveTab === tabTerminalId) {
      if (newTabs.length === 0) {
        // No tabs left, clear active tab (will show empty state)
        newActiveTab = undefined;
      } else if (removedIndex >= newTabs.length) {
        // Was rightmost tab, select the new rightmost (previous tab)
        newActiveTab = newTabs[newTabs.length - 1];
      } else {
        // Select the tab that's now at the same index (was to the right)
        newActiveTab = newTabs[removedIndex];
      }
    }

    const newActiveTabByWorkspace = { ...activeTabByWorkspace };
    if (newActiveTab === undefined) {
      delete newActiveTabByWorkspace[workspaceId];
    } else {
      newActiveTabByWorkspace[workspaceId] = newActiveTab;
    }

    set({
      tabsByWorkspace: { ...tabsByWorkspace, [workspaceId]: newTabs },
      layoutsByTab: { ...layoutsByTab, [workspaceId]: workspaceLayouts },
      focusedPaneByTab: { ...focusedPaneByTab, [workspaceId]: workspaceFocused },
      activeTabByWorkspace: newActiveTabByWorkspace,
    });
  },

  setActiveTab: (tabTerminalId) => {
    const { currentWorkspaceId, activeTabByWorkspace } = get();
    if (!currentWorkspaceId) return;

    set({
      activeTabByWorkspace: { ...activeTabByWorkspace, [currentWorkspaceId]: tabTerminalId },
    });
  },

  splitPane: (direction, newTerminalId, target) => {
    const { currentWorkspaceId, activeTabByWorkspace, layoutsByTab, focusedPaneByTab } = get();
    const workspaceId = target?.workspaceId ?? currentWorkspaceId;
    if (!workspaceId) return;

    const activeTabId = target?.tabId ?? activeTabByWorkspace[workspaceId];
    if (!activeTabId) {
      if (target) get().addTab(workspaceId, newTerminalId);
      return;
    }

    const layout = layoutsByTab[workspaceId]?.[activeTabId];
    const focusedPaneId = target?.paneId ?? focusedPaneByTab[workspaceId]?.[activeTabId];
    if (!layout || !focusedPaneId || !findNode(layout, focusedPaneId)) {
      if (target) get().addTab(workspaceId, newTerminalId);
      return;
    }

    const newLayout = splitLeaf(layout, focusedPaneId, direction, newTerminalId);
    const newLeaf = findPaneByTerminalId(newLayout, newTerminalId);

    set({
      layoutsByTab: {
        ...layoutsByTab,
        [workspaceId]: {
          ...layoutsByTab[workspaceId],
          [activeTabId]: newLayout,
        },
      },
      focusedPaneByTab: {
        ...focusedPaneByTab,
        [workspaceId]: {
          ...focusedPaneByTab[workspaceId],
          [activeTabId]: newLeaf?.id ?? focusedPaneId,
        },
      },
    });
  },

  closePane: (paneId) => {
    const { currentWorkspaceId, activeTabByWorkspace, layoutsByTab, focusedPaneByTab } = get();
    if (!currentWorkspaceId) return;

    const activeTabId = activeTabByWorkspace[currentWorkspaceId];
    if (!activeTabId) return;

    const layout = layoutsByTab[currentWorkspaceId]?.[activeTabId];
    if (!layout) return;

    const newLayout = removePane(layout, paneId);

    if (newLayout === null) {
      // Last pane - create a new empty layout with the active tab's terminal
      const leaf = createLeaf(activeTabId);
      set({
        layoutsByTab: {
          ...layoutsByTab,
          [currentWorkspaceId]: { ...layoutsByTab[currentWorkspaceId], [activeTabId]: leaf },
        },
        focusedPaneByTab: {
          ...focusedPaneByTab,
          [currentWorkspaceId]: { ...focusedPaneByTab[currentWorkspaceId], [activeTabId]: leaf.id },
        },
      });
      return;
    }

    let newFocusedPaneId = focusedPaneByTab[currentWorkspaceId]?.[activeTabId];
    if (newFocusedPaneId === paneId) {
      const newLeaves = getAllLeaves(newLayout);
      newFocusedPaneId = newLeaves[0]?.id ?? null;
    }

    // Don't remove from tabs when closing a pane - tabs are independent of layouts
    // The terminal is just removed from THIS tab's layout, not from tabs overall

    set({
      layoutsByTab: {
        ...layoutsByTab,
        [currentWorkspaceId]: { ...layoutsByTab[currentWorkspaceId], [activeTabId]: newLayout },
      },
      focusedPaneByTab: {
        ...focusedPaneByTab,
        [currentWorkspaceId]: {
          ...focusedPaneByTab[currentWorkspaceId],
          [activeTabId]: newFocusedPaneId,
        },
      },
    });
  },

  removeTerminalPane: (workspaceId, terminalId) => {
    const workspaceLayouts = get().layoutsByTab[workspaceId];
    if (!workspaceLayouts) return;

    for (const tabId of Object.keys(workspaceLayouts)) {
      let layout: LayoutNode | undefined = get().layoutsByTab[workspaceId]?.[tabId];
      let pane = layout ? findPaneByTerminalId(layout, terminalId) : null;

      while (layout && pane) {
        const newLayout = removePane(layout, pane.id);
        if (newLayout === null) {
          get().removeTab(workspaceId, tabId);
          // The tab is gone, so there is nothing left to re-key.
          layout = undefined;
          break;
        }

        const { layoutsByTab, focusedPaneByTab } = get();
        const workspaceFocused = focusedPaneByTab[workspaceId] ?? {};
        const focusedPaneId =
          workspaceFocused[tabId] === pane.id
            ? getAllLeaves(newLayout)[0]?.id
            : workspaceFocused[tabId];

        set({
          layoutsByTab: {
            ...layoutsByTab,
            [workspaceId]: { ...layoutsByTab[workspaceId], [tabId]: newLayout },
          },
          focusedPaneByTab: {
            ...focusedPaneByTab,
            [workspaceId]: { ...workspaceFocused, [tabId]: focusedPaneId },
          },
        });

        layout = newLayout;
        pane = findPaneByTerminalId(layout, terminalId);
      }

      if (tabId !== terminalId || !layout) continue;

      const { tabsByWorkspace, layoutsByTab, focusedPaneByTab, activeTabByWorkspace } = get();
      const workspaceTabs = tabsByWorkspace[workspaceId] ?? [];
      const existingTabIds = new Set(workspaceTabs);
      const replacementTabId = getAllLeaves(layout)
        .map((leaf) => leaf.terminalId)
        .find((candidate) => !existingTabIds.has(candidate));
      if (!replacementTabId) continue;

      const workspaceLayouts = { ...layoutsByTab[workspaceId] };
      delete workspaceLayouts[tabId];
      workspaceLayouts[replacementTabId] = layout;

      const workspaceFocused = { ...focusedPaneByTab[workspaceId] };
      const focusedPaneId = workspaceFocused[tabId];
      delete workspaceFocused[tabId];
      workspaceFocused[replacementTabId] = focusedPaneId;

      set({
        tabsByWorkspace: {
          ...tabsByWorkspace,
          [workspaceId]: workspaceTabs.map((id) => (id === tabId ? replacementTabId : id)),
        },
        layoutsByTab: { ...layoutsByTab, [workspaceId]: workspaceLayouts },
        focusedPaneByTab: { ...focusedPaneByTab, [workspaceId]: workspaceFocused },
        activeTabByWorkspace:
          activeTabByWorkspace[workspaceId] === tabId
            ? { ...activeTabByWorkspace, [workspaceId]: replacementTabId }
            : activeTabByWorkspace,
      });
    }
  },

  swapPanes: (paneIdA, paneIdB) => {
    const { currentWorkspaceId, activeTabByWorkspace, layoutsByTab, focusedPaneByTab } = get();
    if (!currentWorkspaceId) return;

    const activeTabId = activeTabByWorkspace[currentWorkspaceId];
    if (!activeTabId) return;

    const layout = layoutsByTab[currentWorkspaceId]?.[activeTabId];
    if (!layout) return;

    const newLayout = swapTerminals(layout, paneIdA, paneIdB);
    if (newLayout === layout) return;

    set({
      layoutsByTab: {
        ...layoutsByTab,
        [currentWorkspaceId]: { ...layoutsByTab[currentWorkspaceId], [activeTabId]: newLayout },
      },
      // Focus follows the dragged terminal to its new pane.
      focusedPaneByTab: {
        ...focusedPaneByTab,
        [currentWorkspaceId]: { ...focusedPaneByTab[currentWorkspaceId], [activeTabId]: paneIdB },
      },
    });
  },

  movePaneToEdge: (sourcePaneId, targetPaneId, edge) => {
    const { currentWorkspaceId, activeTabByWorkspace, layoutsByTab, focusedPaneByTab } = get();
    if (!currentWorkspaceId) return;

    const activeTabId = activeTabByWorkspace[currentWorkspaceId];
    if (!activeTabId) return;

    const layout = layoutsByTab[currentWorkspaceId]?.[activeTabId];
    if (!layout) return;

    const sourceLeaf = findNode(layout, sourcePaneId);
    if (sourceLeaf?.type !== 'leaf') return;

    const newLayout = movePane(layout, sourcePaneId, targetPaneId, edge);
    if (newLayout === layout) return;

    // movePane mints a fresh leaf for the moved terminal — re-resolve focus by
    // terminal id so focus follows the pane the user dragged.
    const movedLeaf = findPaneByTerminalId(newLayout, sourceLeaf.terminalId);

    set({
      layoutsByTab: {
        ...layoutsByTab,
        [currentWorkspaceId]: { ...layoutsByTab[currentWorkspaceId], [activeTabId]: newLayout },
      },
      focusedPaneByTab: {
        ...focusedPaneByTab,
        [currentWorkspaceId]: {
          ...focusedPaneByTab[currentWorkspaceId],
          [activeTabId]: movedLeaf?.id ?? focusedPaneByTab[currentWorkspaceId]?.[activeTabId],
        },
      },
    });
  },

  movePaneToTab: (sourcePaneId, targetTabId) => {
    const {
      currentWorkspaceId,
      activeTabByWorkspace,
      layoutsByTab,
      focusedPaneByTab,
      tabsByWorkspace,
    } = get();
    if (!currentWorkspaceId) return;

    // The dragged pane lives in the active tab — only its layout is rendered.
    const sourceTabId = activeTabByWorkspace[currentWorkspaceId];
    if (!sourceTabId || sourceTabId === targetTabId) return;

    const workspaceLayouts = layoutsByTab[currentWorkspaceId];
    const sourceLayout = workspaceLayouts?.[sourceTabId];
    const targetLayout = workspaceLayouts?.[targetTabId];
    if (!sourceLayout || !targetLayout) return;

    const sourceLeaf = findNode(sourceLayout, sourcePaneId);
    if (sourceLeaf?.type !== 'leaf') return;
    const terminalId = sourceLeaf.terminalId;

    // Bail if the target tab already shows this terminal — rendering one PTY in
    // two panes would split its input and focus.
    if (findPaneByTerminalId(targetLayout, terminalId)) return;

    // Insert into the target tab as a split to the right of its focused pane,
    // falling back to the first leaf if the stored focus is stale.
    const targetFocusedId = focusedPaneByTab[currentWorkspaceId]?.[targetTabId];
    const targetPaneId =
      targetFocusedId && findNode(targetLayout, targetFocusedId)?.type === 'leaf'
        ? targetFocusedId
        : getAllLeaves(targetLayout)[0]?.id;
    if (!targetPaneId) return;

    const newTargetLayout = splitLeafAt(
      targetLayout,
      targetPaneId,
      'vertical',
      terminalId,
      'after'
    );
    const movedLeaf = findPaneByTerminalId(newTargetLayout, terminalId);

    // removePane returns null when the moved pane was the source tab's last one.
    const newSourceLayout = removePane(sourceLayout, sourcePaneId);

    const newLayouts = { ...workspaceLayouts, [targetTabId]: newTargetLayout };
    const newFocused = { ...focusedPaneByTab[currentWorkspaceId] };
    let newTabs = tabsByWorkspace[currentWorkspaceId] || [];

    if (newSourceLayout === null) {
      // Source tab emptied — drop it, merging its content into the target.
      newTabs = dropEmptiedTab(newLayouts, newFocused, newTabs, sourceTabId);
    } else {
      newLayouts[sourceTabId] = newSourceLayout;
      if (newFocused[sourceTabId] === sourcePaneId) {
        newFocused[sourceTabId] = getAllLeaves(newSourceLayout)[0]?.id ?? newFocused[sourceTabId];
      }
    }
    newFocused[targetTabId] = movedLeaf?.id ?? newFocused[targetTabId];

    set({
      layoutsByTab: { ...layoutsByTab, [currentWorkspaceId]: newLayouts },
      focusedPaneByTab: { ...focusedPaneByTab, [currentWorkspaceId]: newFocused },
      tabsByWorkspace: { ...tabsByWorkspace, [currentWorkspaceId]: newTabs },
      // Switch to the target so the moved pane stays in view.
      activeTabByWorkspace: { ...activeTabByWorkspace, [currentWorkspaceId]: targetTabId },
    });
  },

  moveTabToEdge: (sourceTabId, targetPaneId, edge) => {
    const {
      currentWorkspaceId,
      activeTabByWorkspace,
      layoutsByTab,
      focusedPaneByTab,
      tabsByWorkspace,
    } = get();
    if (!currentWorkspaceId) return;

    const activeTabId = activeTabByWorkspace[currentWorkspaceId];
    if (!activeTabId || activeTabId === sourceTabId) return;

    const workspaceLayouts = layoutsByTab[currentWorkspaceId];
    const layout = workspaceLayouts?.[activeTabId];
    const sourceLeaf = workspaceLayouts?.[sourceTabId];
    if (!layout || sourceLeaf?.type !== 'leaf') return;
    if (findNode(layout, targetPaneId)?.type !== 'leaf') return;
    // Rendering one PTY in two panes would split its input and focus.
    if (findPaneByTerminalId(layout, sourceLeaf.terminalId)) return;

    const newLayout = splitLeafAtEdge(layout, targetPaneId, sourceLeaf.terminalId, edge);
    const newLayouts = { ...workspaceLayouts, [activeTabId]: newLayout };
    const newFocused = { ...focusedPaneByTab[currentWorkspaceId] };
    const newTabs = dropEmptiedTab(
      newLayouts,
      newFocused,
      tabsByWorkspace[currentWorkspaceId] || [],
      sourceTabId
    );
    // Focus follows the moved terminal.
    newFocused[activeTabId] =
      findPaneByTerminalId(newLayout, sourceLeaf.terminalId)?.id ?? newFocused[activeTabId];

    set({
      layoutsByTab: { ...layoutsByTab, [currentWorkspaceId]: newLayouts },
      focusedPaneByTab: { ...focusedPaneByTab, [currentWorkspaceId]: newFocused },
      tabsByWorkspace: { ...tabsByWorkspace, [currentWorkspaceId]: newTabs },
    });
  },

  movePaneToNewTab: (sourcePaneId) => {
    const {
      currentWorkspaceId,
      activeTabByWorkspace,
      layoutsByTab,
      focusedPaneByTab,
      tabsByWorkspace,
    } = get();
    if (!currentWorkspaceId) return;

    // The dragged pane lives in the active tab — only its layout is rendered.
    const sourceTabId = activeTabByWorkspace[currentWorkspaceId];
    if (!sourceTabId) return;

    const workspaceLayouts = layoutsByTab[currentWorkspaceId];
    const sourceLayout = workspaceLayouts?.[sourceTabId];
    if (!sourceLayout) return;

    const sourceLeaf = findNode(sourceLayout, sourcePaneId);
    if (sourceLeaf?.type !== 'leaf') return;
    const terminalId = sourceLeaf.terminalId;

    // removePane returns null when the dragged pane was the tab's only one —
    // popping a sole pane into a "new" tab would just re-id the tab, so bail.
    const newSourceLayout = removePane(sourceLayout, sourcePaneId);
    if (newSourceLayout === null) return;

    const tabs = tabsByWorkspace[currentWorkspaceId] || [];
    // The new tab is keyed by the moved terminal. A non-source tab already
    // keyed by it (a stale key from a prior move) would be clobbered — bail.
    if (terminalId !== sourceTabId && tabs.includes(terminalId)) return;

    const sourceIndex = tabs.indexOf(sourceTabId);
    const newLayouts = { ...workspaceLayouts };
    const newFocused = { ...focusedPaneByTab[currentWorkspaceId] };
    const newTabs = [...tabs];

    if (terminalId === sourceTabId) {
      // The source tab is keyed by the very terminal being moved out. Re-key it
      // to a surviving terminal so the new tab can take the `terminalId` key.
      // The survivor must not already key another tab, or re-keying would
      // clobber that tab's layout — bail if no safe survivor exists.
      const survivor = getAllLeaves(newSourceLayout).find((l) => !tabs.includes(l.terminalId));
      if (!survivor) return;
      newTabs[sourceIndex] = survivor.terminalId;
      delete newLayouts[sourceTabId];
      delete newFocused[sourceTabId];
      newLayouts[survivor.terminalId] = newSourceLayout;
      const keptFocus = focusedPaneByTab[currentWorkspaceId]?.[sourceTabId];
      newFocused[survivor.terminalId] =
        keptFocus && keptFocus !== sourcePaneId ? keptFocus : survivor.id;
    } else {
      newLayouts[sourceTabId] = newSourceLayout;
      if (newFocused[sourceTabId] === sourcePaneId) {
        newFocused[sourceTabId] = getAllLeaves(newSourceLayout)[0].id;
      }
    }

    // Append the new single-pane tab and switch to it.
    const newLeaf = createLeaf(terminalId);
    newLayouts[terminalId] = newLeaf;
    newFocused[terminalId] = newLeaf.id;
    newTabs.push(terminalId);

    set({
      layoutsByTab: { ...layoutsByTab, [currentWorkspaceId]: newLayouts },
      focusedPaneByTab: { ...focusedPaneByTab, [currentWorkspaceId]: newFocused },
      tabsByWorkspace: { ...tabsByWorkspace, [currentWorkspaceId]: newTabs },
      activeTabByWorkspace: { ...activeTabByWorkspace, [currentWorkspaceId]: terminalId },
    });
  },

  setFocusedPane: (paneId) => {
    const { currentWorkspaceId, activeTabByWorkspace, focusedPaneByTab } = get();
    if (!currentWorkspaceId) return;

    const activeTabId = activeTabByWorkspace[currentWorkspaceId];
    if (!activeTabId) return;

    set({
      focusedPaneByTab: {
        ...focusedPaneByTab,
        [currentWorkspaceId]: { ...focusedPaneByTab[currentWorkspaceId], [activeTabId]: paneId },
      },
    });
  },

  replaceTerminalInPane: (paneId, newTerminalId) => {
    const {
      currentWorkspaceId,
      activeTabByWorkspace,
      layoutsByTab,
      tabsByWorkspace,
      focusedPaneByTab,
    } = get();
    if (!currentWorkspaceId) return;

    const activeTabId = activeTabByWorkspace[currentWorkspaceId];
    if (!activeTabId) return;

    const layout = layoutsByTab[currentWorkspaceId]?.[activeTabId];
    if (!layout) return;

    const newLayout = replaceTerminalInPane(layout, paneId, newTerminalId);

    // Add to tabs if not already there
    const currentTabs = tabsByWorkspace[currentWorkspaceId] || [];
    const tabExists = currentTabs.includes(newTerminalId);

    // Create a single-pane layout for the new terminal's own tab
    const newTerminalLeaf = createLeaf(newTerminalId);

    set({
      layoutsByTab: {
        ...layoutsByTab,
        [currentWorkspaceId]: {
          ...layoutsByTab[currentWorkspaceId],
          [activeTabId]: newLayout,
          ...(tabExists ? {} : { [newTerminalId]: newTerminalLeaf }),
        },
      },
      tabsByWorkspace: tabExists
        ? tabsByWorkspace
        : { ...tabsByWorkspace, [currentWorkspaceId]: [...currentTabs, newTerminalId] },
      focusedPaneByTab: tabExists
        ? focusedPaneByTab
        : {
            ...focusedPaneByTab,
            [currentWorkspaceId]: {
              ...focusedPaneByTab[currentWorkspaceId],
              [newTerminalId]: newTerminalLeaf.id,
            },
          },
    });
  },

  updateSizes: (paneId, sizes) => {
    const { currentWorkspaceId, activeTabByWorkspace, layoutsByTab } = get();
    if (!currentWorkspaceId) return;

    const activeTabId = activeTabByWorkspace[currentWorkspaceId];
    if (!activeTabId) return;

    const layout = layoutsByTab[currentWorkspaceId]?.[activeTabId];
    if (!layout) return;

    const newLayout = updateSizes(layout, paneId, sizes);
    set({
      layoutsByTab: {
        ...layoutsByTab,
        [currentWorkspaceId]: { ...layoutsByTab[currentWorkspaceId], [activeTabId]: newLayout },
      },
    });
  },

  openInFocusedPane: (terminalId) => {
    const {
      currentWorkspaceId,
      activeTabByWorkspace,
      layoutsByTab,
      tabsByWorkspace,
      focusedPaneByTab,
    } = get();
    if (!currentWorkspaceId) return;

    const activeTabId = activeTabByWorkspace[currentWorkspaceId];
    if (!activeTabId) return;

    const layout = layoutsByTab[currentWorkspaceId]?.[activeTabId];

    // If no layout exists for active tab, initialize it
    if (!layout) {
      const leaf = createLeaf(terminalId);
      set({
        layoutsByTab: {
          ...get().layoutsByTab,
          [currentWorkspaceId]: { ...get().layoutsByTab[currentWorkspaceId], [activeTabId]: leaf },
        },
        tabsByWorkspace: { ...get().tabsByWorkspace, [currentWorkspaceId]: [terminalId] },
        focusedPaneByTab: {
          ...get().focusedPaneByTab,
          [currentWorkspaceId]: {
            ...get().focusedPaneByTab[currentWorkspaceId],
            [activeTabId]: leaf.id,
          },
        },
      });
      return;
    }

    // If terminal is already visible in a pane, just focus that pane
    const existingPane = findPaneByTerminalId(layout, terminalId);
    if (existingPane) {
      set({
        focusedPaneByTab: {
          ...focusedPaneByTab,
          [currentWorkspaceId]: {
            ...focusedPaneByTab[currentWorkspaceId],
            [activeTabId]: existingPane.id,
          },
        },
      });
      return;
    }

    // Replace the terminal in the focused pane
    const focusedPaneId = focusedPaneByTab[currentWorkspaceId]?.[activeTabId];
    if (focusedPaneId) {
      const newLayout = replaceTerminalInPane(layout, focusedPaneId, terminalId);

      // Add to tabs if not already there
      const currentTabs = tabsByWorkspace[currentWorkspaceId] || [];
      const tabExists = currentTabs.includes(terminalId);

      // Create a single-pane layout for the new terminal's own tab
      const newTerminalLeaf = createLeaf(terminalId);

      set({
        layoutsByTab: {
          ...layoutsByTab,
          [currentWorkspaceId]: {
            ...layoutsByTab[currentWorkspaceId],
            [activeTabId]: newLayout,
            ...(tabExists ? {} : { [terminalId]: newTerminalLeaf }),
          },
        },
        tabsByWorkspace: tabExists
          ? tabsByWorkspace
          : { ...tabsByWorkspace, [currentWorkspaceId]: [...currentTabs, terminalId] },
        focusedPaneByTab: tabExists
          ? focusedPaneByTab
          : {
              ...focusedPaneByTab,
              [currentWorkspaceId]: {
                ...focusedPaneByTab[currentWorkspaceId],
                [terminalId]: newTerminalLeaf.id,
              },
            },
      });
    }
  },

  showTabInFullPane: (terminalId) => {
    const { currentWorkspaceId, activeTabByWorkspace } = get();
    if (!currentWorkspaceId) return;

    // Simply switch to the tab - its layout is already a single pane (created when added)
    set({
      activeTabByWorkspace: { ...activeTabByWorkspace, [currentWorkspaceId]: terminalId },
    });
  },

  isTabVisible: (terminalId) => {
    const { currentWorkspaceId, activeTabByWorkspace, layoutsByTab } = get();
    if (!currentWorkspaceId) return false;

    const activeTabId = activeTabByWorkspace[currentWorkspaceId];
    if (!activeTabId) return false;

    const layout = layoutsByTab[currentWorkspaceId]?.[activeTabId];
    if (!layout) return false;

    return findPaneByTerminalId(layout, terminalId) !== null;
  },

  revealTerminal: (workspaceId, terminalId) => {
    const { layoutsByTab, tabsByWorkspace, focusedPaneByTab, activeTabByWorkspace } = get();
    const layouts = layoutsByTab[workspaceId] ?? {};
    for (const tabId of tabsByWorkspace[workspaceId] ?? []) {
      const pane = layouts[tabId] && findPaneByTerminalId(layouts[tabId], terminalId);
      if (!pane) continue;
      set({
        activeTabByWorkspace: { ...activeTabByWorkspace, [workspaceId]: tabId },
        focusedPaneByTab: {
          ...focusedPaneByTab,
          [workspaceId]: { ...focusedPaneByTab[workspaceId], [tabId]: pane.id },
        },
      });
      return true;
    }
    return false;
  },

  clearWorkspaceLayout: (workspaceId) => {
    const { layoutsByTab, tabsByWorkspace, focusedPaneByTab, activeTabByWorkspace } = get();
    const newLayouts = { ...layoutsByTab };
    const newTabs = { ...tabsByWorkspace };
    const newFocused = { ...focusedPaneByTab };
    const newActive = { ...activeTabByWorkspace };

    delete newLayouts[workspaceId];
    delete newTabs[workspaceId];
    delete newFocused[workspaceId];
    delete newActive[workspaceId];

    set({
      layoutsByTab: newLayouts,
      tabsByWorkspace: newTabs,
      focusedPaneByTab: newFocused,
      activeTabByWorkspace: newActive,
    });
  },

  applyWorkspaceLayout: (workspaceId, data, options) => {
    const { layoutsByTab, tabsByWorkspace, focusedPaneByTab, activeTabByWorkspace } = get();
    set({
      layoutsByTab: { ...layoutsByTab, [workspaceId]: data.layouts },
      tabsByWorkspace: { ...tabsByWorkspace, [workspaceId]: data.tabs },
      focusedPaneByTab: { ...focusedPaneByTab, [workspaceId]: data.focusedPanes },
      activeTabByWorkspace: { ...activeTabByWorkspace, [workspaceId]: data.activeTab },
      ...(options?.setCurrentWorkspace === false ? {} : { currentWorkspaceId: workspaceId }),
    });
  },

  reorderTabs: (workspaceId, fromIndex, toIndex) => {
    const { tabsByWorkspace } = get();
    const tabs = tabsByWorkspace[workspaceId];
    if (!tabs) return;
    if (fromIndex < 0 || fromIndex >= tabs.length || toIndex < 0 || toIndex >= tabs.length) return;
    if (fromIndex === toIndex) return;

    const newTabs = [...tabs];
    const [moved] = newTabs.splice(fromIndex, 1);
    newTabs.splice(toIndex, 0, moved);
    set({ tabsByWorkspace: { ...tabsByWorkspace, [workspaceId]: newTabs } });
  },

  selectNextTab: () => {
    const { currentWorkspaceId, tabsByWorkspace, activeTabByWorkspace } = get();
    if (!currentWorkspaceId) return;
    const tabs = tabsByWorkspace[currentWorkspaceId] || [];
    if (tabs.length <= 1) return;
    const activeTab = activeTabByWorkspace[currentWorkspaceId];
    const currentIndex = tabs.indexOf(activeTab);
    const nextIndex = (currentIndex + 1) % tabs.length;
    set({
      activeTabByWorkspace: { ...activeTabByWorkspace, [currentWorkspaceId]: tabs[nextIndex] },
    });
  },

  selectPreviousTab: () => {
    const { currentWorkspaceId, tabsByWorkspace, activeTabByWorkspace } = get();
    if (!currentWorkspaceId) return;
    const tabs = tabsByWorkspace[currentWorkspaceId] || [];
    if (tabs.length <= 1) return;
    const activeTab = activeTabByWorkspace[currentWorkspaceId];
    const currentIndex = tabs.indexOf(activeTab);
    const prevIndex = currentIndex <= 0 ? tabs.length - 1 : currentIndex - 1;
    set({
      activeTabByWorkspace: { ...activeTabByWorkspace, [currentWorkspaceId]: tabs[prevIndex] },
    });
  },
}));
