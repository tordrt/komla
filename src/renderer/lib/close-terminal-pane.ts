import { useLayoutStore } from '@/stores/layout.store';
import { setTerminalClosing, useTerminalCloseStore } from '@/stores/terminal-close.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isLocalTerminalExecutionLocation, type Workspace } from '@/types';

import { createLeaf, findPaneByTerminalId, showsPaneSurface } from './layout-utils';
import { disposeTerminalRenderer } from './terminal-renderer-runtime';

import type { LayoutNode, PaneId } from '@/types/layout';

const workspaceCloseQueues = new Map<string, Promise<void>>();
const pendingTerminalExitIds = new Set<string>();
interface WorkspaceLayoutSnapshot {
  tabs: string[];
  layouts: Record<string, LayoutNode>;
  focusedPanes: Record<string, PaneId>;
  activeTab: string;
}

interface WorkspaceLayoutReferences {
  tabs: string[] | undefined;
  layouts: Record<string, LayoutNode> | undefined;
  focusedPanes: Record<string, PaneId> | undefined;
  activeTab: string | undefined;
}

interface OptimisticClose {
  snapshot: WorkspaceLayoutSnapshot | undefined;
  expectedLayout: WorkspaceLayoutReferences;
}

function captureWorkspaceLayoutReferences(workspaceId: string): WorkspaceLayoutReferences {
  const layout = useLayoutStore.getState();
  return {
    tabs: layout.tabsByWorkspace[workspaceId],
    layouts: layout.layoutsByTab[workspaceId],
    focusedPanes: layout.focusedPaneByTab[workspaceId],
    activeTab: layout.activeTabByWorkspace[workspaceId],
  };
}

function beginOptimisticClose(workspaceId: string, terminalId: string): OptimisticClose {
  const layout = useLayoutStore.getState();
  const activeTab = layout.activeTabByWorkspace[workspaceId];
  const snapshot = activeTab
    ? {
        tabs: layout.tabsByWorkspace[workspaceId] ?? [],
        layouts: layout.layoutsByTab[workspaceId] ?? {},
        focusedPanes: layout.focusedPaneByTab[workspaceId] ?? {},
        activeTab,
      }
    : undefined;
  layout.removeTerminalPane(workspaceId, terminalId);
  return { snapshot, expectedLayout: captureWorkspaceLayoutReferences(workspaceId) };
}

function workspaceLayoutMatches(workspaceId: string, expected: WorkspaceLayoutReferences): boolean {
  const layout = useLayoutStore.getState();
  return (
    layout.tabsByWorkspace[workspaceId] === expected.tabs &&
    layout.layoutsByTab[workspaceId] === expected.layouts &&
    layout.focusedPaneByTab[workspaceId] === expected.focusedPanes &&
    layout.activeTabByWorkspace[workspaceId] === expected.activeTab
  );
}

function restoreTerminalAsTab(workspaceId: string, terminalId: string): void {
  const layout = useLayoutStore.getState();
  const workspaceLayouts = layout.layoutsByTab[workspaceId] ?? {};
  const tabs = layout.tabsByWorkspace[workspaceId] ?? [];
  if (
    tabs.some((tabId) => {
      const root = workspaceLayouts[tabId];
      return root ? findPaneByTerminalId(root, terminalId) !== null : false;
    })
  ) {
    return;
  }

  const leaf = createLeaf(terminalId);
  layout.applyWorkspaceLayout(
    workspaceId,
    {
      tabs: tabs.includes(terminalId) ? tabs : [...tabs, terminalId],
      layouts: { ...workspaceLayouts, [terminalId]: leaf },
      focusedPanes: {
        ...layout.focusedPaneByTab[workspaceId],
        [terminalId]: leaf.id,
      },
      activeTab: layout.activeTabByWorkspace[workspaceId] ?? terminalId,
    },
    { setCurrentWorkspace: false }
  );
}

function finishOptimisticClose(
  workspaceId: string,
  terminalId: string,
  removed: boolean,
  optimisticClose: OptimisticClose
): void {
  const layout = useLayoutStore.getState();
  if (removed) {
    layout.removeTerminalPane(workspaceId, terminalId);
    return;
  }

  if (
    optimisticClose.snapshot &&
    workspaceLayoutMatches(workspaceId, optimisticClose.expectedLayout)
  ) {
    layout.applyWorkspaceLayout(workspaceId, optimisticClose.snapshot, {
      setCurrentWorkspace: false,
    });
    return;
  }

  restoreTerminalAsTab(workspaceId, terminalId);
}

/** @internal Exposed for test cleanup only. */
export function _resetPendingTerminalExits(): void {
  pendingTerminalExitIds.clear();
}

function terminalExitShouldClosePane(terminalId: string): boolean | undefined {
  for (const workspace of useWorkspacesStore.getState().workspaces) {
    const terminal = workspace.terminals.find((candidate) => candidate.id === terminalId);
    if (!terminal) continue;
    return (
      workspace.backend?.kind !== 'ssh' ||
      isLocalTerminalExecutionLocation(terminal.executionLocation)
    );
  }
  return undefined;
}

function runTerminalClose(terminalId: string, close: (id: string) => Promise<void>): void {
  void close(terminalId).catch((error: unknown) => {
    console.error('Failed to clean up exited terminal:', error);
  });
}

export async function closeTerminalPane(terminalId: string): Promise<void> {
  const closingTerminalIds = useTerminalCloseStore.getState().closingTerminalIds;
  if (closingTerminalIds.has(terminalId)) return;

  const workspaceState = useWorkspacesStore.getState();
  const workspace = workspaceState.workspaces.find((candidate) =>
    candidate.terminals.some((terminal) => terminal.id === terminalId)
  );
  if (!workspace) return;

  const terminal = workspace.terminals.find((candidate) => candidate.id === terminalId);
  const isRemoteSshTerminal =
    workspace.backend?.kind === 'ssh' && terminal?.executionLocation !== 'local-mirror';

  setTerminalClosing(terminalId, true);
  const optimisticClose = beginOptimisticClose(workspace.id, terminalId);
  const previousClose = workspaceCloseQueues.get(workspace.id) ?? Promise.resolve();
  const close = previousClose
    .catch(() => {})
    .then(async () => {
      const currentWorkspace = useWorkspacesStore
        .getState()
        .workspaces.find((candidate) => candidate.id === workspace.id);
      if (!currentWorkspace?.terminals.some((terminal) => terminal.id === terminalId)) {
        finishOptimisticClose(workspace.id, terminalId, true, optimisticClose);
        disposeTerminalRenderer(terminalId);
        return;
      }

      try {
        await useWorkspacesStore.getState().removeTerminal(workspace.id, terminalId);
      } catch (error) {
        finishOptimisticClose(workspace.id, terminalId, false, optimisticClose);
        useToastStore
          .getState()
          .addToast(
            isRemoteSshTerminal
              ? "Couldn't close the remote terminal. The pane was left open."
              : "Couldn't close the terminal. The pane was left open.",
            'error'
          );
        throw error;
      }
      finishOptimisticClose(workspace.id, terminalId, true, optimisticClose);
      disposeTerminalRenderer(terminalId);

      // A browser or note pane keeps the workspace open without a terminal.
      const refreshedWorkspace = useWorkspacesStore
        .getState()
        .workspaces.find((candidate) => candidate.id === workspace.id);
      if (
        (!refreshedWorkspace || refreshedWorkspace.terminals.length === 0) &&
        !showsPaneSurface(useLayoutStore.getState().layoutsByTab[workspace.id])
      ) {
        await useWorkspacesStore.getState().stopWorkspace(workspace.id);
      }
    });
  workspaceCloseQueues.set(workspace.id, close);

  try {
    await close;
  } finally {
    setTerminalClosing(terminalId, false);
    if (workspaceCloseQueues.get(workspace.id) === close) {
      workspaceCloseQueues.delete(workspace.id);
    }
  }
}

export function reconcileRemovedTerminalPanes(updatedWorkspace: Workspace): void {
  const currentWorkspace = useWorkspacesStore
    .getState()
    .workspaces.find((workspace) => workspace.id === updatedWorkspace.id);
  if (!currentWorkspace) return;

  const updatedTerminalIds = new Set(updatedWorkspace.terminals.map((terminal) => terminal.id));
  let removedTerminal = false;
  for (const terminal of currentWorkspace.terminals) {
    if (updatedTerminalIds.has(terminal.id)) continue;
    removedTerminal = true;
    useLayoutStore.getState().removeTerminalPane(updatedWorkspace.id, terminal.id);
    disposeTerminalRenderer(terminal.id);
  }

  if (
    removedTerminal &&
    updatedWorkspace.terminals.length === 0 &&
    !showsPaneSurface(useLayoutStore.getState().layoutsByTab[updatedWorkspace.id])
  ) {
    useLayoutStore.getState().clearWorkspaceLayout(updatedWorkspace.id);
    if (useLayoutStore.getState().currentWorkspaceId === updatedWorkspace.id) {
      useLayoutStore.getState().setCurrentWorkspace(null);
    }
    if (useWorkspacesStore.getState().selectedWorkspaceId === updatedWorkspace.id) {
      useWorkspacesStore.setState({ selectedWorkspaceId: null });
    }
  }
}

/**
 * Frees the renderer and pane of every terminal that is gone, however it went: replaced by a
 * restart this window didn't run, or its workspace deleted elsewhere. A stop elsewhere keeps the
 * terminal, so its pane stays until a restart replaces it. Returns the unsubscribe function.
 */
export function disposeRenderersOfRemovedTerminals(): () => void {
  return useWorkspacesStore.subscribe((state, previous) => {
    if (state.workspaces === previous.workspaces) return;
    const currentWorkspaceIds = new Set(state.workspaces.map((workspace) => workspace.id));
    const currentTerminalIds = new Set(
      state.workspaces.flatMap((workspace) => workspace.terminals.map((terminal) => terminal.id))
    );
    for (const workspace of previous.workspaces) {
      const workspaceRemoved = !currentWorkspaceIds.has(workspace.id);
      for (const terminal of workspace.terminals) {
        if (currentTerminalIds.has(terminal.id)) continue;
        if (!workspaceRemoved) {
          useLayoutStore.getState().removeTerminalPane(workspace.id, terminal.id);
        }
        disposeTerminalRenderer(terminal.id);
      }
      if (workspaceRemoved) useLayoutStore.getState().clearWorkspaceLayout(workspace.id);
    }
  });
}

export function handleTerminalExit(
  terminalId: string,
  exitCode: number,
  signal?: number,
  close: (id: string) => Promise<void> = closeTerminalPane
): void {
  if (exitCode !== 0 || signal) return;

  const shouldClosePane = terminalExitShouldClosePane(terminalId);
  if (shouldClosePane === undefined) {
    pendingTerminalExitIds.add(terminalId);
    return;
  }

  if (shouldClosePane) runTerminalClose(terminalId, close);
}

export function retryPendingTerminalExits(
  close: (id: string) => Promise<void> = closeTerminalPane
): void {
  for (const terminalId of pendingTerminalExitIds) {
    const shouldClosePane = terminalExitShouldClosePane(terminalId);
    if (shouldClosePane === undefined) continue;
    pendingTerminalExitIds.delete(terminalId);
    if (shouldClosePane) runTerminalClose(terminalId, close);
  }
}

/**
 * Closes the pane of an exit that arrived before its terminal was known, once it is.
 * Returns the unsubscribe function.
 */
export function retryPendingTerminalExitsOnChange(): () => void {
  return useWorkspacesStore.subscribe((state, previous) => {
    if (state.workspaces !== previous.workspaces) retryPendingTerminalExits();
  });
}
