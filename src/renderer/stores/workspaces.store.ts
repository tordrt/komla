import { create, type StoreApi } from 'zustand';

import {
  DEFAULT_WORKSPACE_TAGS,
  UNTAGGED_WORKSPACE_TAG_KEY,
  workspaceTagKey,
} from '../../shared/lib/workspace-tags';
import { workspaceCreateException } from '../../shared/types/workspace';
import { getProjectIdsWithListedGroups } from '../components/workspaces/workspace-list-filtering';
import { getWorkspaceDisplayTitle } from '../components/workspaces/WorkspaceInfoCard';
import { ipcErrorMessage } from '../lib/ipc-error-message';
import {
  confirmDiscardingUnsavedFiles,
  getUnsavedFileNames,
  handOffWorkspacePaneSurfaces,
} from '../lib/pane-surfaces';
import { readStoredCollapsedGroups, storeCollapsedGroups } from '../lib/sidebar-collapsed-groups';
import {
  disposeTerminalRenderers,
  getTerminalRendererDimensions,
} from '../lib/terminal-renderer-runtime';
import { getWorkspaceHostId, isWorkspaceHostVisible } from '../lib/workspace-host';
import {
  buildWorkspaceLayoutHydration,
  hydratePersistedWorkspaceLayout,
  isWorkspaceLayoutPlaceholder,
} from '../lib/workspace-layout-hydration';
import { getSelectionLinkChange } from '../lib/workspace-links';
import {
  canStop,
  isWorkspaceAttentionActionable,
  isWorkspaceCreateError,
  isWorkspaceRestartError,
  isSshWorkspace,
  isHiddenByHideStopped,
  isRunningHere,
  needsAttention,
  probesOnSelect,
  reconnectableTerminals,
} from '../types';
import {
  isOpenCodeHoldsWorktreeError,
  isRunningLimitError,
  showUpgradeDialog,
  stripErrorPrefix,
} from '../utils/workspace-error';

import { nudgeAgentSetup } from './agent-setup-nudge.store';
import { useConfigStore } from './config.store';
import { useDevServerPreviewStore } from './dev-server-preview.store';
import { useFileListStore } from './file-list.store';
import { useFileViewerStore } from './file-viewer.store';
import { useLayoutStore } from './layout.store';
import { useLicenseStore } from './license.store';
import { useProjectsStore } from './projects.store';
import { useSshCommandExecutionLocationStore } from './ssh-command-execution-location.store';
import { useSshHostsStore } from './ssh-hosts.store';
import { useTerminalBusyStore } from './terminal-busy.store';
import { useToastStore } from './toast.store';
import { useWindowStore } from './window.store';
import { useWorktreeEventsStore } from './worktree-events.store';

import type { WorkspaceGrouping } from '../../shared/lib/workspace-grouping';
import type { WorkspaceTrashRequest } from '../../shared/types/workspace';
import type {
  ActionSshExecutionLocation,
  Workspace,
  Terminal,
  TerminalStatus,
  TerminalLaunchLocation,
  CreateWorkspaceParams,
  WorkspaceAttention,
  WorkspaceRestartResult,
  RestartTerminalOptions,
  AddAgentTabOptions,
} from '../types';

// Track workspace IDs with in-flight backend deletions so that loadWorkspaces()
// (triggered by unrelated WORKSPACE_UPDATED events) doesn't resurrect them.
const pendingDeletions = new Set<string>();

/** @internal Exposed for test cleanup only. */
export function _resetPendingDeletions(): void {
  pendingDeletions.clear();
}

// Debounce tracking for dynamic title persistence
const dynamicTitleDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
const DYNAMIC_TITLE_DEBOUNCE_MS = 1000;

// Debounce tracking for attention clearing — prevents notifications from being
// cleared when quickly scrolling through workspaces with keyboard shortcuts.
let pendingAttentionClear: {
  timer: ReturnType<typeof setTimeout>;
  workspaceId: string;
  attention: WorkspaceAttention | undefined;
  needsAttention: boolean;
} | null = null;
const ATTENTION_CLEAR_DELAY_MS = 500;
// An unread mark is cleared the same way, once its workspace stays open that long.
let pendingUnreadClear: ReturnType<typeof setTimeout> | undefined;

/** Cancel any pending dynamic-title debounce for a terminal. */
function cancelDynamicTitleDebounce(terminalId: string): void {
  const timer = dynamicTitleDebounceTimers.get(terminalId);
  if (timer) {
    clearTimeout(timer);
    dynamicTitleDebounceTimers.delete(terminalId);
  }
}

function applyLayoutHints(
  workspaceId: string,
  workspace: Workspace,
  options?: { setCurrentWorkspace?: boolean }
): void {
  const hydrated = buildWorkspaceLayoutHydration(workspace);
  if (!hydrated) return;

  useLayoutStore.getState().applyWorkspaceLayout(workspaceId, hydrated, options);
}

// Strip non-actionable attention from the currently selected workspace.
// The main process stores attention on all workspaces (it doesn't track per-window selection),
// so the renderer must enforce the invariant: the active workspace card only keeps
// actionable badges. Terminal-scoped informational attention stays on the terminal.
function clearAttentionForSelected(
  workspaces: Workspace[],
  selectedId: string | null
): Workspace[] {
  if (!selectedId) return workspaces;
  let changed = false;
  const next = workspaces.map((w) => {
    if (w.id !== selectedId || !(w.needsAttention || w.attention)) return w;
    // Keep only terminal-scoped actionable attention; the workspace card itself
    // never badges while selected.
    const keep = !!w.attention?.terminalId && isWorkspaceAttentionActionable(w.attention);
    if (keep) return w;
    changed = true;
    return { ...w, needsAttention: false, attention: undefined };
  });
  // The same array when nothing changed, so a switch doesn't re-render every workspace subscriber.
  return changed ? next : workspaces;
}

function refreshWorkspaceQuota(): void {
  void useLicenseStore.getState().loadQuota();
}

// Pre-fetch file list cache for a workspace directory
function prefetchWorkspaceFileList(workspace: Workspace): void {
  if (isSshWorkspace(workspace)) return;
  const workingDirectory = workspace.workingDirectory;
  const { fetchFileListIfNeeded, fetchFileStatusesIfNeeded } = useFileListStore.getState();
  fetchFileListIfNeeded(workingDirectory).catch(() => {});
  fetchFileStatusesIfNeeded(workingDirectory).catch(() => {});
}

function refreshLinkedWorkspaceFileLists(workspaces: Workspace[], workspaceIds: string[]): void {
  const ids = new Set(workspaceIds);
  if (ids.size === 0) return;

  const fileListStore = useFileListStore.getState();
  const showGitIgnoredByWorkspace = useFileViewerStore.getState().showGitIgnoredByWorkspace;
  for (const workspace of workspaces) {
    if (!ids.has(workspace.id)) continue;
    const isRemoteWorkspace = isSshWorkspace(workspace);
    useFileListStore.setState((state) => {
      const cache = new Map(state.cache);
      cache.delete(workspace.workingDirectory);
      if (isRemoteWorkspace) return { cache };
      const statusCache = new Map(state.statusCache);
      statusCache.delete(workspace.workingDirectory);
      return { cache, statusCache };
    });
    fileListStore
      .fetchFileList(
        workspace.workingDirectory,
        !!showGitIgnoredByWorkspace[workspace.id],
        isRemoteWorkspace ? workspace.id : undefined
      )
      .catch(() => {});
    if (!isRemoteWorkspace) {
      fileListStore.fetchFileStatuses(workspace.workingDirectory).catch(() => {});
    }
  }
}

interface WorkspacesState {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  keyboardNavigationWorkspaceId: string | null;
  showDashboard: boolean;
  isLoading: boolean;
  hasLoaded: boolean;
  error: string | null;
  hideStopped: boolean;
  /** Working workspaces sit on the sidebar's Working shelf until an agent needs the user. */
  hideWorking: boolean;
  collapsedSections: Set<string>;
  /** Sidebar groups the user collapsed, by group key; persisted per machine. */
  collapsedWorkspaceGroupKeys: Set<string>;
  /** The sidebar sets each project on a panel, or lists every workspace together. */
  grouping: WorkspaceGrouping;
  dashboardFilterProject: string | null;
  hiddenProjectIds: Set<string>;
  hiddenWorkspaceHostIds: Set<string>;
  /**
   * Tags, by `workspaceTagKey`, whose workspaces sit on the sidebar's Filtered shelf, with
   * `UNTAGGED_WORKSPACE_TAG_KEY` for those without a tag.
   */
  hiddenWorkspaceTags: Set<string>;
  dashboardHiddenWorkspaceHostIds: Set<string>;
  displayOrderedWorkspaceIds: string[] | null;
  restartingWorkspaceIds: Set<string>;
  reconnectingSshWorkspaceIds: Set<string>;

  // Multi-select
  selectionMode: boolean;
  selectedWorkspaceIds: Set<string>;
  lastSelectedWorkspaceId: string | null;

  // Multi-select actions
  enterSelectionMode: (workspaceId: string) => void;
  exitSelectionMode: () => void;
  toggleWorkspaceSelection: (workspaceId: string) => void;
  /** Takes workspaces out of the multi-selection, such as ones the sidebar put out of sight. */
  deselectWorkspaces: (workspaceIds: string[]) => void;
  shiftSelectWorkspaces: (workspaceId: string, orderedIds: string[]) => void;
  selectAllWorkspaces: () => void;

  // Bulk actions
  stopSelectedWorkspaces: () => Promise<void>;
  trashSelectedWorkspaces: () => Promise<void>;
  trashWorkspaces: (workspaceIds: string[]) => Promise<void>;
  deleteSelectedWorkspaces: (force?: boolean, deleteBranch?: boolean) => Promise<void>;
  deleteWorkspaces: (
    workspaceIds: string[],
    force?: boolean,
    deleteBranch?: boolean
  ) => Promise<void>;
  markSelectedUnread: () => void;
  /** Pins every selected workspace, or unpins them when all are pinned. */
  togglePinSelected: () => void;
  /** As snoozeWorkspace, for every selected workspace. */
  snoozeSelected: (until: number | undefined, wakesOnNotification?: boolean) => void;
  moveSelectedToWindow: (windowId: string) => Promise<void>;
  toggleLinkSelected: () => Promise<void>;

  // Actions
  loadWorkspaces: (preferredWorkspaceId?: string) => Promise<void>;
  createWorkspace: (params: CreateWorkspaceParams) => Promise<Workspace>;
  createWorkspaces: (params: CreateWorkspaceParams[]) => Promise<Workspace[]>;
  addTerminal: (
    workspaceId: string,
    name?: string,
    command?: string | null,
    layoutHint?: 'tab' | 'split-right' | 'split-bottom',
    commandKind?: 'agent' | 'host' | 'host-shell',
    executionLocation?: TerminalLaunchLocation
  ) => Promise<Terminal>;
  addTerminalCommand: (
    workspaceId: string,
    name: string,
    command: string,
    layoutHint?: 'tab' | 'split-right' | 'split-bottom',
    sshExecutionLocation?: ActionSshExecutionLocation
  ) => Promise<Terminal | null>;
  addAgentTab: (
    workspaceId: string,
    prompt?: string,
    launchModeId?: string,
    presetId?: string,
    options?: AddAgentTabOptions
  ) => Promise<Terminal>;
  removeTerminal: (workspaceId: string, terminalId: string) => Promise<void>;
  /** Resolves to why it failed, if it did; `quiet` leaves telling the user to the caller. */
  stopWorkspace: (
    workspaceId: string,
    options?: { quiet?: boolean }
  ) => Promise<string | undefined>;
  stopTerminal: (terminalId: string) => Promise<void>;
  restartTerminal: (
    terminalId: string,
    presetId?: string,
    launchModeId?: string | null,
    cols?: number,
    rows?: number,
    options?: RestartTerminalOptions
  ) => Promise<boolean>;
  reconnectSshTerminal: (terminalId: string, cols?: number, rows?: number) => Promise<void>;
  reconnectAllSshTerminals: (workspaceId: string) => Promise<void>;
  /** Reconnects what selecting the workspace on screen would, e.g. once the network is back. */
  reconnectAfterNetworkReturns: () => Promise<void>;
  /** Resolves once the workspace is gone locally; `onSettled` runs when main has finished deleting it, or failed to. */
  deleteWorkspace: (
    workspaceId: string,
    force?: boolean,
    deleteBranch?: boolean,
    onSettled?: () => void
  ) => Promise<void>;
  /** Drops a workspace and its renderer state without asking main to delete it. */
  removeWorkspaceLocally: (workspaceId: string) => void;
  /** Removes an SSH workspace whose files are gone from its host from this device only. */
  removeMissingSshWorkspace: (workspaceId: string) => Promise<void>;
  /** Resolves undefined when unsaved edits in its file panes stay. */
  restartWorkspace: (workspaceId: string) => Promise<WorkspaceRestartResult | undefined>;
  reorderWorkspace: (workspaceId: string, newOrder: number) => Promise<void>;
  updateTerminalStatus: (terminalId: string, status: TerminalStatus) => void;
  updateWorkspace: (workspaceId: string, updates: Partial<Workspace>) => void;
  /** Makes an Action picked from a list the one the workspace's run button repeats. */
  setDefaultAction: (workspaceId: string, actionId: string) => void;
  /** Makes an Action run from a terminal's right-click menu the one that menu repeats. */
  setPaneDefaultAction: (workspaceId: string, actionId: string) => void;
  selectWorkspace: (workspaceId: string | null) => Promise<void>;
  setNeedsAttention: (workspaceId: string, value: boolean) => void;
  /**
   * Shows attention a Terminal raised, and what its workspace's card shows by Komla's precedence.
   * windowFocused=false keeps the selected workspace's card badge for terminal attention.
   */
  setAttention: (
    workspaceId: string,
    attention: WorkspaceAttention,
    workspaceAttention: WorkspaceAttention,
    options?: { windowFocused?: boolean }
  ) => void;
  /** Shows the workspace as unread until it's next opened. */
  markUnread: (workspaceId: string) => void;
  /**
   * Shows the pin, tag, snooze and unread mark of a workspace main updated; true when the open
   * workspace just woke from a snooze.
   */
  receiveWorkspaceMarks: (workspace: Workspace) => boolean;
  /** Clears the Woke mark main just set, if the workspace is the one open. */
  dismissWokeIfOpen: (workspaceId: string) => void;
  /** Lists the workspace on the Pinned shelf at the top of the sidebar, or unpins it. */
  setPinned: (workspaceId: string, pinned: boolean) => void;
  /**
   * Puts a tag, such as "Waiting for review", on the workspaces, or takes theirs off. A tag the
   * user puts on has no `tagSource`; a rename keeps the one Komla put on from a pull request.
   */
  setTag: (
    workspaceIds: readonly string[],
    tag: string | undefined,
    tagSource?: Workspace['tagSource']
  ) => void;
  /**
   * Keeps the workspace in the Snoozed shelf until `until`, its next notification with
   * `wakesOnNotification`, or whichever comes first; neither wakes it now.
   */
  snoozeWorkspace: (
    workspaceId: string,
    until: number | undefined,
    wakesOnNotification?: boolean
  ) => void;
  setTerminalDynamicTitle: (terminalId: string, title: string) => void;
  setPrimaryTerminal: (workspaceId: string, terminalId: string) => Promise<void>;
  /** Resolves to why it failed, if it did; `quiet` leaves telling the user to the caller. */
  moveWorkspaceToWindow: (
    workspaceId: string,
    windowId: string | null,
    options?: { quiet?: boolean }
  ) => Promise<string | undefined>;
  moveWorkspacesToWindow: (workspaceIds: string[], windowId: string | null) => Promise<void>;
  setHideStopped: (hide: boolean) => void;
  setHideWorking: (hide: boolean) => void;
  toggleCollapsedSection: (key: string) => void;
  toggleWorkspaceGroupCollapsed: (groupKey: string) => void;
  setGrouping: (grouping: WorkspaceGrouping) => void;
  setDashboardFilterProject: (projectName: string | null) => void;
  toggleWorkspaceHostVisibility: (hostId: string) => void;
  /** Lists the tag's workspaces in the sidebar again, or moves them to the Filtered shelf. */
  toggleWorkspaceTagShown: (tag: string) => void;
  /** Lists only the workspaces whose tags aren't these, the rest going to the Filtered shelf. */
  setHiddenWorkspaceTags: (tags: Iterable<string>) => void;
  /** Keeps a hidden tag hidden under its new name, or forgets it once it's deleted. */
  moveHiddenWorkspaceTag: (from: string, to: string | undefined) => void;
  showAllWorkspaceHosts: () => void;
  toggleDashboardWorkspaceHostVisibility: (hostId: string) => void;
  showAllDashboardWorkspaceHosts: () => void;
  hideProjectGroup: (projectId: string) => void;
  hideProjectGroups: (projectIds: Iterable<string>) => void;
  unhideProjectGroup: (projectId: string) => void;
  unhideProjectGroups: (projectIds: Iterable<string>) => void;
  setDisplayOrderedWorkspaceIds: (ids: string[]) => void;

  /** A restored workspace goes to the bottom of the list, unless given its `order` back. */
  setWorkspaceTrashed: (workspaceId: string, trashed: boolean, order?: number) => Promise<void>;
  /** Moves a workspace to the Trash, with a toast whose Undo puts it back and reopens it. */
  trashWorkspaceWithUndo: (
    workspaceId: string,
    message?: (title: string) => string
  ) => Promise<void>;
  /** Trashes a workspace whose agent ran `komla trash`, unless that would lose unsaved files. */
  trashWorkspaceForAgent: (request: WorkspaceTrashRequest) => Promise<void>;
  linkWorkspaces: (originId: string, targetIds: string[]) => Promise<void>;
  unlinkWorkspace: (originId: string, targetId: string) => Promise<void>;
  clearError: () => void;
}

type WorkspacesSet = StoreApi<WorkspacesState>['setState'];
type WorkspacesGet = StoreApi<WorkspacesState>['getState'];

/** A failure of something the user started, which `error` alone never puts on screen. */
function reportFailure(set: WorkspacesSet, message: string): void {
  set({ error: message });
  useToastStore.getState().addToast(message, 'error');
}

interface WorkspaceFailure {
  name: string;
  reason: string;
}

/** One toast for the workspaces a bulk action failed on, instead of one each. */
function reportBulkFailures(
  set: WorkspacesSet,
  failures: WorkspaceFailure[],
  one: (failure: WorkspaceFailure) => string,
  many: (count: number) => string
): void {
  if (failures.length === 0) return;
  reportFailure(
    set,
    failures.length === 1
      ? one(failures[0])
      : `${many(failures.length)}. First error: ${failures[0].reason}`
  );
}

const stopFailed = ({ name, reason }: WorkspaceFailure) =>
  `Failed to stop workspace "${name}": ${reason}`;
const moveFailed = ({ name, reason }: WorkspaceFailure) =>
  `Failed to move workspace "${name}" to another window: ${reason}`;

// Cancel any pending attention-clear and restore the previous workspace's
// notification. Prevents notifications from being cleared when quickly
// scrolling through workspaces with keyboard shortcuts.
function restoreDeferredAttentionClear(set: WorkspacesSet): void {
  if (!pendingAttentionClear) return;
  clearTimeout(pendingAttentionClear.timer);
  const prev = pendingAttentionClear;
  pendingAttentionClear = null;
  if (!prev.needsAttention && !prev.attention) return;
  set((state) => ({
    workspaces: state.workspaces.map((w) =>
      w.id === prev.workspaceId
        ? { ...w, needsAttention: prev.needsAttention, attention: prev.attention }
        : w
    ),
  }));
}

type WorkspaceMarks = Partial<
  Pick<
    Workspace,
    | 'unread'
    | 'pinned'
    | 'tag'
    | 'tagSource'
    | 'tagTooltip'
    | 'snoozedUntil'
    | 'wakesOnNotification'
  >
>;

/** A snooze drops any unread mark, so the card on the shelf is clean until it comes back Woke. */
function snoozeMarks(until: number | undefined, wakesOnNotification?: boolean): WorkspaceMarks {
  return until === undefined && !wakesOnNotification
    ? { snoozedUntil: undefined, wakesOnNotification: undefined }
    : {
        snoozedUntil: until,
        wakesOnNotification: wakesOnNotification || undefined,
        unread: undefined,
      };
}

/** Shows and saves unread marks, pins, tags and snoozes. */
function saveWorkspaceMarks(
  set: WorkspacesSet,
  updates: ReadonlyMap<string, WorkspaceMarks>
): void {
  if (updates.size === 0) return;
  set((state) => ({
    workspaces: state.workspaces.map((w) => {
      const update = updates.get(w.id);
      return update ? { ...w, ...update } : w;
    }),
  }));
  for (const [workspaceId, update] of updates) {
    window.api.updateWorkspace(workspaceId, update).catch((err) => {
      console.error('Failed to save the workspace:', err);
    });
  }
}

/**
 * Shows and saves the hidden tags, keeping only those still in the tag list or on a workspace, so
 * renamed and deleted tags don't pile up.
 */
function saveHiddenWorkspaceTags(
  set: WorkspacesSet,
  get: WorkspacesGet,
  hidden: ReadonlySet<string>
): void {
  const known = new Set([
    UNTAGGED_WORKSPACE_TAG_KEY,
    ...[
      ...(useConfigStore.getState().config?.workspaceTags ?? DEFAULT_WORKSPACE_TAGS).map(
        (tag) => tag.name
      ),
      ...get().workspaces.flatMap((workspace) => (workspace.tag ? [workspace.tag] : [])),
    ].map(workspaceTagKey),
  ]);
  const next = new Set([...hidden].filter((key) => known.has(key)));
  set({ hiddenWorkspaceTags: next });
  void window.api.updateConfig({ hiddenWorkspaceTags: Array.from(next) }).catch((error) => {
    console.error('Failed to persist hidden workspace tags:', error);
  });
}

function saveDefaultAction(
  get: WorkspacesGet,
  workspaceId: string,
  key: 'defaultActionId' | 'paneDefaultActionId',
  actionId: string
): void {
  const workspace = get().workspaces.find((w) => w.id === workspaceId);
  if (!workspace || workspace[key] === actionId) return;
  get().updateWorkspace(workspaceId, { [key]: actionId });
  window.api.updateWorkspace(workspaceId, { [key]: actionId }).catch((err) => {
    console.error('Failed to save the default action:', err);
  });
}

// Defer attention-clearing if the workspace has any — only commit after
// ATTENTION_CLEAR_DELAY_MS. Otherwise clear immediately.
function deferOrClearAttention(workspaceId: string, workspace: Workspace | undefined): void {
  if (workspace?.attention?.terminalId) return;
  if (workspace?.needsAttention || workspace?.attention) {
    pendingAttentionClear = {
      workspaceId,
      attention: workspace.attention,
      needsAttention: workspace.needsAttention ?? false,
      timer: setTimeout(() => {
        void window.api.clearWorkspaceAttention(workspaceId);
        pendingAttentionClear = null;
      }, ATTENTION_CLEAR_DELAY_MS),
    };
  } else {
    void window.api.clearWorkspaceAttention(workspaceId);
  }
}

// Assign the (possibly trashed) workspace to the current window if needed.
function assignWorkspaceToCurrentWindow(
  workspaceId: string,
  restartedWorkspace: Workspace,
  set: WorkspacesSet
): void {
  const currentWindowId = useWindowStore.getState().windowId;
  if (restartedWorkspace.windowId === currentWindowId) return;

  set((state) => ({
    workspaces: state.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, windowId: currentWindowId } : w
    ),
  }));
  window.api.updateWorkspace(workspaceId, { windowId: currentWindowId }).catch((err) => {
    console.error('Failed to persist workspace window assignment:', err);
  });
}

// Clear and re-initialize the layout for a restarted workspace.
function reinitializeLayoutForRestart(workspaceId: string, restartedWorkspace: Workspace): void {
  const layoutStore = useLayoutStore.getState();
  layoutStore.clearWorkspaceLayout(workspaceId);
  applyLayoutHints(workspaceId, restartedWorkspace, { setCurrentWorkspace: true });
  // If no layout hints were applied (single terminal), initialize normally
  if (restartedWorkspace.terminals.length <= 1) {
    const newTerminalId = restartedWorkspace.terminals[0]?.id;
    layoutStore.setCurrentWorkspace(workspaceId, newTerminalId);
  }
}

// Restart a stopped workspace and drive the full selection flow — including
// rollback on error/upgrade-dialog, layout re-init, and window assignment.
async function restartStoppedWorkspace(
  workspaceId: string,
  set: WorkspacesSet,
  get: WorkspacesGet
): Promise<void> {
  const previousSelectedWorkspaceId = get().selectedWorkspaceId;
  const previousShowDashboard = get().showDashboard;

  const rollbackSelection = (): void => {
    if (get().selectedWorkspaceId === workspaceId) {
      set({
        selectedWorkspaceId: previousSelectedWorkspaceId,
        showDashboard: previousShowDashboard,
      });
    }
  };

  set((state) => ({
    restartingWorkspaceIds: new Set(state.restartingWorkspaceIds).add(workspaceId),
  }));

  try {
    set((state) => ({
      workspaces: clearAttentionForSelected(state.workspaces, workspaceId),
      selectedWorkspaceId: workspaceId,
      showDashboard: false,
    }));

    const result = await window.api.restartWorkspace(workspaceId);

    // Handle expected user-facing errors (workspace limit)
    if (isWorkspaceRestartError(result)) {
      rollbackSelection();
      showUpgradeDialog(() => get().selectWorkspace(workspaceId));
      return;
    }
    useDevServerPreviewStore.getState().clearSshPreviewForwardState(workspaceId);

    // Reload to get the new terminal
    const refreshedWorkspaces = (await window.api.getWorkspaces()).filter(
      (w) => !pendingDeletions.has(w.id)
    );
    const currentSelectedWorkspaceId = get().selectedWorkspaceId;
    const workspaces = clearAttentionForSelected(refreshedWorkspaces, currentSelectedWorkspaceId);
    const restartedWorkspace = workspaces.find((w) => w.id === workspaceId);
    const isStillSelected =
      currentSelectedWorkspaceId === workspaceId && !pendingDeletions.has(workspaceId);

    if (!isStillSelected || !restartedWorkspace) {
      set({ workspaces });
      refreshWorkspaceQuota();
      return;
    }

    prefetchWorkspaceFileList(restartedWorkspace);

    // Update workspaces store first so terminal data is fresh
    set({
      workspaces,
      selectedWorkspaceId: workspaceId,
      showDashboard: false,
    });
    refreshWorkspaceQuota();

    assignWorkspaceToCurrentWindow(workspaceId, restartedWorkspace, set);
    reinitializeLayoutForRestart(workspaceId, restartedWorkspace);

    // Notify other windows so they refresh (e.g. remove it from the Trash)
    window.api.notifyWorkspacesChanged().catch(() => {});
  } catch (error) {
    console.error('Failed to restart workspace:', error);
    rollbackSelection();
    const name = get().workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId;
    reportFailure(set, `Failed to start workspace "${name}": ${stripErrorPrefix(error as Error)}`);
  } finally {
    set((state) => {
      const restartingWorkspaceIds = new Set(state.restartingWorkspaceIds);
      restartingWorkspaceIds.delete(workspaceId);
      return { restartingWorkspaceIds };
    });
  }
}

/** The multi-selection without the workspaces a filter just hid from the sidebar. */
function selectionWithout(
  state: WorkspacesState,
  isHidden: (workspace: Workspace) => boolean
): Pick<WorkspacesState, 'selectedWorkspaceIds' | 'selectionMode' | 'lastSelectedWorkspaceId'> {
  const selectedWorkspaceIds = new Set(
    Array.from(state.selectedWorkspaceIds).filter((workspaceId) => {
      const workspace = state.workspaces.find((item) => item.id === workspaceId);
      return workspace ? !isHidden(workspace) : false;
    })
  );
  return {
    selectedWorkspaceIds,
    selectionMode: state.selectionMode && selectedWorkspaceIds.size > 0,
    lastSelectedWorkspaceId:
      state.lastSelectedWorkspaceId && !selectedWorkspaceIds.has(state.lastSelectedWorkspaceId)
        ? null
        : state.lastSelectedWorkspaceId,
  };
}

/** The projects with a group in this window's sidebar, none when it isn't grouped by project. */
function getProjectIdsInSight(state: WorkspacesState): Set<string> {
  if (state.grouping !== 'project') return new Set();
  return getProjectIdsWithListedGroups(state.workspaces, {
    currentWindowId: useWindowStore.getState().windowId,
    hideStopped: state.hideStopped,
    hiddenProjectIds: state.hiddenProjectIds,
    hiddenWorkspaceHostIds: state.hiddenWorkspaceHostIds,
  });
}

/** What a launch compares against: null before the first load, when nothing says what was shown. */
function getProjectIdsInSightBeforeLaunch(state: WorkspacesState): Set<string> | null {
  return state.hasLoaded ? getProjectIdsInSight(state) : null;
}

/**
 * Moves the projects whose groups a launch brought into sight to the top of the sidebar: the user
 * is working there now, and the group's old place, hidden or empty, kept nothing in view. Groups
 * that were already in sight stay where the user put them.
 */
function moveProjectsBroughtIntoSight(
  state: WorkspacesState,
  before: Set<string> | null,
  created: Workspace[]
): void {
  if (!before) return;
  const after = getProjectIdsInSight(state);
  const projectIds = [...new Set(created.map((workspace) => workspace.projectId))].filter(
    (projectId): projectId is string =>
      !!projectId && !before.has(projectId) && after.has(projectId)
  );
  // One at a time, as each reorder saves the whole order, and the first launched ends on top.
  void (async () => {
    for (const projectId of projectIds.reverse()) {
      await useProjectsStore.getState().reorderProject(projectId, 0);
    }
  })();
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  workspaces: [],
  selectedWorkspaceId: null,
  keyboardNavigationWorkspaceId: null,
  showDashboard: false,
  isLoading: false,
  hasLoaded: false,
  error: null,
  hideStopped: false,
  hideWorking: false,
  collapsedSections: new Set(),
  collapsedWorkspaceGroupKeys: readStoredCollapsedGroups(),
  grouping: 'project',
  dashboardFilterProject: null,
  hiddenProjectIds: new Set(),
  hiddenWorkspaceHostIds: new Set(),
  hiddenWorkspaceTags: new Set(),
  dashboardHiddenWorkspaceHostIds: new Set(),
  displayOrderedWorkspaceIds: null,
  restartingWorkspaceIds: new Set(),
  reconnectingSshWorkspaceIds: new Set(),

  selectionMode: false,
  selectedWorkspaceIds: new Set<string>(),
  lastSelectedWorkspaceId: null,

  loadWorkspaces: async (preferredWorkspaceId) => {
    set({ isLoading: true, error: null });
    try {
      const fetchedWorkspaces = await window.api.getWorkspaces();
      const currentSelectedWorkspaceId = get().selectedWorkspaceId;
      const availableWorkspaces = fetchedWorkspaces.filter((w) => !pendingDeletions.has(w.id));
      const validWorkspaceIds = new Set(availableWorkspaces.map((w) => w.id));
      const selectedWorkspaceId =
        currentSelectedWorkspaceId && validWorkspaceIds.has(currentSelectedWorkspaceId)
          ? currentSelectedWorkspaceId
          : preferredWorkspaceId && validWorkspaceIds.has(preferredWorkspaceId)
            ? preferredWorkspaceId
            : null;
      const workspaces = clearAttentionForSelected(availableWorkspaces, selectedWorkspaceId);
      if (currentSelectedWorkspaceId && currentSelectedWorkspaceId !== selectedWorkspaceId) {
        useLayoutStore.getState().clearWorkspaceLayout(currentSelectedWorkspaceId);
        useLayoutStore.getState().setCurrentWorkspace(null);
      }

      // Restore layouts before publishing workspaces so renderer subscribers cannot
      // initialize a first-tab default that causes saved layouts to be skipped.
      // Skip workspaces that already have an initialized layout to avoid overwriting user state.
      // Exception: a single-tab layout keyed by workspace ID is a placeholder from provisioning,
      // not a real layout — treat it as uninitialized so real terminals can be applied.
      const { tabsByWorkspace } = useLayoutStore.getState();
      for (const workspace of workspaces) {
        const tabs = tabsByWorkspace[workspace.id];
        const isPlaceholder = isWorkspaceLayoutPlaceholder(workspace.id, tabs);
        if (tabs?.length && !isPlaceholder) continue;
        if (workspace.terminalLayout && workspace.terminalLayout.tabs.length > 0) {
          const hydrated = hydratePersistedWorkspaceLayout(workspace.terminalLayout);
          if (hydrated) {
            useLayoutStore.getState().applyWorkspaceLayout(workspace.id, hydrated, {
              setCurrentWorkspace: false,
            });
            continue;
          }
        }
        if (!workspace.terminals.some((t) => t.layoutHint)) continue;
        applyLayoutHints(workspace.id, workspace, { setCurrentWorkspace: false });
      }

      // Reconcile multi-select state against refreshed workspace list
      const { selectionMode, selectedWorkspaceIds } = get();
      if (selectionMode && selectedWorkspaceIds.size > 0) {
        const reconciled = new Set(
          [...selectedWorkspaceIds].filter((id) => validWorkspaceIds.has(id))
        );
        if (reconciled.size !== selectedWorkspaceIds.size) {
          if (reconciled.size === 0) {
            set({
              workspaces,
              selectedWorkspaceId,
              isLoading: false,
              hasLoaded: true,
              selectionMode: false,
              selectedWorkspaceIds: new Set(),
            });
          } else {
            set({
              workspaces,
              selectedWorkspaceId,
              isLoading: false,
              hasLoaded: true,
              selectedWorkspaceIds: reconciled,
            });
          }
        } else {
          set({ workspaces, selectedWorkspaceId, isLoading: false, hasLoaded: true });
        }
      } else {
        set({ workspaces, selectedWorkspaceId, isLoading: false, hasLoaded: true });
      }

      refreshWorkspaceQuota();
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false, hasLoaded: true });
    }
  },

  createWorkspace: async (params) => {
    set({ isLoading: true, error: null });
    const projectIdsInSight = getProjectIdsInSightBeforeLaunch(get());
    try {
      // Auto-assign to current window if not specified
      const paramsWithWindow = {
        ...params,
        windowId: params.windowId ?? useWindowStore.getState().windowId,
      };
      const result = await window.api.createWorkspace(paramsWithWindow);
      // Expected errors are returned as values (not thrown) to avoid noisy Electron IPC logs
      if (isWorkspaceCreateError(result)) {
        throw workspaceCreateException(result);
      }
      const workspace = result;

      // Unhide the project if this new workspace belongs to a hidden project
      if (workspace.projectId && get().hiddenProjectIds.has(workspace.projectId)) {
        get().unhideProjectGroup(workspace.projectId);
      }

      // Expand the project group so the new workspace is visible
      if (workspace.projectId) {
        useProjectsStore.getState().expandProject(workspace.projectId);
      }

      // Auto-focus the new workspace unless the user provided an initial prompt
      // (which signals the workspace will run autonomously). Always focus if
      // no workspace is currently selected (user needs something visible).
      const { selectedWorkspaceId } = get();
      const shouldAutoFocus = !selectedWorkspaceId || !params.initialPrompt;

      // Reload all workspaces to get the terminal that was created with the workspace
      const targetId = shouldAutoFocus ? workspace.id : selectedWorkspaceId;
      const workspaces = clearAttentionForSelected(await window.api.getWorkspaces(), targetId);
      set({
        workspaces,
        isLoading: false,
        hasLoaded: true,
        selectedWorkspaceId: targetId,
      });
      moveProjectsBroughtIntoSight(get(), projectIdsInSight, [workspace]);
      refreshWorkspaceQuota();

      // Pre-fetch file list for the new workspace (skip if still provisioning)
      const freshWorkspace = workspaces.find((w) => w.id === workspace.id);
      if (freshWorkspace && !freshWorkspace.provisioning) {
        prefetchWorkspaceFileList(freshWorkspace);
      }

      // Apply layout hints for setup step terminals (tab/split)
      if (freshWorkspace) {
        applyLayoutHints(workspace.id, freshWorkspace, {
          setCurrentWorkspace: targetId === workspace.id,
        });
      }

      // An initial command runs instead of the agent.
      if (!params.initialCommand) void nudgeAgentSetup([freshWorkspace ?? workspace]);

      return freshWorkspace ?? workspace;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  createWorkspaces: async (params) => {
    set({ isLoading: true, error: null });
    const projectIdsInSight = getProjectIdsInSightBeforeLaunch(get());
    try {
      const windowId = useWindowStore.getState().windowId;
      const paramsWithWindow = params.map((entry) => ({
        ...entry,
        windowId: entry.windowId ?? windowId,
      }));
      const result = await window.api.createWorkspaces(paramsWithWindow);
      if (isWorkspaceCreateError(result)) {
        throw workspaceCreateException(result);
      }

      for (const workspace of result) {
        if (workspace.projectId && get().hiddenProjectIds.has(workspace.projectId)) {
          get().unhideProjectGroup(workspace.projectId);
        }
        if (workspace.projectId) {
          useProjectsStore.getState().expandProject(workspace.projectId);
        }
      }

      await get().loadWorkspaces(result[0]?.id);
      moveProjectsBroughtIntoSight(get(), projectIdsInSight, result);
      const created = result.map(
        (workspace) =>
          get().workspaces.find((candidate) => candidate.id === workspace.id) ?? workspace
      );
      void nudgeAgentSetup(created.filter((_, index) => !params[index]?.initialCommand));
      return created;
    } catch (error) {
      const message = (error as Error).message;
      await get().loadWorkspaces();
      set({ error: message, isLoading: false });
      throw error;
    }
  },

  addTerminal: async (workspaceId, name, command, layoutHint, commandKind, executionLocation) => {
    set({ isLoading: true, error: null });
    try {
      const terminal = await window.api.addTerminal(
        workspaceId,
        name,
        command,
        layoutHint,
        commandKind,
        executionLocation
      );
      // Reload workspaces to get updated state
      const workspaces = clearAttentionForSelected(
        await window.api.getWorkspaces(),
        get().selectedWorkspaceId
      );
      set({ workspaces, isLoading: false });
      refreshWorkspaceQuota();

      // Apply layout hint if specified
      if (layoutHint) {
        const layoutStore = useLayoutStore.getState();
        // Ensure layout is initialized for this workspace
        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (workspace && workspace.terminals.length > 0) {
          const primaryTerminal = workspace.terminals[0];
          layoutStore.initializeWorkspaceLayout(workspaceId, primaryTerminal.id);
          layoutStore.setCurrentWorkspace(workspaceId, primaryTerminal.id);

          if (layoutHint === 'tab') {
            layoutStore.addTab(workspaceId, terminal.id);
          } else if (layoutHint === 'split-right') {
            layoutStore.splitPane('vertical', terminal.id);
          } else if (layoutHint === 'split-bottom') {
            layoutStore.splitPane('horizontal', terminal.id);
          }
        }
      }

      return terminal;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  addTerminalCommand: async (workspaceId, name, command, layoutHint, sshExecutionLocation) => {
    const workspace = get().workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error('Workspace not found');

    const executionLocation = await useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace, sshExecutionLocation);
    if (!executionLocation) return null;

    return get().addTerminal(workspaceId, name, command, layoutHint, 'host', executionLocation);
  },

  addAgentTab: async (workspaceId, prompt, launchModeId, presetId, options) => {
    set({ isLoading: true, error: null });
    try {
      const terminal = await window.api.addAgentTab(
        workspaceId,
        prompt,
        launchModeId,
        presetId,
        options
      );
      const workspaces = clearAttentionForSelected(
        await window.api.getWorkspaces(),
        get().selectedWorkspaceId
      );
      set({ workspaces, isLoading: false });
      refreshWorkspaceQuota();
      return terminal;
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  removeTerminal: async (workspaceId, terminalId) => {
    try {
      cancelDynamicTitleDebounce(terminalId);
      await window.api.removeTerminal(workspaceId, terminalId);
      // Reload workspaces to get updated state
      const workspaces = clearAttentionForSelected(
        await window.api.getWorkspaces(),
        get().selectedWorkspaceId
      );
      set({ workspaces });
      refreshWorkspaceQuota();
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  stopWorkspace: async (workspaceId, options) => {
    const unsaved = getUnsavedFileNames([workspaceId]);
    if (unsaved.length > 0 && !(await confirmDiscardingUnsavedFiles(unsaved))) return;
    const wasSelected = get().selectedWorkspaceId === workspaceId;
    let stopCompleted = false;
    try {
      const workspace = get().workspaces.find((w) => w.id === workspaceId);
      const terminalIds = workspace?.terminals.map((t) => t.id) || [];

      terminalIds.forEach(cancelDynamicTitleDebounce);
      if (wasSelected) {
        set({ selectedWorkspaceId: null });
        useLayoutStore.getState().setCurrentWorkspace(null);
      }
      await window.api.stopWorkspace(workspaceId);
      stopCompleted = true;
      useDevServerPreviewStore
        .getState()
        .clearSshPreviewForwardState(workspaceId, { keepStopped: true });

      // Dispose ALL terminal instances (including first terminal)
      disposeTerminalRenderers(terminalIds);

      // Clear layout for stopped workspace (terminals are killed)
      useLayoutStore.getState().clearWorkspaceLayout(workspaceId);

      // Preserve the file-list / diff summary cache so the workspace card keeps
      // showing the last-known additions/deletions while stopped — symmetric
      // with the git-status cache, which is also retained on stop.

      // A workspace can be reselected while its stop is pending. Once the stop
      // succeeds it no longer has terminals, so drop only that stale selection
      // and preserve any different workspace the user selected meanwhile.
      if (get().selectedWorkspaceId === workspaceId) {
        set({ selectedWorkspaceId: null });
      }
      if (useLayoutStore.getState().currentWorkspaceId === workspaceId) {
        useLayoutStore.getState().setCurrentWorkspace(null);
      }

      // Reload workspaces to get updated state
      const newSelectedId = get().selectedWorkspaceId;
      const workspaces = clearAttentionForSelected(await window.api.getWorkspaces(), newSelectedId);
      set({
        workspaces,
        selectedWorkspaceId: newSelectedId,
      });
      refreshWorkspaceQuota();
    } catch (error) {
      if (!stopCompleted && wasSelected && get().selectedWorkspaceId === null) {
        const workspace = get().workspaces.find((candidate) => candidate.id === workspaceId);
        if (workspace) {
          set({ selectedWorkspaceId: workspaceId });
          useLayoutStore.setState({ currentWorkspaceId: workspaceId });
        }
      }
      const failure = {
        name: get().workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId,
        reason: stripErrorPrefix(error as Error),
      };
      if (options?.quiet) set({ error: stopFailed(failure) });
      else reportFailure(set, stopFailed(failure));
      return failure.reason;
    }
  },

  stopTerminal: async (terminalId) => {
    try {
      await window.api.stopTerminal(terminalId);
      // Reload workspaces to get updated state
      const workspaces = clearAttentionForSelected(
        await window.api.getWorkspaces(),
        get().selectedWorkspaceId
      );
      set({ workspaces });
      refreshWorkspaceQuota();
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  restartTerminal: async (terminalId, presetId, launchModeId, cols, rows, options) => {
    try {
      cancelDynamicTitleDebounce(terminalId);
      await window.api.restartTerminal(terminalId, presetId, launchModeId, cols, rows, options);
      const workspaces = clearAttentionForSelected(
        await window.api.getWorkspaces(),
        get().selectedWorkspaceId
      );
      set({ workspaces });
      refreshWorkspaceQuota();
      return true;
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  reconnectSshTerminal: async (terminalId, cols, rows) => {
    try {
      cancelDynamicTitleDebounce(terminalId);
      await window.api.reconnectSshTerminal(terminalId, cols, rows);
      const workspaces = clearAttentionForSelected(
        await window.api.getWorkspaces(),
        get().selectedWorkspaceId
      );
      set({ workspaces });
      refreshWorkspaceQuota();
    } catch (error) {
      if (isRunningLimitError(error)) {
        showUpgradeDialog(() => void get().reconnectSshTerminal(terminalId, cols, rows));
        return;
      }
      reportFailure(set, `Could not reconnect: ${ipcErrorMessage(error)}`);
    }
  },

  reconnectAllSshTerminals: async (workspaceId) => {
    const workspace = get().workspaces.find((item) => item.id === workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) return;

    const terminals = reconnectableTerminals(workspace);
    if (terminals.length === 0) return;

    const results = await Promise.allSettled(
      terminals.map((terminal) => {
        cancelDynamicTitleDebounce(terminal.id);
        const dimensions = getTerminalRendererDimensions(terminal.id);
        return window.api.reconnectSshTerminal(terminal.id, dimensions?.cols, dimensions?.rows);
      })
    );
    const workspaces = clearAttentionForSelected(
      await window.api.getWorkspaces(),
      get().selectedWorkspaceId
    );
    const rejected = results.filter((result) => result.status === 'rejected');
    // A session another device runs takes a free plan slot once this device attaches to it.
    const failures = rejected.filter((result) => !isRunningLimitError(result.reason));
    if (failures.length < rejected.length) {
      showUpgradeDialog(() => get().selectWorkspace(workspaceId));
    }
    const error =
      failures.length > 0
        ? `Could not reconnect ${failures.length} of ${terminals.length} remote panes: ${ipcErrorMessage(failures[0].reason)}`
        : null;
    set({ workspaces, error });
    if (error) useToastStore.getState().addToast(error, 'error');
    refreshWorkspaceQuota();
  },

  reconnectAfterNetworkReturns: async () => {
    const { selectedWorkspaceId, showDashboard, workspaces, reconnectingSshWorkspaceIds } = get();
    if (!selectedWorkspaceId || showDashboard) return;
    if (reconnectingSshWorkspaceIds.has(selectedWorkspaceId)) return;
    const workspace = workspaces.find((item) => item.id === selectedWorkspaceId);
    if (!workspace || !isSshWorkspace(workspace) || !probesOnSelect(workspace)) return;
    // A pane's own Reconnect, Retry or shell is already bringing it back.
    const { busyTerminals } = useTerminalBusyStore.getState();
    if (workspace.terminals.some((terminal) => busyTerminals.has(terminal.id))) return;

    set((state) => ({
      reconnectingSshWorkspaceIds: new Set(state.reconnectingSshWorkspaceIds).add(workspace.id),
    }));
    try {
      await get().reconnectAllSshTerminals(workspace.id);
    } finally {
      set((state) => {
        const reconnectingSshWorkspaceIds = new Set(state.reconnectingSshWorkspaceIds);
        reconnectingSshWorkspaceIds.delete(workspace.id);
        return { reconnectingSshWorkspaceIds };
      });
    }
  },

  deleteWorkspace: async (workspaceId, force = false, deleteBranch = false, onSettled) => {
    const workspace = get().workspaces.find((w) => w.id === workspaceId);
    const linkedWorkspaceIds = workspace?.linkedWorkspaceIds ?? [];
    const toastStore = useToastStore.getState();

    // Optimistic UI update - remove workspace immediately for instant feedback. The row
    // leaving is the confirmation, so only a failure shows a toast.
    get().removeWorkspaceLocally(workspaceId);

    // Track pending deletion so loadWorkspaces() doesn't resurrect this workspace
    pendingDeletions.add(workspaceId);

    // Fire-and-forget backend deletion; restore state on failure
    window.api
      .deleteWorkspace(workspaceId, force, deleteBranch)
      .then(async () => {
        useDevServerPreviewStore.getState().clearSshPreviewForwardState(workspaceId);
        pendingDeletions.delete(workspaceId);
        try {
          const workspaces = clearAttentionForSelected(
            (await window.api.getWorkspaces()).filter((w) => !pendingDeletions.has(w.id)),
            get().selectedWorkspaceId
          );
          set({ workspaces });
          refreshLinkedWorkspaceFileLists(workspaces, linkedWorkspaceIds);
          await window.api.notifyWorkspacesChanged();
        } catch (error) {
          set({ error: (error as Error).message });
        }
        refreshWorkspaceQuota();
      })
      .catch((error) => {
        console.error('Failed to delete workspace:', error);
        if (isOpenCodeHoldsWorktreeError(error)) {
          toastStore.addToast(
            `Failed to delete workspace "${workspace?.name ?? workspaceId}": ${stripErrorPrefix(error as Error)}`,
            'error',
            {
              // The user may first need to close opencode elsewhere, so the toast waits for them.
              dismissOnTimeout: false,
              action: {
                label: 'Retry',
                onClick: () => void get().deleteWorkspace(workspaceId, force, deleteBranch),
              },
            }
          );
        } else {
          toastStore.addToast(
            `Failed to delete workspace "${workspace?.name ?? workspaceId}": ${(error as Error).message}`,
            'error'
          );
        }
        set({ error: (error as Error).message });
        // Clear guard before reloading so the workspace can reappear
        pendingDeletions.delete(workspaceId);
        // Reload workspaces to restore consistent state
        void get().loadWorkspaces();
      })
      .finally(() => onSettled?.());
  },

  removeMissingSshWorkspace: async (workspaceId) => {
    const workspace = get().workspaces.find((w) => w.id === workspaceId);
    get().removeWorkspaceLocally(workspaceId);
    pendingDeletions.add(workspaceId);
    try {
      await window.api.removeMissingSshWorkspace(workspaceId);
    } catch (error) {
      useToastStore
        .getState()
        .addToast(
          `Couldn’t remove "${workspace?.name ?? workspaceId}": ${(error as Error).message}`,
          'error'
        );
      void get().loadWorkspaces();
      return;
    } finally {
      pendingDeletions.delete(workspaceId);
    }
    useDevServerPreviewStore.getState().clearSshPreviewForwardState(workspaceId);
    refreshWorkspaceQuota();
    await window.api.notifyWorkspacesChanged();
  },

  removeWorkspaceLocally: (workspaceId) => {
    // Capture selection state and terminal IDs BEFORE updating state
    const wasSelected = get().selectedWorkspaceId === workspaceId;
    const terminalIds =
      get()
        .workspaces.find((w) => w.id === workspaceId)
        ?.terminals.map((t) => t.id) ?? [];

    // Cancel any pending dynamic-title debounces before deleting
    terminalIds.forEach(cancelDynamicTitleDebounce);
    disposeTerminalRenderers(terminalIds);
    useLayoutStore.getState().clearWorkspaceLayout(workspaceId);
    useFileViewerStore.getState().clearWorkspaceFileViewerState(workspaceId);
    useWorktreeEventsStore.getState().clearWorkspace(workspaceId);
    if (wasSelected) {
      useLayoutStore.getState().setCurrentWorkspace(null);
    }
    set((state) => {
      const nextSelectedIds = new Set(state.selectedWorkspaceIds);
      nextSelectedIds.delete(workspaceId);
      return {
        workspaces: state.workspaces.filter((w) => w.id !== workspaceId),
        selectedWorkspaceId: wasSelected ? null : state.selectedWorkspaceId,
        selectedWorkspaceIds: nextSelectedIds,
        selectionMode: nextSelectedIds.size === 0 ? false : state.selectionMode,
      };
    });
  },

  restartWorkspace: async (workspaceId) => {
    const unsaved = getUnsavedFileNames([workspaceId]);
    if (unsaved.length > 0 && !(await confirmDiscardingUnsavedFiles(unsaved))) return undefined;
    const workspace = get().workspaces.find((w) => w.id === workspaceId);
    const prevStatus = workspace?.status;
    const wasDormant = prevStatus !== 'active';
    const terminalIds = workspace?.terminals.map((t) => t.id) || [];

    set((state) => ({
      restartingWorkspaceIds: new Set(state.restartingWorkspaceIds).add(workspaceId),
    }));

    try {
      terminalIds.forEach(cancelDynamicTitleDebounce);

      // Optimistically activate dormant workspaces so they appear in sidebar immediately
      if (wasDormant) {
        set((state) => ({
          workspaces: state.workspaces.map((w) =>
            w.id === workspaceId ? { ...w, status: 'active' as const } : w
          ),
        }));
      }

      const result = await window.api.restartWorkspace(workspaceId);

      // Handle expected user-facing errors (workspace limit) — revert optimistic update
      if (isWorkspaceRestartError(result)) {
        if (wasDormant) {
          set((state) => ({
            workspaces: state.workspaces.map((w) =>
              w.id === workspaceId ? { ...w, status: prevStatus! } : w
            ),
          }));
        }
        showUpgradeDialog(() => void get().restartWorkspace(workspaceId));
        return result;
      }
      useDevServerPreviewStore.getState().clearSshPreviewForwardState(workspaceId);

      // Reload workspaces to get updated state
      const workspaces = clearAttentionForSelected(
        await window.api.getWorkspaces(),
        get().selectedWorkspaceId
      );
      set({ workspaces });
      refreshWorkspaceQuota();
      disposeTerminalRenderers(terminalIds);

      // Apply layout hints for setup step terminals (tab/split)
      const freshWorkspace = workspaces.find((w) => w.id === workspaceId);
      if (freshWorkspace) {
        const layoutStore = useLayoutStore.getState();
        layoutStore.clearWorkspaceLayout(workspaceId);
        applyLayoutHints(workspaceId, freshWorkspace, {
          setCurrentWorkspace: get().selectedWorkspaceId === workspaceId,
        });
      }

      return result;
    } catch (error) {
      // Revert optimistic dormancy clear on failure
      if (wasDormant) {
        set((state) => ({
          workspaces: state.workspaces.map((w) =>
            w.id === workspaceId ? { ...w, status: prevStatus! } : w
          ),
        }));
      }
      reportFailure(
        set,
        `Failed to restart workspace "${workspace?.name ?? workspaceId}": ${stripErrorPrefix(error as Error)}`
      );
      throw error;
    } finally {
      set((state) => {
        const restartingWorkspaceIds = new Set(state.restartingWorkspaceIds);
        restartingWorkspaceIds.delete(workspaceId);
        return { restartingWorkspaceIds };
      });
    }
  },

  reorderWorkspace: async (workspaceId, newOrder) => {
    const state = get();
    const workspace = state.workspaces.find((w) => w.id === workspaceId);
    if (!workspace) return;

    const oldOrder = workspace.order ?? 0;

    // Optimistically update local state
    set((state) => ({
      workspaces: state.workspaces.map((w) => {
        if (w.id === workspaceId) {
          return { ...w, order: newOrder };
        }

        const currentOrder = w.order ?? 0;
        if (oldOrder < newOrder) {
          // Moving down: shift workspaces between old and new position up
          if (currentOrder > oldOrder && currentOrder <= newOrder) {
            return { ...w, order: currentOrder - 1 };
          }
        } else if (oldOrder > newOrder) {
          // Moving up: shift workspaces between new and old position down
          if (currentOrder >= newOrder && currentOrder < oldOrder) {
            return { ...w, order: currentOrder + 1 };
          }
        }
        return w;
      }),
    }));

    try {
      await window.api.reorderWorkspace(workspaceId, newOrder);
    } catch (error) {
      // Revert on error by reloading
      void get().loadWorkspaces();
      reportFailure(set, `Failed to move workspace: ${stripErrorPrefix(error as Error)}`);
    }
  },

  updateTerminalStatus: (terminalId, status) => {
    const { workspaces } = get();
    const workspaceId = workspaces.find((w) =>
      w.terminals.some((t) => t.id === terminalId && t.status !== status)
    )?.id;
    // Every workspace card and pane selects from this list; leave it alone when nothing changed.
    if (!workspaceId) return;
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === workspaceId
          ? {
              ...w,
              terminals: w.terminals.map((t) => (t.id === terminalId ? { ...t, status } : t)),
            }
          : w
      ),
    }));
  },

  updateWorkspace: (workspaceId, updates) => {
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === workspaceId ? { ...w, ...updates } : w)),
    }));
  },

  selectWorkspace: async (workspaceId) => {
    restoreDeferredAttentionClear(set);
    clearTimeout(pendingUnreadClear);
    if (get().keyboardNavigationWorkspaceId !== null) {
      set({ keyboardNavigationWorkspaceId: null });
    }

    if (!workspaceId) {
      set({ selectedWorkspaceId: null, showDashboard: true });
      return;
    }

    const state = get();
    const workspace = state.workspaces.find((w) => w.id === workspaceId);

    deferOrClearAttention(workspaceId, workspace);
    if (workspace?.unread) {
      pendingUnreadClear = setTimeout(() => {
        saveWorkspaceMarks(set, new Map([[workspaceId, { unread: undefined }]]));
      }, ATTENTION_CLEAR_DELAY_MS);
    }

    // Unhide the project if this workspace belongs to a hidden project
    if (workspace?.projectId && state.hiddenProjectIds.has(workspace.projectId)) {
      get().unhideProjectGroup(workspace.projectId);
    }

    if (!workspace) {
      set({ selectedWorkspaceId: workspaceId, showDashboard: false });
      return;
    }

    const workspaceHostId = getWorkspaceHostId(workspace);
    if (state.hiddenWorkspaceHostIds.has(workspaceHostId)) {
      const hiddenWorkspaceHostIds = new Set(state.hiddenWorkspaceHostIds);
      hiddenWorkspaceHostIds.delete(workspaceHostId);
      set({ hiddenWorkspaceHostIds });
      void window.api
        .updateConfig({
          hiddenWorkspaceHostIds: Array.from(hiddenWorkspaceHostIds),
        })
        .catch((error) => {
          console.error('Failed to persist hidden workspace host IDs:', error);
        });
    }

    if (isSshWorkspace(workspace)) {
      // A live SSH PTY is already attached to its managed tmux session. Switching
      // back to it is only a renderer visibility change; probing the host would
      // add a connection overlay and an unnecessary tmux redraw to every switch.
      if (isRunningHere(workspace) && !probesOnSelect(workspace)) {
        set((state) => ({
          workspaces: clearAttentionForSelected(state.workspaces, workspaceId),
          selectedWorkspaceId: workspaceId,
          showDashboard: false,
        }));
        return;
      }

      const reconnectAlreadyInProgress = state.reconnectingSshWorkspaceIds.has(workspaceId);
      // Make the workspace visibly selected before launching its saved SSH
      // attachments. Restored remote workspaces remain dormant until now.
      set((state) => ({
        workspaces: clearAttentionForSelected(state.workspaces, workspaceId),
        selectedWorkspaceId: workspaceId,
        showDashboard: false,
        reconnectingSshWorkspaceIds: new Set(state.reconnectingSshWorkspaceIds).add(workspaceId),
      }));

      if (reconnectAlreadyInProgress) return;

      try {
        let sshHostsState = useSshHostsStore.getState();
        if (!sshHostsState.hasLoaded) {
          await sshHostsState.loadHosts();
          const selectionState = get();
          if (selectionState.selectedWorkspaceId !== workspaceId || selectionState.showDashboard) {
            return;
          }
          sshHostsState = useSshHostsStore.getState();
          if (!sshHostsState.hasLoaded) {
            const reason = sshHostsState.error ?? 'Could not load SSH hosts';
            reportFailure(
              set,
              `Failed to open workspace "${workspace.name}": ${stripErrorPrefix(new Error(reason))}`
            );
            return;
          }
        }
        const currentWorkspace = get().workspaces.find((item) => item.id === workspaceId);
        if (!currentWorkspace || !isSshWorkspace(currentWorkspace)) return;

        const configuredHostExists = sshHostsState.hosts.some(
          (host) => host.id === currentWorkspace.backend.hostId
        );
        if (!configuredHostExists) {
          try {
            const recoveredWorkspace = await window.api.recoverSshSessions(workspaceId);
            if (recoveredWorkspace) {
              set((state) => ({
                workspaces: state.workspaces.map((item) =>
                  item.id === workspaceId ? recoveredWorkspace : item
                ),
              }));
            }
          } catch (error) {
            reportFailure(
              set,
              `Failed to open workspace "${currentWorkspace.name}": ${stripErrorPrefix(error as Error)}`
            );
          }
          return;
        }

        if (probesOnSelect(currentWorkspace)) {
          await get().reconnectAllSshTerminals(workspaceId);
          return;
        }
        if (
          !isRunningHere(currentWorkspace) &&
          !currentWorkspace.provisioning &&
          !currentWorkspace.provisionError
        ) {
          await restartStoppedWorkspace(workspaceId, set, get);
        }
      } finally {
        set((state) => {
          const reconnectingSshWorkspaceIds = new Set(state.reconnectingSshWorkspaceIds);
          reconnectingSshWorkspaceIds.delete(workspaceId);
          return { reconnectingSshWorkspaceIds };
        });
      }
      return;
    }

    if (!isRunningHere(workspace) && !workspace.provisioning && !workspace.provisionError) {
      // Restart to spawn a new terminal with continueCommand
      await restartStoppedWorkspace(workspaceId, set, get);
      return;
    }

    set((state) => ({
      workspaces: clearAttentionForSelected(state.workspaces, workspaceId),
      selectedWorkspaceId: workspaceId,
      showDashboard: false,
    }));
  },

  setNeedsAttention: (workspaceId, value) => {
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === workspaceId
          ? { ...w, needsAttention: value, attention: value ? w.attention : undefined }
          : w
      ),
    }));
  },

  setAttention: (workspaceId, attention, workspaceAttention, { windowFocused = true } = {}) => {
    set((state) => ({
      workspaces: state.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        // The selected card in a focused window keeps only actionable attention.
        const cardQuiet =
          state.selectedWorkspaceId === workspaceId &&
          windowFocused &&
          !!workspaceAttention.terminalId &&
          !isWorkspaceAttentionActionable(workspaceAttention);
        const cardAttention = cardQuiet ? undefined : workspaceAttention;
        return {
          ...w,
          attention: cardAttention,
          needsAttention: needsAttention(cardAttention),
          terminals: attention.terminalId
            ? w.terminals.map((t) => (t.id === attention.terminalId ? { ...t, attention } : t))
            : w.terminals,
        };
      }),
    }));
  },

  setDefaultAction: (workspaceId, actionId) =>
    saveDefaultAction(get, workspaceId, 'defaultActionId', actionId),

  setPaneDefaultAction: (workspaceId, actionId) =>
    saveDefaultAction(get, workspaceId, 'paneDefaultActionId', actionId),

  markUnread: (workspaceId) => {
    saveWorkspaceMarks(
      set,
      new Map([[workspaceId, { unread: { reason: 'marked', at: Date.now() } }]])
    );
  },

  receiveWorkspaceMarks: (workspace) => {
    const { workspaces, selectedWorkspaceId } = get();
    const previous = workspaces.find((w) => w.id === workspace.id);
    if (!previous) return false;
    const justWoke =
      workspace.id === selectedWorkspaceId &&
      workspace.unread?.reason === 'snooze-ended' &&
      previous.unread?.reason !== 'snooze-ended';
    const unchanged =
      previous.pinned === workspace.pinned &&
      previous.tag === workspace.tag &&
      previous.tagSource === workspace.tagSource &&
      previous.snoozedUntil === workspace.snoozedUntil &&
      previous.wakesOnNotification === workspace.wakesOnNotification &&
      previous.unread?.reason === workspace.unread?.reason &&
      previous.unread?.at === workspace.unread?.at;
    if (!unchanged) {
      get().updateWorkspace(workspace.id, {
        pinned: workspace.pinned,
        tag: workspace.tag,
        tagSource: workspace.tagSource,
        snoozedUntil: workspace.snoozedUntil,
        wakesOnNotification: workspace.wakesOnNotification,
        unread: workspace.unread,
      });
    }
    return justWoke;
  },

  dismissWokeIfOpen: (workspaceId) => {
    const { workspaces, selectedWorkspaceId } = get();
    if (workspaceId !== selectedWorkspaceId) return;
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (workspace?.unread?.reason !== 'snooze-ended') return;
    saveWorkspaceMarks(set, new Map([[workspaceId, { unread: undefined }]]));
  },

  setPinned: (workspaceId, pinned) => {
    saveWorkspaceMarks(set, new Map([[workspaceId, { pinned: pinned || undefined }]]));
  },

  setTag: (workspaceIds, tag, tagSource) => {
    // A script's word on the tag goes with it, as Komla drops it on any change of tag.
    const marks = {
      tag: tag || undefined,
      tagSource: tag ? tagSource : undefined,
      tagTooltip: undefined,
    };
    saveWorkspaceMarks(set, new Map(workspaceIds.map((id) => [id, marks])));
  },

  snoozeWorkspace: (workspaceId, until, wakesOnNotification) => {
    saveWorkspaceMarks(set, new Map([[workspaceId, snoozeMarks(until, wakesOnNotification)]]));
  },

  setTerminalDynamicTitle: (terminalId, title) => {
    // Find the workspace containing this terminal
    const state = get();
    let workspaceId: string | null = null;
    let isPrimaryTerminal = false;
    let isUnchanged = false;

    for (const workspace of state.workspaces) {
      const terminalIndex = workspace.terminals.findIndex((t) => t.id === terminalId);
      if (terminalIndex !== -1) {
        workspaceId = workspace.id;
        // Check if this is the primary terminal (explicit or implicit first)
        isPrimaryTerminal =
          workspace.primaryTerminalId === terminalId ||
          (!workspace.primaryTerminalId && terminalIndex === 0);
        isUnchanged =
          workspace.terminals[terminalIndex].dynamicTitle === title &&
          (!isPrimaryTerminal || workspace.lastDynamicTitle === title);
        break;
      }
    }

    // Agents re-emit identical titles often; skip so subscribers don't re-render.
    if (!workspaceId || isUnchanged) return;

    // Update local state immediately for responsive UI
    // Also update lastDynamicTitle if this is the primary terminal
    set((state) => ({
      workspaces: state.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        return {
          ...w,
          terminals: w.terminals.map((t) =>
            t.id === terminalId ? { ...t, dynamicTitle: title } : t
          ),
          // Persist title at workspace level for primary terminal
          ...(isPrimaryTerminal ? { lastDynamicTitle: title } : {}),
        };
      }),
    }));

    // Debounce persistence to avoid excessive disk writes
    const existingTimer = dynamicTitleDebounceTimers.get(terminalId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      dynamicTitleDebounceTimers.delete(terminalId);
      void (async () => {
        try {
          // Persist terminal dynamic title
          await window.api.updateTerminal(terminalId, { dynamicTitle: title });
          // Also persist at workspace level if this is the primary terminal
          if (isPrimaryTerminal && workspaceId) {
            await window.api.updateWorkspace(workspaceId, { lastDynamicTitle: title });
          }
        } catch (err) {
          console.error('Failed to persist dynamic title:', err);
        }
      })();
    }, DYNAMIC_TITLE_DEBOUNCE_MS);

    dynamicTitleDebounceTimers.set(terminalId, timer);
  },

  setPrimaryTerminal: async (workspaceId, terminalId) => {
    // Update local state
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, primaryTerminalId: terminalId } : w
      ),
    }));

    // Persist via IPC
    try {
      await window.api.updateWorkspace(workspaceId, { primaryTerminalId: terminalId });
    } catch (error) {
      console.error('Failed to persist primary terminal:', error);
      // Revert on error
      set((state) => ({
        workspaces: state.workspaces.map((w) =>
          w.id === workspaceId ? { ...w, primaryTerminalId: undefined } : w
        ),
      }));
      reportFailure(set, `Failed to set the primary terminal: ${stripErrorPrefix(error as Error)}`);
    }
  },

  moveWorkspaceToWindow: async (workspaceId, windowId, options) => {
    const { selectedWorkspaceId } = get();
    const currentWindowId = useWindowStore.getState().windowId;

    // No-op if workspace is already on this window
    if (windowId === currentWindowId) {
      const workspace = get().workspaces.find((w) => w.id === workspaceId);
      if (workspace?.windowId === windowId) return;
    }

    // Serialize layout state from the source window before the IPC call
    const layoutStore = useLayoutStore.getState();
    const layoutData = {
      tabs: layoutStore.tabsByWorkspace[workspaceId] || [],
      layouts: layoutStore.layoutsByTab[workspaceId] || {},
      focusedPanes: layoutStore.focusedPaneByTab[workspaceId] || {},
      activeTab: layoutStore.activeTabByWorkspace[workspaceId] || '',
      // Its browser and note panes open again in the target window.
      surfaces: handOffWorkspacePaneSurfaces(workspaceId),
    };

    // Get the workspace's terminal IDs for cleanup
    const workspace = get().workspaces.find((w) => w.id === workspaceId);
    const terminalIds = workspace?.terminals.map((t) => t.id) || [];

    // Optimistic update
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === workspaceId ? { ...w, windowId } : w)),
      // Deselect if moving the active workspace away from this window
      ...(selectedWorkspaceId === workspaceId ? { selectedWorkspaceId: null } : {}),
    }));
    try {
      await window.api.moveWorkspaceToWindow(workspaceId, windowId, layoutData);

      // Clean up source window: dispose xterm instances and clear layout
      disposeTerminalRenderers(terminalIds);
      layoutStore.clearWorkspaceLayout(workspaceId);
    } catch (error) {
      // Revert on error
      void get().loadWorkspaces();
      const failure = {
        name: workspace?.name ?? workspaceId,
        reason: stripErrorPrefix(error as Error),
      };
      if (options?.quiet) set({ error: moveFailed(failure) });
      else reportFailure(set, moveFailed(failure));
      return failure.reason;
    }
  },

  setHideStopped: (hide) => {
    set({
      hideStopped: hide,
      ...(hide ? selectionWithout(get(), isHiddenByHideStopped) : {}),
    });
    void window.api.updateConfig({ hideStoppedWorkspaces: hide }).catch((error) => {
      console.error('Failed to persist stopped workspace visibility:', error);
    });
  },

  // The sidebar drops what moves onto the closed Working shelf from the selection.
  setHideWorking: (hide) => {
    set({ hideWorking: hide });
    void window.api.updateConfig({ hideWorkingWorkspaces: hide }).catch((error) => {
      console.error('Failed to persist working workspace visibility:', error);
    });
  },

  toggleCollapsedSection: (key) => {
    const next = new Set(get().collapsedSections);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    set({ collapsedSections: next });
  },

  toggleWorkspaceGroupCollapsed: (groupKey) => {
    const next = new Set(get().collapsedWorkspaceGroupKeys);
    if (next.has(groupKey)) next.delete(groupKey);
    else next.add(groupKey);
    set({ collapsedWorkspaceGroupKeys: next });
    storeCollapsedGroups(next);
  },

  setGrouping: (grouping) => {
    set({ grouping });
    void window.api.updateConfig({ workspaceGrouping: grouping }).catch((error) => {
      console.error('Failed to persist workspace grouping:', error);
    });
  },

  setDashboardFilterProject: (projectName) => {
    set({ dashboardFilterProject: projectName });
    void window.api.updateConfig({ dashboardFilterProject: projectName }).catch((error) => {
      console.error('Failed to persist dashboard filter project:', error);
    });
  },

  toggleWorkspaceHostVisibility: (hostId) => {
    const state = get();
    const next = new Set(state.hiddenWorkspaceHostIds);
    const hidingHost = !next.has(hostId);
    if (hidingHost) next.add(hostId);
    else next.delete(hostId);

    const activeWorkspace = state.selectedWorkspaceId
      ? state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)
      : null;
    const selectedWorkspaceId =
      hidingHost && activeWorkspace && !isWorkspaceHostVisible(activeWorkspace, next)
        ? null
        : state.selectedWorkspaceId;

    set({
      hiddenWorkspaceHostIds: next,
      selectedWorkspaceId,
      ...(hidingHost
        ? selectionWithout(state, (workspace) => !isWorkspaceHostVisible(workspace, next))
        : {}),
    });
    void window.api.updateConfig({ hiddenWorkspaceHostIds: Array.from(next) }).catch((error) => {
      console.error('Failed to persist hidden workspace host IDs:', error);
    });
  },

  toggleWorkspaceTagShown: (tag) => {
    const key = workspaceTagKey(tag);
    const next = new Set(get().hiddenWorkspaceTags);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    saveHiddenWorkspaceTags(set, get, next);
  },

  setHiddenWorkspaceTags: (tags) => {
    saveHiddenWorkspaceTags(set, get, new Set([...tags].map(workspaceTagKey)));
  },

  moveHiddenWorkspaceTag: (from, to) => {
    const next = new Set(get().hiddenWorkspaceTags);
    if (!next.delete(workspaceTagKey(from))) return;
    if (to) next.add(workspaceTagKey(to));
    saveHiddenWorkspaceTags(set, get, next);
  },

  showAllWorkspaceHosts: () => {
    set({ hiddenWorkspaceHostIds: new Set() });
    void window.api.updateConfig({ hiddenWorkspaceHostIds: [] }).catch((error) => {
      console.error('Failed to persist hidden workspace host IDs:', error);
    });
  },

  toggleDashboardWorkspaceHostVisibility: (hostId) => {
    const state = get();
    const next = new Set(state.dashboardHiddenWorkspaceHostIds);
    const hidingHost = !next.has(hostId);
    if (hidingHost) next.add(hostId);
    else next.delete(hostId);

    const selectedWorkspaceIds = hidingHost
      ? new Set(
          Array.from(state.selectedWorkspaceIds).filter((workspaceId) => {
            const workspace = state.workspaces.find((item) => item.id === workspaceId);
            return workspace ? isWorkspaceHostVisible(workspace, next) : false;
          })
        )
      : state.selectedWorkspaceIds;

    set({
      dashboardHiddenWorkspaceHostIds: next,
      selectedWorkspaceIds,
      selectionMode: state.selectionMode && selectedWorkspaceIds.size > 0,
      lastSelectedWorkspaceId:
        state.lastSelectedWorkspaceId && !selectedWorkspaceIds.has(state.lastSelectedWorkspaceId)
          ? null
          : state.lastSelectedWorkspaceId,
    });
    void window.api
      .updateConfig({ dashboardHiddenWorkspaceHostIds: Array.from(next) })
      .catch((error) => {
        console.error('Failed to persist dashboard workspace host IDs:', error);
      });
  },

  showAllDashboardWorkspaceHosts: () => {
    set({ dashboardHiddenWorkspaceHostIds: new Set() });
    void window.api.updateConfig({ dashboardHiddenWorkspaceHostIds: [] }).catch((error) => {
      console.error('Failed to persist dashboard workspace host IDs:', error);
    });
  },

  hideProjectGroup: (projectId) => {
    get().hideProjectGroups([projectId]);
  },

  hideProjectGroups: (projectIds) => {
    const state = get();
    const hiding = new Set(projectIds);
    const next = new Set([...state.hiddenProjectIds, ...hiding]);
    const inHidden = (workspace: Workspace) =>
      !!workspace.projectId && hiding.has(workspace.projectId);

    // Deselect if the active workspace belongs to a hidden project
    const selectedWs = state.selectedWorkspaceId
      ? state.workspaces.find((w) => w.id === state.selectedWorkspaceId)
      : null;
    const shouldDeselect = !!selectedWs && inHidden(selectedWs);

    set({
      hiddenProjectIds: next,
      ...(shouldDeselect ? { selectedWorkspaceId: null } : {}),
      ...selectionWithout(state, inHidden),
    });
    void window.api.updateConfig({ hiddenProjectIds: Array.from(next) }).catch((error) => {
      console.error('Failed to persist hidden project IDs:', error);
    });
  },

  unhideProjectGroup: (projectId) => {
    get().unhideProjectGroups([projectId]);
  },

  unhideProjectGroups: (projectIds) => {
    const next = new Set(get().hiddenProjectIds);
    for (const projectId of projectIds) next.delete(projectId);
    set({ hiddenProjectIds: next });
    void window.api.updateConfig({ hiddenProjectIds: Array.from(next) }).catch((error) => {
      console.error('Failed to persist hidden project IDs:', error);
    });
  },

  setDisplayOrderedWorkspaceIds: (ids) => {
    const current = get().displayOrderedWorkspaceIds;
    if (current && ids.length === current.length && ids.every((id, i) => id === current[i])) return;
    set({ displayOrderedWorkspaceIds: ids });
  },

  enterSelectionMode: (workspaceId) => {
    set({
      selectionMode: true,
      selectedWorkspaceIds: new Set([workspaceId]),
      lastSelectedWorkspaceId: workspaceId,
    });
  },

  exitSelectionMode: () => {
    set({
      selectionMode: false,
      selectedWorkspaceIds: new Set(),
      lastSelectedWorkspaceId: null,
    });
  },

  deselectWorkspaces: (workspaceIds) => {
    const ids = new Set(workspaceIds);
    set(selectionWithout(get(), (workspace) => ids.has(workspace.id)));
  },

  toggleWorkspaceSelection: (workspaceId) => {
    const next = new Set(get().selectedWorkspaceIds);
    if (next.has(workspaceId)) {
      next.delete(workspaceId);
    } else {
      next.add(workspaceId);
    }
    if (next.size === 0) {
      set({ selectionMode: false, selectedWorkspaceIds: next, lastSelectedWorkspaceId: null });
    } else {
      set({ selectedWorkspaceIds: next, lastSelectedWorkspaceId: workspaceId });
    }
  },

  shiftSelectWorkspaces: (workspaceId, orderedIds) => {
    const { lastSelectedWorkspaceId, selectedWorkspaceIds } = get();
    const anchor = lastSelectedWorkspaceId;
    if (!anchor || anchor === workspaceId) {
      // No anchor — just toggle
      get().toggleWorkspaceSelection(workspaceId);
      return;
    }
    const anchorIndex = orderedIds.indexOf(anchor);
    const targetIndex = orderedIds.indexOf(workspaceId);
    if (anchorIndex === -1 || targetIndex === -1) {
      get().toggleWorkspaceSelection(workspaceId);
      return;
    }
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const rangeIds = orderedIds.slice(start, end + 1);
    const next = new Set(selectedWorkspaceIds);
    for (const id of rangeIds) {
      next.add(id);
    }
    set({ selectedWorkspaceIds: next });
  },

  selectAllWorkspaces: () => {
    const {
      workspaces,
      hideStopped,
      hiddenProjectIds,
      hiddenWorkspaceHostIds,
      displayOrderedWorkspaceIds,
    } = get();
    const currentWindowId = useWindowStore.getState().windowId;
    // Match range select and keyboard navigation: skip workspaces the sidebar
    // isn't showing, such as those inside collapsed groups or on a closed Stopped shelf.
    const displayedIds = displayOrderedWorkspaceIds ? new Set(displayOrderedWorkspaceIds) : null;
    const ids = new Set<string>();
    for (const workspace of workspaces) {
      if (displayedIds) {
        if (!displayedIds.has(workspace.id)) continue;
      } else if (hideStopped && isHiddenByHideStopped(workspace)) {
        continue;
      }
      if (workspace.windowId !== currentWindowId) continue;
      // Sidebar only shows active workspaces
      if (workspace.status !== 'active') continue;
      if (workspace.projectId && hiddenProjectIds.has(workspace.projectId)) continue;
      if (!isWorkspaceHostVisible(workspace, hiddenWorkspaceHostIds)) continue;
      ids.add(workspace.id);
    }
    if (ids.size === 0) return;
    set({ selectionMode: true, selectedWorkspaceIds: ids });
  },

  stopSelectedWorkspaces: async () => {
    const { selectedWorkspaceIds, workspaces } = get();
    const toStop = workspaces.filter((w) => selectedWorkspaceIds.has(w.id) && canStop(w));
    set({ selectionMode: false, selectedWorkspaceIds: new Set() });
    // Reuse single-workspace stopWorkspace for full cleanup (terminal disposal, layout, status transition)
    const failures: WorkspaceFailure[] = [];
    for (const w of toStop) {
      const reason = await get().stopWorkspace(w.id, { quiet: true });
      if (reason) failures.push({ name: w.name, reason });
    }
    reportBulkFailures(set, failures, stopFailed, (count) => `Failed to stop ${count} workspaces`);
  },

  trashSelectedWorkspaces: async () => {
    const workspaceIds = Array.from(get().selectedWorkspaceIds);
    set({ selectionMode: false, selectedWorkspaceIds: new Set() });
    await get().trashWorkspaces(workspaceIds);
  },

  trashWorkspaces: async (workspaceIds) => {
    const unsaved = getUnsavedFileNames(workspaceIds);
    if (unsaved.length > 0 && !(await confirmDiscardingUnsavedFiles(unsaved))) return;
    const ids = new Set(workspaceIds);
    const toTrash = get().workspaces.filter((w) => ids.has(w.id) && w.status !== 'trashed');

    // Stop PTYs first so the trash cleanup script doesn't fight running processes
    // (especially relevant on Windows where node_modules may be locked).
    for (const w of toTrash) {
      if (isRunningHere(w)) {
        try {
          await window.api.stopWorkspace(w.id);
          useDevServerPreviewStore
            .getState()
            .clearSshPreviewForwardState(w.id, { keepStopped: true });
        } catch {
          // The trash flow handles any subsequent persistence failure below.
        }
      }
    }

    // Persist next so a failing cleanup script aborts before local teardown.
    // Run sequentially: cleanup scripts can do heavy disk IO (rm -rf node_modules),
    // and parallel runs cause disk thrash and Windows file-lock failures.
    type TrashResult =
      | { workspace: Workspace; ok: true }
      | { workspace: Workspace; ok: false; error: string };
    const results: TrashResult[] = [];
    for (const w of toTrash) {
      try {
        await window.api.updateWorkspace(w.id, { status: 'trashed' });
        results.push({ workspace: w, ok: true });
      } catch (error) {
        results.push({
          workspace: w,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const trashed = results.flatMap((r) => (r.ok ? [r.workspace] : []));
    const failed = results.flatMap((r) => (!r.ok ? [r] : []));

    for (const w of trashed) {
      if (!isSshWorkspace(w)) {
        useFileListStore.getState().invalidate(w.workingDirectory, w.id);
      }
      disposeTerminalRenderers(w.terminals.map((t) => t.id));
      useLayoutStore.getState().clearWorkspaceLayout(w.id);
    }

    const trashedIds = new Set(trashed.map((w) => w.id));
    if (trashedIds.has(get().selectedWorkspaceId ?? '')) {
      useLayoutStore.getState().setCurrentWorkspace(null);
    }
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        trashedIds.has(w.id) ? { ...w, status: 'trashed' as const } : w
      ),
      selectedWorkspaceId: trashedIds.has(state.selectedWorkspaceId ?? '')
        ? null
        : state.selectedWorkspaceId,
    }));

    await window.api.notifyWorkspacesChanged();
    const freshWorkspaces = clearAttentionForSelected(
      await window.api.getWorkspaces(),
      get().selectedWorkspaceId
    );
    set({ workspaces: freshWorkspaces });

    if (failed.length > 0) {
      const summary =
        failed.length === 1
          ? `Failed to move ${failed[0].workspace.name} to the Trash: ${failed[0].error}`
          : `Failed to move ${failed.length} workspaces to the Trash. First error: ${failed[0].error}`;
      set({ error: summary });
      useToastStore.getState().addToast(summary, 'error');
    }
  },

  deleteSelectedWorkspaces: async (force = false, deleteBranch = false) => {
    const ids = Array.from(get().selectedWorkspaceIds);
    set({ selectionMode: false, selectedWorkspaceIds: new Set() });
    await get().deleteWorkspaces(ids, force, deleteBranch);
  },

  deleteWorkspaces: async (workspaceIds, force = false, deleteBranch = false) => {
    for (const id of workspaceIds) {
      await get().deleteWorkspace(id, force, deleteBranch);
    }
  },

  markSelectedUnread: () => {
    const at = Date.now();
    const ids = [...get().selectedWorkspaceIds];
    saveWorkspaceMarks(
      set,
      new Map(ids.map((id) => [id, { unread: { reason: 'marked', at } }] as const))
    );
    get().exitSelectionMode();
  },

  togglePinSelected: () => {
    const { selectedWorkspaceIds, workspaces } = get();
    const selected = workspaces.filter((w) => selectedWorkspaceIds.has(w.id));
    const pinned = selected.some((w) => !w.pinned) || undefined;
    saveWorkspaceMarks(set, new Map(selected.map((w) => [w.id, { pinned }] as const)));
    get().exitSelectionMode();
  },

  snoozeSelected: (until, wakesOnNotification) => {
    const ids = [...get().selectedWorkspaceIds];
    saveWorkspaceMarks(
      set,
      new Map(ids.map((id) => [id, snoozeMarks(until, wakesOnNotification)] as const))
    );
    get().exitSelectionMode();
  },

  moveSelectedToWindow: async (windowId) => {
    const { selectedWorkspaceIds } = get();
    const ids = Array.from(selectedWorkspaceIds);
    set({ selectionMode: false, selectedWorkspaceIds: new Set() });
    await get().moveWorkspacesToWindow(ids, windowId);
  },

  moveWorkspacesToWindow: async (workspaceIds, windowId) => {
    const failures: WorkspaceFailure[] = [];
    for (const id of workspaceIds) {
      const name = get().workspaces.find((w) => w.id === id)?.name ?? id;
      const reason = await get().moveWorkspaceToWindow(id, windowId, { quiet: true });
      if (reason) failures.push({ name, reason });
    }
    reportBulkFailures(
      set,
      failures,
      moveFailed,
      (count) => `Failed to move ${count} workspaces to another window`
    );
  },

  toggleLinkSelected: async () => {
    const change = getSelectionLinkChange(get().workspaces, get().selectedWorkspaceIds);
    get().exitSelectionMode();
    if (!change) return;
    // Each pair is its own call, so one failure doesn't skip the rest; one refresh follows.
    const errors: string[] = [];
    for (const [a, b] of change.pairs) {
      try {
        if (change.unlink) await window.api.unlinkWorkspace(a.id, b.id);
        else await window.api.linkWorkspaces(a.id, [b.id]);
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    if (errors.length > 0) {
      const verb = change.unlink ? 'Unlinked' : 'Linked';
      const done = change.pairs.length - errors.length;
      const message = `${verb} ${done} of ${change.pairs.length} pairs: ${errors[0]}`;
      useToastStore.getState().addToast(message, 'error');
    }
    const workspaces = clearAttentionForSelected(
      await window.api.getWorkspaces(),
      get().selectedWorkspaceId
    );
    set({ workspaces });
    refreshLinkedWorkspaceFileLists(
      workspaces,
      change.pairs.flat().map((w) => w.id)
    );
    await window.api.notifyWorkspacesChanged();
  },

  setWorkspaceTrashed: async (workspaceId, trash, restoreOrder) => {
    const unsaved = trash ? getUnsavedFileNames([workspaceId]) : [];
    if (unsaved.length > 0 && !(await confirmDiscardingUnsavedFiles(unsaved))) return;
    const newStatus = trash ? 'trashed' : 'active';
    const workspace = get().workspaces.find((w) => w.id === workspaceId);
    const previousStatus = workspace?.status;
    const previousOrder = workspace?.order;
    const previousWindowId = workspace?.windowId;

    // When trashing, stop PTYs first so the cleanup script doesn't fight running
    // processes. Defer terminal/layout teardown until persistence resolves — if the
    // cleanup script throws, we want to leave the UI intact so the user can retry.
    if (trash && workspace) {
      try {
        await window.api.stopWorkspace(workspaceId);
        useDevServerPreviewStore
          .getState()
          .clearSshPreviewForwardState(workspaceId, { keepStopped: true });
      } catch {
        // Workspace may already be stopped, continue with the move
      }
    }

    // When restoring, place at bottom of active list and assign to current window
    let order = workspace?.order != null ? Math.round(workspace.order) : undefined;
    let newWindowId: string | null | undefined;
    if (!trash) {
      const activeOrders = get()
        .workspaces.filter((w) => w.id !== workspaceId && w.status === 'active')
        .map((w) => w.order ?? 0);
      order = restoreOrder ?? (activeOrders.length > 0 ? Math.max(...activeOrders) + 1 : 0);
      newWindowId = useWindowStore.getState().windowId;
    }

    // For a restore, optimistic local update is fine — no destructive backend work.
    if (!trash) {
      set((state) => ({
        workspaces: state.workspaces.map((w) =>
          w.id === workspaceId
            ? {
                ...w,
                status: newStatus,
                order: order ?? w.order,
                ...(newWindowId != null ? { windowId: newWindowId } : {}),
              }
            : w
        ),
      }));
    }

    try {
      await window.api.updateWorkspace(workspaceId, {
        status: newStatus,
        order,
        ...(newWindowId != null ? { windowId: newWindowId } : {}),
      });

      if (trash && workspace) {
        const wasSelected = get().selectedWorkspaceId === workspaceId;
        if (!isSshWorkspace(workspace)) {
          useFileListStore.getState().invalidate(workspace.workingDirectory, workspace.id);
        }
        disposeTerminalRenderers(workspace.terminals.map((t) => t.id));
        useLayoutStore.getState().clearWorkspaceLayout(workspaceId);
        if (wasSelected) {
          useLayoutStore.getState().setCurrentWorkspace(null);
          set({ selectedWorkspaceId: null });
        }
        set((state) => ({
          workspaces: state.workspaces.map((w) =>
            w.id === workspaceId ? { ...w, status: 'trashed' as const, order: order ?? w.order } : w
          ),
        }));
      }

      await window.api.notifyWorkspacesChanged();
      if (trash) {
        const workspaces = clearAttentionForSelected(
          await window.api.getWorkspaces(),
          get().selectedWorkspaceId
        );
        set({ workspaces });
      }
    } catch (error) {
      if (!trash) {
        // Restore: revert the optimistic update.
        set((state) => ({
          workspaces: state.workspaces.map((w) =>
            w.id === workspaceId
              ? {
                  ...w,
                  status: previousStatus!,
                  order: previousOrder!,
                  windowId: previousWindowId!,
                }
              : w
          ),
        }));
      } else {
        // Trash: PTYs were already stopped before cleanup ran, so the workspace
        // is in a stale state in the store. Refetch so terminal running flags sync.
        try {
          const workspaces = clearAttentionForSelected(
            await window.api.getWorkspaces(),
            get().selectedWorkspaceId
          );
          set({ workspaces });
        } catch {
          // If the refetch fails, keep going so the user still sees the toast.
        }
      }
      const message = (error as Error).message;
      set({ error: message });
      useToastStore.getState().addToast(message, 'error');
    }
  },

  trashWorkspaceForAgent: async ({ workspaceId, refusal }) => {
    const workspace = get().workspaces.find((w) => w.id === workspaceId);
    if (!workspace || workspace.status !== 'active') return;
    const toastStore = useToastStore.getState();
    const title = getWorkspaceDisplayTitle(workspace);
    const unsaved = getUnsavedFileNames([workspaceId]);
    const reason =
      refusal ?? (unsaved.length > 0 ? `It has unsaved files: ${unsaved.join(', ')}.` : undefined);
    if (reason) {
      toastStore.addToast(
        `An agent asked to move "${title}" to the Trash, but it stays. ${reason}`,
        'info'
      );
      return;
    }
    await get().trashWorkspaceWithUndo(
      workspaceId,
      (title) => `Moved "${title}" to the Trash, as its agent asked`
    );
  },

  trashWorkspaceWithUndo: async (
    workspaceId,
    message = (title) => `Moved "${title}" to the Trash`
  ) => {
    const workspace = get().workspaces.find((w) => w.id === workspaceId);
    if (!workspace || workspace.status !== 'active') return;
    const wasSelected = get().selectedWorkspaceId === workspaceId;
    await get().setWorkspaceTrashed(workspaceId, true);
    if (get().workspaces.find((w) => w.id === workspaceId)?.status !== 'trashed') return;
    const undo = async () => {
      await get().setWorkspaceTrashed(workspaceId, false, workspace.order);
      const restored = get().workspaces.find((w) => w.id === workspaceId);
      if (wasSelected && restored?.status === 'active') await get().selectWorkspace(workspaceId);
    };
    useToastStore.getState().addToast(message(getWorkspaceDisplayTitle(workspace)), 'success', {
      action: { label: 'Undo', onClick: () => void undo() },
    });
  },

  linkWorkspaces: async (originId, targetIds) => {
    if (targetIds.length === 0) return;
    try {
      await window.api.linkWorkspaces(originId, targetIds);
      const workspaces = clearAttentionForSelected(
        await window.api.getWorkspaces(),
        get().selectedWorkspaceId
      );
      set({ workspaces });
      refreshLinkedWorkspaceFileLists(workspaces, [originId, ...targetIds]);
      await window.api.notifyWorkspacesChanged();
    } catch (error) {
      const message = (error as Error).message;
      try {
        const workspaces = clearAttentionForSelected(
          await window.api.getWorkspaces(),
          get().selectedWorkspaceId
        );
        set({ workspaces, error: message });
        refreshLinkedWorkspaceFileLists(workspaces, [originId, ...targetIds]);
        await window.api.notifyWorkspacesChanged();
      } catch {
        set({ error: message });
      }
      throw error;
    }
  },

  unlinkWorkspace: async (originId, targetId) => {
    try {
      await window.api.unlinkWorkspace(originId, targetId);
      const workspaces = clearAttentionForSelected(
        await window.api.getWorkspaces(),
        get().selectedWorkspaceId
      );
      set({ workspaces });
      refreshLinkedWorkspaceFileLists(workspaces, [originId, targetId]);
      await window.api.notifyWorkspacesChanged();
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  clearError: () => {
    set({ error: null });
  },
}));
