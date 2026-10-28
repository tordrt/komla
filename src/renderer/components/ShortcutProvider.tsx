import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CommandCenterDialog } from '@/components/command-center/CommandCenterDialog';
import { VoiceInputOverlay } from '@/components/VoiceInputOverlay';
import { flashWaitingAgents } from '@/components/workspaces/agent-state';
import { BulkDeleteDialog } from '@/components/workspaces/BulkDeleteDialog';
import {
  BulkTrashDialog,
  needsBulkTrashConfirmation,
} from '@/components/workspaces/BulkTrashDialog';
import { matchesWorkspaceListFiltersExceptHost } from '@/components/workspaces/workspace-list-filtering';
import { useShortcuts, useDoubleTapShortcuts } from '@/hooks/useShortcuts';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import { resolveDefaultLaunchTarget } from '@/lib/agent-launch';
import { getFocusedTerminalId } from '@/lib/focused-terminal';
import { createNote } from '@/lib/notes';
import { openFolder } from '@/lib/open-folder';
import { closePaneBrowserTab } from '@/lib/pane-surfaces';
import { registerShortcutAction, executeShortcutAction } from '@/lib/shortcut-actions';
import { toggleSidebarCollapsed } from '@/lib/sidebar-collapsed';
import { findNextAttentionWorkspaceId } from '@/lib/workspace-attention';
import { isWorkspaceHostVisible } from '@/lib/workspace-host';
import { orderWorkspacesForShortcuts } from '@/lib/workspace-shortcut-order';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useCommandCenterStore } from '@/stores/command-center.store';
import { useConfigStore } from '@/stores/config.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useLayoutStore } from '@/stores/layout.store';
import { useQuickLookStore } from '@/stores/quick-look.store';
import { useToastStore } from '@/stores/toast.store';
import { useVoiceStore } from '@/stores/voice.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { canStop, isSshWorkspace, probesOnSelect, showsRunning, Workspace } from '@/types';

import { isPaneSurfaceId } from '../../shared/lib/pane-surface-id';

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift']);

/**
 * How long next/previous waits for another press before selecting an SSH workspace that selecting
 * connects to its host, so a workspace only stepped past opens no connection.
 */
export const SSH_STEP_COMMIT_DELAY_MS = 300;

/** Return the preferred workspace to navigate to, or null if none show as running. */
function findRunningWorkspace(preferredId: string | null, workspaces: Workspace[]): string | null {
  if (preferredId) {
    const preferred = workspaces.find((w) => w.id === preferredId);
    if (preferred && showsRunning(preferred)) {
      return preferredId;
    }
  }
  // Fall back to the first running workspace
  const running = workspaces.find(showsRunning);
  return running?.id ?? null;
}

function findFocusedTerminalId(): string | null {
  const { currentWorkspaceId } = useLayoutStore.getState();
  const id = currentWorkspaceId ? getFocusedTerminalId(currentWorkspaceId) : null;
  // A focused browser or note pane has no terminal to type into.
  return id && !isPaneSurfaceId(id) ? id : null;
}

function openVoiceSettings() {
  window.dispatchEvent(new CustomEvent('open-settings', { detail: 'voice' }));
}

interface ShortcutProviderProps {
  children: React.ReactNode;
  onOpenNewWorkspaceDialog: () => void;
}

/**
 * Provides app-wide keyboard shortcuts for workspace navigation,
 * settings, and other global actions.
 *
 * Also registers actions with the global shortcut action dispatcher
 * so they can be triggered from xterm's custom key handler.
 */
export function ShortcutProvider({ children, onOpenNewWorkspaceDialog }: ShortcutProviderProps) {
  const {
    workspaces,
    selectedWorkspaceId,
    selectWorkspace,
    showDashboard,
    displayOrderedWorkspaceIds,
    hiddenWorkspaceHostIds,
    hideStopped,
    hiddenProjectIds,
    selectionMode,
    selectedWorkspaceIds,
    addTerminal,
    addAgentTab,
    stopWorkspace,
    trashWorkspaceWithUndo,
    trashSelectedWorkspaces,
    deleteSelectedWorkspaces,
  } = useWorkspacesStore();
  const { addTab, showTabInFullPane, selectNextTab, selectPreviousTab } = useLayoutStore();
  const { requestInlineFilePreviewClose, toggleInlineFileTree, requestFileViewerTransition } =
    useFileViewerStore();
  const currentWindowId = useWindowStore((s) => s.windowId);
  const [bulkTrashDialogOpen, setBulkTrashDialogOpen] = useState(false);
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const commandCenterOpen = useCommandCenterStore((s) => s.open);
  const commandCenterMode = useCommandCenterStore((s) => s.mode);
  const commandCenterSession = useCommandCenterStore((s) => s.session);
  const toggleCommandCenterSearch = useCommandCenterStore((s) => s.toggle);
  const toggleCommandCenter = useCallback(
    () => toggleCommandCenterSearch('workspaces'),
    [toggleCommandCenterSearch]
  );
  const keyboardNavigationCode = useRef<string | null>(null);
  const cancelKeyboardNavigationCommit = useRef<(() => void) | null>(null);
  const keyboardNavigationWaitsForPause = useRef(false);

  const clearKeyboardNavigation = useCallback(() => {
    keyboardNavigationCode.current = null;
    keyboardNavigationWaitsForPause.current = false;
    cancelKeyboardNavigationCommit.current?.();
    cancelKeyboardNavigationCommit.current = null;
    if (useWorkspacesStore.getState().keyboardNavigationWorkspaceId !== null) {
      useWorkspacesStore.setState({ keyboardNavigationWorkspaceId: null });
    }
  }, []);

  useEffect(() => clearKeyboardNavigation, [clearKeyboardNavigation]);

  // A click or another action selecting a workspace supersedes a pending key-repeat burst.
  useEffect(() => {
    if (useWorkspacesStore.getState().keyboardNavigationWorkspaceId !== null) {
      clearKeyboardNavigation();
    }
  }, [selectedWorkspaceId, clearKeyboardNavigation]);

  // Track previous workspace for overview toggle
  const previousWorkspaceId = useRef<string | null>(null);

  // Update previous workspace whenever selection changes away from overview
  useEffect(() => {
    if (selectedWorkspaceId !== null) {
      previousWorkspaceId.current = selectedWorkspaceId;
    }
  }, [selectedWorkspaceId]);

  // Only consider workspaces assigned to this window
  const windowWorkspaces = useMemo(
    () => workspaces.filter((w) => w.windowId === currentWindowId),
    [workspaces, currentWindowId]
  );

  const hostVisibleWindowWorkspaces = useMemo(
    () =>
      windowWorkspaces.filter((workspace) =>
        isWorkspaceHostVisible(workspace, hiddenWorkspaceHostIds)
      ),
    [windowWorkspaces, hiddenWorkspaceHostIds]
  );

  // Get visible workspaces — sidebar only shows active ones (none in the Trash)
  const visibleWorkspaces = hostVisibleWindowWorkspaces.filter((w) => w.status === 'active');

  // Sort workspaces by display order (matches the sidebar list).
  // Falls back to manual order if display order hasn't been synced yet.
  const sortedWorkspaces = useMemo(() => {
    return orderWorkspacesForShortcuts(visibleWorkspaces, displayOrderedWorkspaceIds);
  }, [visibleWorkspaces, displayOrderedWorkspaceIds]);

  // Next/previous steps through the workspaces the sidebar shows as running, skipping the dimmed
  // stopped ones. That includes an SSH workspace whose session runs on its host while this device
  // isn't attached; selecting it attaches.
  const runningWorkspaces = sortedWorkspaces.filter(showsRunning);

  const showOverview = useCallback(() => {
    if (selectedWorkspaceId === null) {
      if (showDashboard) {
        // Already in overview — try to return to previous workspace
        const target = findRunningWorkspace(
          previousWorkspaceId.current,
          hostVisibleWindowWorkspaces
        );
        if (target) {
          void selectWorkspace(target);
        } else {
          // Nothing running to return to — dismiss dashboard
          useWorkspacesStore.setState({ showDashboard: false });
        }
      } else {
        // In normal view with no workspace — show the dashboard
        useWorkspacesStore.setState({ showDashboard: true });
      }
    } else {
      void selectWorkspace(null);
    }
  }, [selectedWorkspaceId, showDashboard, selectWorkspace, hostVisibleWindowWorkspaces]);

  const settleKeyboardNavigation = useCallback(
    (event?: KeyboardEvent) => {
      // macOS sends no keyup for a key released while Cmd is held, so a modifier's release also
      // ends a held-key burst.
      if (
        event &&
        keyboardNavigationCode.current &&
        event.code !== keyboardNavigationCode.current &&
        !MODIFIER_KEYS.has(event.key)
      ) {
        return;
      }
      // A single press onto an SSH workspace that would connect commits on its timer, not on release.
      if (event && !keyboardNavigationCode.current && keyboardNavigationWaitsForPause.current) {
        return;
      }
      const targetId = useWorkspacesStore.getState().keyboardNavigationWorkspaceId;
      clearKeyboardNavigation();
      if (targetId) void selectWorkspace(targetId);
    },
    [clearKeyboardNavigation, selectWorkspace]
  );

  const navigateWorkspace = useCallback(
    (direction: 1 | -1, event?: KeyboardEvent) => {
      if (runningWorkspaces.length === 0) return;

      const currentId =
        useWorkspacesStore.getState().keyboardNavigationWorkspaceId ?? selectedWorkspaceId;
      const currentIndex = runningWorkspaces.findIndex((workspace) => workspace.id === currentId);
      const targetIndex =
        direction === 1
          ? currentIndex === -1
            ? 0
            : (currentIndex + 1) % runningWorkspaces.length
          : currentIndex <= 0
            ? runningWorkspaces.length - 1
            : currentIndex - 1;
      const target = runningWorkspaces[targetIndex];
      const targetId = target.id;

      // Only the lightweight sidebar highlight moves now. Once the OS starts repeating the key,
      // the final target is committed on release.
      useWorkspacesStore.setState({ keyboardNavigationWorkspaceId: targetId });
      if (event?.repeat) {
        keyboardNavigationCode.current = event.code;
        return;
      }

      // A single press loads the workspace once the highlight has painted, so the highlight
      // never waits for the workspace view. Presses before then retarget the commit. Selecting
      // an SSH workspace that isn't attached connects to its host, so that waits for presses
      // to stop.
      keyboardNavigationCode.current = null;
      cancelKeyboardNavigationCommit.current?.();
      const waitsForPause = isSshWorkspace(target) && probesOnSelect(target);
      keyboardNavigationWaitsForPause.current = waitsForPause;
      const commit = () => {
        cancelKeyboardNavigationCommit.current = null;
        keyboardNavigationWaitsForPause.current = false;
        if (!keyboardNavigationCode.current) settleKeyboardNavigation();
      };
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let frame: number | undefined;
      if (waitsForPause) {
        timeout = setTimeout(commit, SSH_STEP_COMMIT_DELAY_MS);
      } else {
        frame = requestAnimationFrame(() => {
          timeout = setTimeout(commit, 0);
        });
      }
      cancelKeyboardNavigationCommit.current = () => {
        if (frame !== undefined) cancelAnimationFrame(frame);
        clearTimeout(timeout);
      };
    },
    [runningWorkspaces, selectedWorkspaceId, settleKeyboardNavigation]
  );

  useEffect(() => {
    const handleKeyUp = (event: KeyboardEvent) => settleKeyboardNavigation(event);
    const handleBlur = () => settleKeyboardNavigation();
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [settleKeyboardNavigation]);

  const selectNextWorkspace = useCallback(
    (event?: KeyboardEvent) => navigateWorkspace(1, event),
    [navigateWorkspace]
  );

  const selectPreviousWorkspace = useCallback(
    (event?: KeyboardEvent) => navigateWorkspace(-1, event),
    [navigateWorkspace]
  );

  const selectWorkspaceByIndex = useCallback(
    (index: number) => {
      if (index < sortedWorkspaces.length) {
        void selectWorkspace(sortedWorkspaces[index].id);
      }
    },
    [sortedWorkspaces, selectWorkspace]
  );

  // Cycles through workspaces waiting on the user (input, then errors) in
  // sidebar order. Workspaces in collapsed groups count too: they aren't in the
  // display order, so they come after the visible ones.
  const selectNextAttentionWorkspace = useCallback(() => {
    const listed = visibleWorkspaces.filter((workspace) =>
      matchesWorkspaceListFiltersExceptHost(workspace, {
        currentWindowId,
        hideStopped,
        hiddenProjectIds,
      })
    );
    const shown = orderWorkspacesForShortcuts(listed, displayOrderedWorkspaceIds);
    const shownIds = new Set(shown.map((workspace) => workspace.id));
    const collapsed = orderWorkspacesForShortcuts(
      listed.filter((workspace) => !shownIds.has(workspace.id)),
      null
    );
    const targetId = findNextAttentionWorkspaceId([...shown, ...collapsed], selectedWorkspaceId);
    if (!targetId) {
      useToastStore.getState().addToast('No workspaces need input', 'info');
      return;
    }
    clearKeyboardNavigation();
    const target = listed.find((workspace) => workspace.id === targetId);
    if (target) flashWaitingAgents(target);
    void selectWorkspace(targetId);
  }, [
    visibleWorkspaces,
    currentWindowId,
    hideStopped,
    hiddenProjectIds,
    displayOrderedWorkspaceIds,
    selectedWorkspaceId,
    clearKeyboardNavigation,
    selectWorkspace,
  ]);

  const stopSelectedWorkspace = useCallback(() => {
    if (!selectedWorkspaceId) return;
    const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);
    if (!canStop(workspace)) return;
    void stopWorkspace(selectedWorkspaceId);
  }, [selectedWorkspaceId, workspaces, stopWorkspace]);

  const trashSelectedWorkspace = useCallback(() => {
    if (selectionMode && selectedWorkspaceIds.size > 0) {
      if (needsBulkTrashConfirmation(selectedWorkspaceIds.size)) setBulkTrashDialogOpen(true);
      else void trashSelectedWorkspaces();
      return;
    }
    if (!selectedWorkspaceId) return;
    void trashWorkspaceWithUndo(selectedWorkspaceId);
  }, [
    selectionMode,
    selectedWorkspaceIds,
    selectedWorkspaceId,
    trashSelectedWorkspaces,
    trashWorkspaceWithUndo,
  ]);

  const deleteSelectedWorkspace = useCallback(() => {
    if (selectionMode && selectedWorkspaceIds.size > 0) {
      setBulkDeleteDialogOpen(true);
      return;
    }
    if (!selectedWorkspaceId) return;
    window.dispatchEvent(new CustomEvent('delete-workspace', { detail: selectedWorkspaceId }));
  }, [selectionMode, selectedWorkspaceIds, selectedWorkspaceId]);

  const openNewAgentTab = useCallback(() => {
    if (!selectedWorkspaceId) return;
    const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);
    const { presets, activePresets } = useAgentPresetsStore.getState();
    const defaultLaunchModeId = useConfigStore.getState().config?.defaultLaunchModeId ?? null;
    const target = resolveDefaultLaunchTarget(
      workspace,
      presets,
      activePresets,
      defaultLaunchModeId
    );
    if (!target) {
      useToastStore
        .getState()
        .addToast('No agent preset configured. Add one in settings.', 'error');
      window.dispatchEvent(new CustomEvent('open-settings', { detail: 'agent' }));
      return;
    }
    void (async () => {
      try {
        const terminal = await addAgentTab(
          selectedWorkspaceId,
          undefined,
          target.launchModeId ?? undefined,
          target.presetId
        );
        addTab(selectedWorkspaceId, terminal.id);
        showTabInFullPane(terminal.id);
        void useAgentPresetsStore.getState().setActivePreset(target.presetId, target.launchModeId);
      } catch (error) {
        useToastStore
          .getState()
          .addToast(`Failed to launch agent: ${(error as Error).message}`, 'error');
      }
    })();
  }, [selectedWorkspaceId, workspaces, addAgentTab, addTab, showTabInFullPane]);

  const toggleDiff = useCallback(() => {
    if (selectedWorkspaceId) {
      const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);
      const isGitWorkspace = !!workspace?.isWorktree;
      if (!isGitWorkspace) return;
      requestFileViewerTransition({
        kind: 'toggle',
        workspaceId: selectedWorkspaceId,
        mode: 'diff',
      });
    }
  }, [selectedWorkspaceId, workspaces, requestFileViewerTransition]);

  const toggleHistory = useCallback(() => {
    if (selectedWorkspaceId) {
      const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);
      if (!workspace?.isWorktree) return;
      requestFileViewerTransition({
        kind: 'toggle',
        workspaceId: selectedWorkspaceId,
        mode: 'diff',
        diffSubMode: 'history',
      });
    }
  }, [selectedWorkspaceId, workspaces, requestFileViewerTransition]);

  const toggleFiles = useCallback(() => {
    // File search searches the open workspace's directory.
    if (workspaces.find((w) => w.id === selectedWorkspaceId)?.workingDirectory) {
      toggleCommandCenterSearch('files');
    }
  }, [selectedWorkspaceId, workspaces, toggleCommandCenterSearch]);

  const toggleTree = useCallback(() => {
    if (selectedWorkspaceId) {
      requestFileViewerTransition({
        kind: 'toggle',
        workspaceId: selectedWorkspaceId,
        mode: 'browse',
      });
    }
  }, [selectedWorkspaceId, requestFileViewerTransition]);

  const toggleInlineTree = useCallback(() => {
    if (selectedWorkspaceId) {
      toggleInlineFileTree(selectedWorkspaceId);
    }
  }, [selectedWorkspaceId, toggleInlineFileTree]);

  const newNote = useCallback(() => {
    if (selectedWorkspaceId) void createNote(selectedWorkspaceId);
  }, [selectedWorkspaceId]);

  const createTerminal = useCallback(async () => {
    if (!selectedWorkspaceId) return;
    const workspaceId = selectedWorkspaceId;
    const openTerminal = async (): Promise<void> => {
      try {
        const terminal = await addTerminal(workspaceId);
        // Add terminal to current workspace's tabs and switch to it
        addTab(workspaceId, terminal.id);
        showTabInFullPane(terminal.id);
      } catch (error) {
        console.error('Failed to create terminal:', error);
        const message = error instanceof Error ? error.message : String(error);
        useToastStore.getState().addToast(`Failed to open a terminal: ${message}`, 'error', {
          action: { label: 'Retry', onClick: () => void openTerminal() },
        });
      }
    };
    await openTerminal();
  }, [selectedWorkspaceId, addTerminal, addTab, showTabInFullPane]);

  // Global voice input — transcribes and types into the terminal that was
  // focused when recording stopped
  const voiceInput = useVoiceInput({
    captureTarget: findFocusedTerminalId,
    onTranscription: useCallback((text: string, terminalId: string | null) => {
      if (!terminalId) {
        useToastStore
          .getState()
          .addToast(
            'No active terminal — select a workspace with a terminal to use voice input.',
            'error'
          );
        return;
      }
      // The trailing space keeps the next dictation or typed word apart.
      window.api.sendInput(terminalId, `${text} `);
    }, []),
  });

  // The voice shortcut is a double-tap that is easy to hit by accident, so
  // keep at most one setup hint on screen.
  const voiceSetupToastId = useRef<string | null>(null);
  const showVoiceSetupToast = useCallback((modelStatus: string) => {
    const toastStore = useToastStore.getState();
    const shownId = voiceSetupToastId.current;
    if (shownId && toastStore.toasts.some((toast) => toast.id === shownId)) return;
    const downloading = modelStatus === 'downloading' || modelStatus === 'extracting';
    voiceSetupToastId.current = toastStore.addToast(
      downloading
        ? 'The voice model is still downloading.'
        : 'Voice input needs a transcription model.',
      'info',
      {
        action: { label: downloading ? 'View progress' : 'Set up', onClick: openVoiceSettings },
        progress: downloading,
      }
    );
  }, []);

  const toggleVoiceRecording = useCallback(() => {
    // Let a modal dialog (e.g. NewWorkspaceDialog) intercept the shortcut
    // by calling preventDefault on a cancellable custom event.
    const event = new CustomEvent('komla:voice-toggle', { cancelable: true });
    if (!window.dispatchEvent(event)) return;

    if (voiceInput.isStarting) {
      // Mic is opening (e.g. browser permission prompt visible) — bail out
      // so the user isn't stuck waiting for getUserMedia to settle.
      voiceInput.cancelRecording();
    } else if (voiceInput.isRecording) {
      voiceInput.stopAndTranscribe();
    } else {
      const { modelStatus, loadModelStatus } = useVoiceStore.getState();
      if (modelStatus === 'unknown') {
        void loadModelStatus()
          .then(() => {
            const loadedStatus = useVoiceStore.getState().modelStatus;
            if (loadedStatus === 'ready') voiceInput.startRecording();
            else showVoiceSetupToast(loadedStatus);
          })
          .catch(() => showVoiceSetupToast('unknown'));
        return;
      }
      if (modelStatus !== 'ready') {
        showVoiceSetupToast(modelStatus);
        return;
      }
      voiceInput.startRecording();
    }
  }, [voiceInput, showVoiceSetupToast]);

  // Escape key exits overview and returns to previous workspace
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      // Cancel global voice recording on Escape (also during pending mic open)
      if (event.key === 'Escape' && (voiceInput.isStarting || voiceInput.isRecording)) {
        event.preventDefault();
        voiceInput.cancelRecording();
        return;
      }

      if (event.key === 'Escape' && selectedWorkspaceId === null && showDashboard) {
        // A dialog, menu or tooltip on top already handled this Escape by closing.
        if (event.defaultPrevented) return;
        // If selection mode is active, let the DashboardView handler exit it instead
        if (useWorkspacesStore.getState().selectionMode) return;
        event.preventDefault();
        const target = findRunningWorkspace(
          previousWorkspaceId.current,
          hostVisibleWindowWorkspaces
        );
        if (target) {
          void selectWorkspace(target);
        } else {
          useWorkspacesStore.setState({ showDashboard: false });
        }
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [
    selectedWorkspaceId,
    showDashboard,
    selectWorkspace,
    hostVisibleWindowWorkspaces,
    voiceInput,
  ]);

  // Activate double-tap shortcuts (e.g., DoubleTap+Shift for file.open)
  useDoubleTapShortcuts();

  // Listen for pane-close shortcut from main process (intercepted before Electron closes window)
  // If the file viewer or picker is open, close it instead of closing a pane
  useEffect(() => {
    return window.api.onPaneCloseShortcut((page) => {
      // Pressed inside a browser pane's page: that page's tab closes, not the focused pane.
      if (page && isPaneSurfaceId(page.tabId)) {
        closePaneBrowserTab(page.workspaceId, page.tabId);
        return;
      }
      const quickLook = useQuickLookStore.getState();
      if (quickLook.session) {
        quickLook.close();
        return;
      }
      const commandCenter = useCommandCenterStore.getState();
      if (commandCenter.open) {
        commandCenter.close();
        return;
      }
      const { currentWorkspaceId } = useLayoutStore.getState();
      const { fileViewerWorkspaceId, inlineFilePreviewByWorkspace } = useFileViewerStore.getState();
      const inlinePreviewOpen = currentWorkspaceId
        ? (inlineFilePreviewByWorkspace[currentWorkspaceId]?.open ?? false)
        : false;

      if (inlinePreviewOpen && currentWorkspaceId) {
        requestInlineFilePreviewClose(currentWorkspaceId);
      } else if (fileViewerWorkspaceId) {
        const store = useFileViewerStore.getState();
        const mode = store.fileViewerMode;
        if (mode === 'browse') {
          // Always let FileViewerDialog handle browse-mode closes so dirty files
          // go through the unsaved-changes confirmation before the viewer closes.
          store.requestCloseTab();
        } else {
          store.requestFileViewerTransition({
            kind: 'close',
            workspaceId: fileViewerWorkspaceId,
          });
        }
      } else {
        executeShortcutAction('pane.close');
      }
    });
  }, [requestInlineFilePreviewClose]);

  // Shortcuts pressed inside a native browser preview never reach window listeners
  useEffect(() => {
    return window.api.onForwardedShortcut((actionId) => {
      executeShortcutAction(actionId);
    });
  }, []);

  // Register app-wide actions with the global dispatcher
  // This allows TerminalView to execute them directly when xterm captures keys
  useEffect(() => {
    const cleanups = [
      registerShortcutAction('workspace.next', selectNextWorkspace),
      registerShortcutAction('workspace.previous', selectPreviousWorkspace),
      registerShortcutAction('workspace.navigation.release', settleKeyboardNavigation),
      registerShortcutAction('workspace.select.1', () => selectWorkspaceByIndex(0)),
      registerShortcutAction('workspace.select.2', () => selectWorkspaceByIndex(1)),
      registerShortcutAction('workspace.select.3', () => selectWorkspaceByIndex(2)),
      registerShortcutAction('workspace.select.4', () => selectWorkspaceByIndex(3)),
      registerShortcutAction('workspace.select.5', () => selectWorkspaceByIndex(4)),
      registerShortcutAction('workspace.select.6', () => selectWorkspaceByIndex(5)),
      registerShortcutAction('workspace.select.7', () => selectWorkspaceByIndex(6)),
      registerShortcutAction('workspace.select.8', () => selectWorkspaceByIndex(7)),
      registerShortcutAction('workspace.select.9', () => selectWorkspaceByIndex(8)),
      registerShortcutAction('workspace.nextAttention', selectNextAttentionWorkspace),
      registerShortcutAction('workspace.overview', showOverview),
      registerShortcutAction('workspace.new', onOpenNewWorkspaceDialog),
      registerShortcutAction('workspace.openFolder', () => void openFolder()),
      registerShortcutAction('commandCenter.open', toggleCommandCenter),
      registerShortcutAction('sidebar.toggle', toggleSidebarCollapsed),

      registerShortcutAction('workspace.stop', stopSelectedWorkspace),
      registerShortcutAction('workspace.trash', trashSelectedWorkspace),
      registerShortcutAction('workspace.delete', deleteSelectedWorkspace),
      registerShortcutAction('diff.toggle', toggleDiff),
      registerShortcutAction('history.toggle', toggleHistory),
      registerShortcutAction('file.open', toggleFiles),
      registerShortcutAction('file.tree', toggleTree),
      registerShortcutAction('inline.file.tree', toggleInlineTree),
      registerShortcutAction('note.new', newNote),
      registerShortcutAction('tab.newAgent', openNewAgentTab),
      registerShortcutAction('terminal.new', () => {
        void createTerminal();
      }),
      registerShortcutAction('tab.next', selectNextTab),
      registerShortcutAction('tab.previous', selectPreviousTab),
      registerShortcutAction('voice.record', toggleVoiceRecording),
      registerShortcutAction('voice.cancel', () => voiceInput.cancelRecording()),
    ];

    return () => cleanups.forEach((cleanup) => cleanup());
  }, [
    selectNextWorkspace,
    selectPreviousWorkspace,
    settleKeyboardNavigation,
    selectWorkspaceByIndex,
    selectNextAttentionWorkspace,
    showOverview,
    onOpenNewWorkspaceDialog,
    toggleCommandCenter,
    openNewAgentTab,
    stopSelectedWorkspace,
    trashSelectedWorkspace,
    deleteSelectedWorkspace,
    toggleDiff,
    toggleHistory,
    toggleFiles,
    toggleTree,
    toggleInlineTree,
    newNote,
    createTerminal,
    selectNextTab,
    selectPreviousTab,
    toggleVoiceRecording,
    voiceInput,
  ]);

  // Define shortcut handlers for window-level keyboard events
  // These work when focus is NOT in xterm
  useShortcuts({
    'workspace.next': selectNextWorkspace,
    'workspace.previous': selectPreviousWorkspace,
    'workspace.select.1': () => selectWorkspaceByIndex(0),
    'workspace.select.2': () => selectWorkspaceByIndex(1),
    'workspace.select.3': () => selectWorkspaceByIndex(2),
    'workspace.select.4': () => selectWorkspaceByIndex(3),
    'workspace.select.5': () => selectWorkspaceByIndex(4),
    'workspace.select.6': () => selectWorkspaceByIndex(5),
    'workspace.select.7': () => selectWorkspaceByIndex(6),
    'workspace.select.8': () => selectWorkspaceByIndex(7),
    'workspace.select.9': () => selectWorkspaceByIndex(8),
    'workspace.nextAttention': selectNextAttentionWorkspace,
    'workspace.overview': showOverview,
    'workspace.new': onOpenNewWorkspaceDialog,
    'workspace.openFolder': () => void openFolder(),
    'commandCenter.open': toggleCommandCenter,
    'sidebar.toggle': toggleSidebarCollapsed,

    'workspace.stop': stopSelectedWorkspace,
    'workspace.trash': trashSelectedWorkspace,
    'workspace.delete': deleteSelectedWorkspace,
    'tab.newAgent': openNewAgentTab,
    'diff.toggle': toggleDiff,
    'history.toggle': toggleHistory,
    'file.open': toggleFiles,
    'file.tree': toggleTree,
    'inline.file.tree': toggleInlineTree,
    'note.new': newNote,
    'terminal.new': () => {
      void createTerminal();
    },
    'tab.next': selectNextTab,
    'tab.previous': selectPreviousTab,
    'voice.record': toggleVoiceRecording,
  });

  return (
    <>
      {children}
      <BulkTrashDialog
        open={bulkTrashDialogOpen}
        onOpenChange={setBulkTrashDialogOpen}
        workspaces={workspaces.filter((w) => selectedWorkspaceIds.has(w.id))}
        onConfirm={() => void trashSelectedWorkspaces()}
      />
      <BulkDeleteDialog
        open={bulkDeleteDialogOpen}
        onOpenChange={setBulkDeleteDialogOpen}
        workspaces={workspaces.filter((w) => selectedWorkspaceIds.has(w.id))}
        onConfirm={(deleteBranch) => void deleteSelectedWorkspaces(true, deleteBranch)}
      />
      <CommandCenterDialog
        open={commandCenterOpen}
        mode={commandCenterMode}
        session={commandCenterSession}
        onOpenChange={(open) => {
          if (!open) useCommandCenterStore.getState().close();
        }}
        onModeChange={useCommandCenterStore.getState().setMode}
      />
      <VoiceInputOverlay
        isRecording={voiceInput.isRecording}
        isStarting={voiceInput.isStarting}
        isTranscribing={voiceInput.isTranscribing}
        levels={voiceInput.levels}
        duration={voiceInput.duration}
        remainingSeconds={voiceInput.remainingSeconds}
        onStop={() => voiceInput.stopAndTranscribe()}
        onCancel={() => voiceInput.cancelRecording()}
        onCancelTranscription={() => voiceInput.cancelTranscription()}
      />
    </>
  );
}
