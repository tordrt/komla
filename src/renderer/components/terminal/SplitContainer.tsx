import React, { useCallback, useMemo, useEffect } from 'react';

import { useShortcuts } from '@/hooks/useShortcuts';
import { closeTerminalPane } from '@/lib/close-terminal-pane';
import { ipcErrorMessage } from '@/lib/ipc-error-message';
import { getAllLeaves } from '@/lib/layout-utils';
import { showPaneMenuHintOnce } from '@/lib/pane-menu-hint';
import {
  closingPanesStopsWorkspace,
  confirmStoppingWorkspace,
  requestClosePaneSurface,
} from '@/lib/pane-surfaces';
import { registerShortcutAction } from '@/lib/shortcut-actions';
import { addTerminalForSplit } from '@/lib/split-terminal';
import { focusTerminalRenderer } from '@/lib/terminal-renderer-runtime';
import { useCustomizationStore } from '@/stores/customization.store';
import { useLayoutStore } from '@/stores/layout.store';
import { useTerminalCloseStore } from '@/stores/terminal-close.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { isPaneSurfaceId } from '../../../shared/lib/pane-surface-id';

import { PaneRenderer } from './PaneRenderer';

interface SplitContainerProps {
  tabId: string;
  isActive: boolean;
  workspaceId?: string;
}

export function SplitContainer({ tabId, isActive, workspaceId }: SplitContainerProps) {
  // Use individual selectors to minimize re-renders
  const currentWorkspaceId = useLayoutStore((s) => s.currentWorkspaceId);
  const splitPane = useLayoutStore((s) => s.splitPane);
  const setFocusedPane = useLayoutStore((s) => s.setFocusedPane);

  const addTerminal = useWorkspacesStore((s) => s.addTerminal);

  // Use the explicit workspaceId prop for layout/focus lookups so hidden workspaces resolve correctly
  const effectiveWorkspaceId = workspaceId || currentWorkspaceId;

  // Get layout for THIS tab with selector
  const root = useLayoutStore((s) =>
    effectiveWorkspaceId ? s.layoutsByTab[effectiveWorkspaceId]?.[tabId] || null : null
  );
  const focusedPaneId = useLayoutStore((s) =>
    effectiveWorkspaceId ? s.focusedPaneByTab[effectiveWorkspaceId]?.[tabId] || null : null
  );

  const closingTerminalIds = useTerminalCloseStore((s) => s.closingTerminalIds);
  // Hidden only once the config has loaded, so a split tab restored at launch can't show the hint
  // to someone who turned headers on.
  const paneHeadersHidden = useCustomizationStore(
    (s) => s.terminalConfig?.showPaneHeaders === false
  );
  const isSplit = root?.type === 'split';

  useEffect(() => {
    if (isActive && isSplit && paneHeadersHidden) showPaneMenuHintOnce();
  }, [isActive, isSplit, paneHeadersHidden]);
  const isLayoutLocked = useMemo(
    () => !!root && getAllLeaves(root).some((leaf) => closingTerminalIds.has(leaf.terminalId)),
    [closingTerminalIds, root]
  );
  // Shortcut handlers. They read the selected workspace when they run: subscribed, each title
  // change in it would re-render every tab's split container.
  const splitFocusedPane = useCallback(
    async (direction: 'vertical' | 'horizontal') => {
      if (isLayoutLocked || !root || !focusedPaneId) return;
      const { workspaces, selectedWorkspaceId } = useWorkspacesStore.getState();
      const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId);
      if (!selectedWorkspaceId || !selectedWorkspace) return;
      const focusedTerminalId = getAllLeaves(root).find(
        (leaf) => leaf.id === focusedPaneId
      )?.terminalId;
      const focusedTerminal = selectedWorkspace.terminals.find(
        (terminal) => terminal.id === focusedTerminalId
      );
      try {
        const terminal = await addTerminalForSplit(
          addTerminal,
          selectedWorkspaceId,
          focusedTerminal
        );
        splitPane(direction, terminal.id);
      } catch (err) {
        console.error('Failed to create terminal for split:', err);
        useToastStore
          .getState()
          .addToast(`Failed to split the pane: ${ipcErrorMessage(err)}`, 'error');
      }
    },
    [isLayoutLocked, root, focusedPaneId, addTerminal, splitPane]
  );
  const handleSplitRight = useCallback(() => splitFocusedPane('vertical'), [splitFocusedPane]);
  const handleSplitDown = useCallback(() => splitFocusedPane('horizontal'), [splitFocusedPane]);

  const handleClosePane = useCallback(async () => {
    if (isLayoutLocked || !root || !effectiveWorkspaceId) return;

    // Get fresh focusedPaneId from store to avoid stale closure issues
    // (e.g., when TerminalPane's X button calls setFocusedPane then executeShortcutAction)
    const layoutState = useLayoutStore.getState();
    const activeTabId = layoutState.activeTabByWorkspace[effectiveWorkspaceId];
    const currentFocusedPaneId = activeTabId
      ? layoutState.focusedPaneByTab[effectiveWorkspaceId]?.[activeTabId]
      : null;
    if (!currentFocusedPaneId) return;

    // Find the terminal in the pane to delete
    const leaves = getAllLeaves(root);
    const paneToClose = leaves.find((l) => l.id === currentFocusedPaneId);
    const terminalInPane = paneToClose?.terminalId;
    if (!terminalInPane) return;
    if (isPaneSurfaceId(terminalInPane)) {
      await requestClosePaneSurface(effectiveWorkspaceId, terminalInPane);
      return;
    }
    // Cmd+W is easy to hit by accident, and on the last pane it stops the whole workspace.
    if (
      closingPanesStopsWorkspace(effectiveWorkspaceId, [terminalInPane]) &&
      !(await confirmStoppingWorkspace(effectiveWorkspaceId))
    ) {
      // Cancelling leaves focus on the document body, not the terminal the close came from.
      focusTerminalRenderer(terminalInPane);
      return;
    }

    try {
      await closeTerminalPane(terminalInPane);
    } catch (err) {
      console.error('Failed to remove terminal:', err);
    }
  }, [isLayoutLocked, root, effectiveWorkspaceId]);

  const handleFocusNext = useCallback(() => {
    if (!root) return;
    const leaves = getAllLeaves(root);
    if (leaves.length <= 1) return;

    const currentIndex = leaves.findIndex((l) => l.id === focusedPaneId);
    const newIndex = (currentIndex + 1) % leaves.length;
    setFocusedPane(leaves[newIndex].id);
  }, [root, focusedPaneId, setFocusedPane]);

  const handleFocusPrev = useCallback(() => {
    if (!root) return;
    const leaves = getAllLeaves(root);
    if (leaves.length <= 1) return;

    const currentIndex = leaves.findIndex((l) => l.id === focusedPaneId);
    const newIndex = currentIndex <= 0 ? leaves.length - 1 : currentIndex - 1;
    setFocusedPane(leaves[newIndex].id);
  }, [root, focusedPaneId, setFocusedPane]);

  // Memoize handlers to prevent re-registering on every render
  const shortcutHandlers = useMemo(
    () => ({
      'pane.splitRight': handleSplitRight,
      'pane.splitDown': handleSplitDown,
      'pane.close': handleClosePane,
      'pane.focusNext': handleFocusNext,
      'pane.focusPrev': handleFocusPrev,
    }),
    [handleSplitRight, handleSplitDown, handleClosePane, handleFocusNext, handleFocusPrev]
  );

  // Register shortcuts only when this tab is active
  useShortcuts(shortcutHandlers, isActive);

  // Register pane actions with the global dispatcher
  // This allows TerminalView to execute them directly when xterm captures keys
  useEffect(() => {
    if (!isActive) return;

    const cleanups = [
      registerShortcutAction('pane.splitRight', handleSplitRight),
      registerShortcutAction('pane.splitDown', handleSplitDown),
      registerShortcutAction('pane.close', handleClosePane),
      registerShortcutAction('pane.focusNext', handleFocusNext),
      registerShortcutAction('pane.focusPrev', handleFocusPrev),
    ];

    return () => cleanups.forEach((cleanup) => cleanup());
  }, [
    isActive,
    handleSplitRight,
    handleSplitDown,
    handleClosePane,
    handleFocusNext,
    handleFocusPrev,
  ]);

  if (!root) {
    return null;
  }

  return (
    <div className="h-full min-h-0 w-full">
      <PaneRenderer
        node={root}
        isTabActive={isActive}
        isLayoutLocked={isLayoutLocked}
        workspaceId={workspaceId}
        isOnlyPane={root.type === 'leaf'}
      />
    </div>
  );
}
