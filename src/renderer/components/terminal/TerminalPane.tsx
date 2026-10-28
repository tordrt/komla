import {
  ArrowClockwise,
  GearSix,
  Clipboard,
  Cloud,
  Copy,
  DotsThree,
  ArrowSquareOut,
  Desktop,
  FileCode,
  Globe,
  Link,
  MagnifyingGlass,
  NotePencil,
  SquareSplitHorizontal,
  Sparkle,
  SquareSplitVertical,
  Star,
  Swap,
  Terminal as TerminalIcon,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import React, { useCallback, useMemo, useRef, useState } from 'react';

import { QuickCommandMenuItem } from '@/components/actions/QuickCommandMenuItem';
import { Badge } from '@/components/ui/badge';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '@/components/ui/context-menu';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TruncatedText } from '@/components/ui/truncated-text';
import { WrappingPath } from '@/components/ui/wrapping-path';
import { useActionLauncher } from '@/hooks/useActionLauncher';
import { useOnline } from '@/hooks/useOnline';
import { useShortcutDisplay } from '@/hooks/useShortcuts';
import { getActionMenuGroups } from '@/lib/action-menu-order';
import { resolveLaunchablePresets } from '@/lib/agent-launch';
import { ipcErrorMessage } from '@/lib/ipc-error-message';
import { openTerminalUrl } from '@/lib/open-terminal-url';
import { useTerminalBackground, useTerminalPaneScope } from '@/lib/palette-runtime';
import {
  getDraggedPaneId,
  getDropZone,
  isPaneDrag,
  isTabPaneDrag,
  PANE_DRAG_MIME,
  resolvePaneDropFromEvent,
  setDraggedPaneId,
} from '@/lib/pane-drag';
import { getRevealInFileManagerLabel } from '@/lib/platform-labels';
import { replaceTerminal, replaceTerminalWithPaneSurface } from '@/lib/replace-terminal';
import { executeShortcutAction } from '@/lib/shortcut-actions';
import { addLocalCopyTerminal, addTerminalForSplit } from '@/lib/split-terminal';
import { useTerminalHost } from '@/lib/terminal-host-tracker';
import {
  focusTerminalRenderer,
  getTerminalRendererDimensions,
  getTerminalRendererSelection,
  refreshTerminalRenderer,
} from '@/lib/terminal-renderer-runtime';
import { DEFAULT_TERMINAL_THEME } from '@/lib/terminal-theme';
import { cn } from '@/lib/utils';
import { getWorkspaceAttentionAppearance } from '@/lib/workspace-attention';
import { abbreviateRemoteHome, formatSshTarget } from '@/lib/workspace-host';
import { openNewActionEditor } from '@/stores/action-editor.store';
import { useActionsStore } from '@/stores/actions.store';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useCustomizationStore } from '@/stores/customization.store';
import { useLayoutStore } from '@/stores/layout.store';
import { useLocalMirrorSyncStore } from '@/stores/local-mirror-sync.store';
import { usePaneFlashStore } from '@/stores/pane-flash.store';
import { useProjectsStore } from '@/stores/projects.store';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';
import { supportsLocalCopy } from '@/stores/ssh-command-execution-location.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { claimTerminal, releaseTerminal, useTerminalBusyStore } from '@/stores/terminal-busy.store';
import { useTerminalCloseStore } from '@/stores/terminal-close.store';
import { useTerminalSearchStore } from '@/stores/terminal-search.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isLocalTerminalExecutionLocation, isSshWorkspace, paneOffer } from '@/types';

import { isDarkColor } from '../../../shared/lib/appearance';
import { isBrowserUrl } from '../../../shared/lib/browser-tabs';
import {
  buildManagedTmuxAttachCommand,
  managedTmuxSearchSupported,
} from '../../../shared/lib/ssh-tmux-attach';

import { AgentPresetMenuItems } from './AgentPresetMenuItems';
import { PaneDragGrip, paneDragGripRevealProps } from './PaneDragGrip';
import { SplitPaneMenuItems } from './surfaces/SplitPaneMenuItems';
import {
  pasteClipboardIntoTerminal,
  TerminalView,
  type TerminalContextMenuLink,
} from './TerminalView';
import { useConfirmDialog } from './useConfirmDialog';

import type { ActionPlace } from '@/lib/action-launch';
import type { AgentPreset, DropZone, PaneId } from '@/types';

// URL regex pattern (matches http, https, and common URLs)
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

function getAgentPresetName(presets: AgentPreset[], presetId: string | undefined): string {
  return presets.find((preset) => preset.id === presetId)?.name ?? 'AI Agent';
}

function getTerminalClipboardShortcutDisplay(key: string): string {
  const { platform } = window.api;
  // Off macOS, Ctrl+C/V reach the shell, so the terminal copies/pastes with Ctrl+Shift.
  return formatShortcutForDisplay(
    platform === 'darwin' ? `Cmd+${key}` : `Ctrl+Shift+${key}`,
    platform
  );
}

interface TerminalPaneProps {
  paneId: PaneId;
  terminalId: string;
  isTabActive: boolean;
  isLayoutLocked?: boolean;
  workspaceId?: string;
  /** The tab holds only this pane, so it drops its header and shows any status in a corner tab. */
  isOnlyPane?: boolean;
}

// Read when a handler runs: subscribed, every pane in every workspace would re-render on each
// title change in the selected one.
function getSelectedWorkspace() {
  const { workspaces, selectedWorkspaceId } = useWorkspacesStore.getState();
  return workspaces.find((w) => w.id === selectedWorkspaceId);
}

export const TerminalPane = React.memo(function TerminalPane({
  paneId,
  terminalId,
  isTabActive,
  isLayoutLocked = false,
  workspaceId,
  isOnlyPane = false,
}: TerminalPaneProps) {
  const [urlInSelection, setUrlInSelection] = useState<string | null>(null);
  const [contextMenuLink, setContextMenuLink] = useState<TerminalContextMenuLink | null>(null);
  // Controlled so the Actions list, which has no menu items, can close the menu.
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const [isPointerNearTop, setIsPointerNearTop] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const dragFromControlRef = useRef(false);

  const splitRightShortcut = useShortcutDisplay('pane.splitRight');
  const splitDownShortcut = useShortcutDisplay('pane.splitDown');
  const closePaneShortcut = useShortcutDisplay('pane.close');
  const searchShortcut = useShortcutDisplay('terminal.search');
  const copyShortcut = getTerminalClipboardShortcutDisplay('C');
  const pasteShortcut = getTerminalClipboardShortcutDisplay('V');

  const showPaneHeaders = useCustomizationStore((s) => s.terminalConfig?.showPaneHeaders === true);
  const showButtonsOnFocus = useCustomizationStore(
    (s) => s.terminalConfig?.showButtonsOnFocus ?? true
  );
  const unfocusedPaneDimOpacity = useCustomizationStore(
    (s) => s.terminalConfig?.unfocusedPaneDimOpacity ?? 0.85
  );
  const terminalBackground = useTerminalBackground();
  const paneScope = useTerminalPaneScope(terminalBackground);
  // Screens over the terminal take its color, not the darker window background. Over a light
  // terminal they keep the theme's background, which their text is drawn for.
  const terminalColor = terminalBackground || DEFAULT_TERMINAL_THEME.background!;
  const coverColor = isDarkColor(terminalColor) ? terminalColor : 'oklch(var(--background))';
  const terminalCover = (percent: number) => ({
    backgroundColor: `color-mix(in srgb, ${coverColor} ${percent}%, transparent)`,
  });
  const focusedPaneBorder = useCustomizationStore(
    (s) => s.terminalConfig?.focusedPaneBorder === true
  );
  const notificationPaneBorder = useCustomizationStore(
    (s) => s.terminalConfig?.notificationPaneBorder ?? true
  );

  const hostInfo = useTerminalHost(terminalId);
  const sshHosts = useSshHostsStore((state) => state.hosts);

  // Use individual selectors to minimize re-renders
  const currentWorkspaceId = useLayoutStore((s) => s.currentWorkspaceId);
  const setFocusedPane = useLayoutStore((s) => s.setFocusedPane);
  const splitPane = useLayoutStore((s) => s.splitPane);
  const swapPanes = useLayoutStore((s) => s.swapPanes);
  const movePaneToEdge = useLayoutStore((s) => s.movePaneToEdge);
  const moveTabToEdge = useLayoutStore((s) => s.moveTabToEdge);
  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const addTerminal = useWorkspacesStore((s) => s.addTerminal);
  const setTerminalDynamicTitle = useWorkspacesStore((s) => s.setTerminalDynamicTitle);
  const setPrimaryTerminal = useWorkspacesStore((s) => s.setPrimaryTerminal);
  const reconnectSshTerminal = useWorkspacesStore((s) => s.reconnectSshTerminal);
  const reconnectAllSshTerminals = useWorkspacesStore((s) => s.reconnectAllSshTerminals);
  const actions = useActionsStore((s) => s.actions);
  const loadActions = useActionsStore((s) => s.loadActions);

  const presets = useAgentPresetsStore((s) => s.presets);
  const activePresets = useAgentPresetsStore((s) => s.activePresets);
  const loadPresets = useAgentPresetsStore((s) => s.loadPresets);

  const launchablePresets = useMemo(
    () => resolveLaunchablePresets(presets, activePresets),
    [presets, activePresets]
  );

  // Use the explicit workspaceId prop for lookups so hidden workspaces resolve correctly
  const effectiveWorkspaceId = workspaceId || currentWorkspaceId;
  const isAutoReconnectingSsh = useWorkspacesStore(
    (s) => effectiveWorkspaceId !== null && s.reconnectingSshWorkspaceIds.has(effectiveWorkspaceId)
  );

  // Get focus state with memoized selector
  const activeTabId = useLayoutStore((s) =>
    effectiveWorkspaceId ? s.activeTabByWorkspace[effectiveWorkspaceId] || null : null
  );
  const hasOtherTabs = useLayoutStore(
    (s) => !!effectiveWorkspaceId && (s.tabsByWorkspace[effectiveWorkspaceId]?.length ?? 0) > 1
  );
  const focusedPaneId = useLayoutStore((s) =>
    effectiveWorkspaceId && activeTabId
      ? s.focusedPaneByTab[effectiveWorkspaceId]?.[activeTabId] || null
      : null
  );
  const isFocused = focusedPaneId === paneId;
  const isClosing = useTerminalCloseStore((s) => s.closingTerminalIds.has(terminalId));
  const flashAt = usePaneFlashStore((s) =>
    s.flash?.terminalIds.has(terminalId) ? s.flash.at : null
  );
  const busyReason = useTerminalBusyStore((s) => s.busyTerminals.get(terminalId));
  const isOnline = useOnline();
  const localMirrorSyncStatus = useLocalMirrorSyncStore(
    (s) => (effectiveWorkspaceId && s.statusesByWorkspaceId.get(effectiveWorkspaceId)) || undefined
  );
  const isLayoutMutationDisabled = isLayoutLocked || isClosing;

  // Select stable values (not a fresh wrapper object) so unrelated store updates skip re-rendering.
  const terminal = useWorkspacesStore((s) =>
    s.workspaces
      .find((w) => w.id === (effectiveWorkspaceId || s.selectedWorkspaceId))
      ?.terminals.find((t) => t.id === terminalId)
  );
  const isPrimary = useWorkspacesStore((s) => {
    const workspace = s.workspaces.find(
      (w) => w.id === (effectiveWorkspaceId || s.selectedWorkspaceId)
    );
    if (!workspace?.terminals.some((t) => t.id === terminalId)) return false;
    return (
      workspace.primaryTerminalId === terminalId ||
      (!workspace.primaryTerminalId && workspace.terminals[0]?.id === terminalId)
    );
  });

  // A browser or note takes the pane by closing its terminal; a local terminal swaps in place.
  const canReplaceWithSurface = !!effectiveWorkspaceId && !isLayoutMutationDisabled;

  const actionWorkspace = useWorkspacesStore((s) => {
    if (effectiveWorkspaceId) {
      return s.workspaces.find((w) => w.id === effectiveWorkspaceId);
    }
    return s.workspaces.find((w) => w.id === s.selectedWorkspaceId);
  });
  const remoteWorkspace =
    actionWorkspace && isSshWorkspace(actionWorkspace) ? actionWorkspace : null;
  const revealableTerminalFilePath = (() => {
    if (contextMenuLink?.type !== 'file' || !actionWorkspace) {
      return null;
    }
    if (contextMenuLink.target === 'external') {
      const runsOnLocalHost =
        !remoteWorkspace || isLocalTerminalExecutionLocation(terminal?.executionLocation);
      return runsOnLocalHost ? contextMenuLink.filePath : null;
    }
    if (remoteWorkspace) return null;
    const root = actionWorkspace.workingDirectory.replace(/[\\/]$/, '');
    return `${root}/${contextMenuLink.filePath}`;
  })();
  const offer = paneOffer(actionWorkspace, terminal);
  const usesManagedTmux = offer.managedSession;
  const isRemoteConnectionPending =
    offer.connecting ||
    (offer.stopped === 'reconnect' && (busyReason === 'reconnect' || isAutoReconnectingSsh));
  const remoteHost = remoteWorkspace
    ? (sshHosts?.find((host) => host.id === remoteWorkspace.backend.hostId) ?? null)
    : null;
  const canConvertToLocalCopy =
    !!remoteHost &&
    !isLocalTerminalExecutionLocation(terminal?.executionLocation) &&
    supportsLocalCopy(remoteHost);
  // A Local copy terminal can split off, or turn back into, a shell on the SSH host.
  const offersSshTerminal =
    !!remoteWorkspace && isLocalTerminalExecutionLocation(terminal?.executionLocation);
  const remoteHostLabel = remoteHost?.name || (remoteWorkspace ? 'SSH' : '');
  // Why its SSH connection is down, shown above the buttons that bring it back. Being offline
  // only explains a pane whose connection dropped, not an agent that ended on its own.
  const connectionProblem = !offer.stopped
    ? null
    : terminal?.connectionError
      ? {
          title: isOnline
            ? `Lost connection to ${remoteHost?.name || 'the remote host'}`
            : 'You’re offline',
          detail: terminal.connectionError,
        }
      : !isOnline && offer.stopped === 'reconnect'
        ? { title: 'You’re offline', detail: undefined }
        : null;
  const remoteTarget = remoteHost ? formatSshTarget(remoteHost) : 'SSH workspace';
  const remotePath = remoteWorkspace
    ? abbreviateRemoteHome(remoteWorkspace.backend.remoteDirectory, remoteHost?.user)
    : '';
  // Its history lives in tmux, so the search bar searches there.
  const searchesInTmux =
    usesManagedTmux &&
    terminal?.status === 'running' &&
    managedTmuxSearchSupported(remoteHost?.capabilities?.tmux.version);
  const remoteAttachCommand =
    offer.attachCommand && remoteHost
      ? buildManagedTmuxAttachCommand(remoteHost, terminalId)
      : null;
  const showRemotePill = !!remoteWorkspace && !!hostInfo && !hostInfo.isLocal;
  // Split, close and drag live in the tab's and the terminal's context menus too, so a lone
  // pane, or any pane with pane headers turned off, needs no header. Its SSH and
  // local-copy status gets a slim strip instead, and it gets a grip to drag it by, which
  // moves even a lone pane onto another tab when there is one.
  const isLocalMirror = terminal?.executionLocation === 'local-mirror';
  const hasPaneStatus =
    (isLocalMirror &&
      (!!remoteWorkspace ||
        localMirrorSyncStatus?.state === 'syncing' ||
        localMirrorSyncStatus?.state === 'error')) ||
    showRemotePill;
  const showHeader = showPaneHeaders && !isOnlyPane;
  const showStatusStrip = !showHeader && hasPaneStatus;
  const showDragGrip = !showHeader && !isLayoutMutationDisabled && (!isOnlyPane || hasOtherTabs);

  const projectId = actionWorkspace?.projectId;
  const actionProject = useProjectsStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId) : undefined
  );
  const projectColor = actionProject?.color;

  const actionMenuGroups = getActionMenuGroups(actions, projectId);
  const promptMenuGroups = actionMenuGroups.filter((group) => group.type === 'prompt');
  // The Action run becomes the one the menu rows repeat; one that asks for input, once it's given.
  const { runAction, actionInputDialog } = useActionLauncher(actionWorkspace?.id);

  const handleFocus = () => {
    setFocusedPane(paneId);
    if (terminal?.attention) {
      void window.api.clearTerminalAttention(terminalId);
    }
  };

  // Pane drag-and-drop: drag the header onto another pane to reorganize.
  // dragstart fires on the draggable header, so it can't tell whether the grab
  // began on a control button — mousedown can, and always fires first.
  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    dragFromControlRef.current = e.target instanceof Element && e.target.closest('button') !== null;
  };

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      if (isLayoutMutationDisabled) {
        e.preventDefault();
        return;
      }
      // Keep the header's control buttons inert to dragging.
      if (dragFromControlRef.current) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData(PANE_DRAG_MIME, paneId);
      e.dataTransfer.effectAllowed = 'move';
      setDraggedPaneId(paneId);
      setIsDragging(true);
    },
    [isLayoutMutationDisabled, paneId]
  );

  const handleDragEnd = useCallback(() => {
    setDraggedPaneId(null);
    setIsDragging(false);
    // A drag sends no mouse events, so the pointer may have left the top band unseen.
    setIsPointerNearTop(false);
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (isLayoutMutationDisabled) return;
      // Ignore non-pane drags (e.g. OS file drops) and hovering the drag
      // source itself. The MIME check is the real gate — getDraggedPaneId()
      // can be stale if a `dragend` was missed after a layout reflow.
      if (!isPaneDrag(e.dataTransfer)) return;
      const source = getDraggedPaneId();
      if (!source || source === paneId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = paneRef.current?.getBoundingClientRect();
      if (!rect) return;
      // dragover fires continuously; skip the state update unless the zone
      // actually changed so hovering within one zone doesn't churn React.
      const zone = getDropZone(rect, e.clientX, e.clientY, {
        edgesOnly: isTabPaneDrag(e.dataTransfer),
      });
      setDropZone((prev) => (prev === zone ? prev : zone));
    },
    [isLayoutMutationDisabled, paneId]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // dragleave also fires when crossing into a child element — only clear
    // when the pointer has actually left the pane.
    if (e.relatedTarget instanceof Node && paneRef.current?.contains(e.relatedTarget)) return;
    setDropZone(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      setDropZone(null);
      if (isLayoutMutationDisabled) return;
      if (!isPaneDrag(e.dataTransfer)) return;
      e.preventDefault();
      const rect = paneRef.current?.getBoundingClientRect();
      const action = rect
        ? resolvePaneDropFromEvent(e.dataTransfer, paneId, rect, e.clientX, e.clientY)
        : null;
      // Clear module state regardless: a `dragend` can be missed when an edge
      // drop remounts the source pane.
      setDraggedPaneId(null);
      if (action?.kind === 'swap') {
        swapPanes(action.sourcePaneId, action.targetPaneId);
      } else if (action?.kind === 'move') {
        movePaneToEdge(action.sourcePaneId, action.targetPaneId, action.edge);
      } else if (action?.kind === 'moveTab') {
        // The tab was checked for a pending close when its drag began; one may have started since.
        const { layoutsByTab, currentWorkspaceId: layoutWorkspaceId } = useLayoutStore.getState();
        const sourceLayout = layoutWorkspaceId
          ? layoutsByTab[layoutWorkspaceId]?.[action.sourceTabId]
          : undefined;
        const closingIds = useTerminalCloseStore.getState().closingTerminalIds;
        if (sourceLayout?.type === 'leaf' && !closingIds.has(sourceLayout.terminalId)) {
          moveTabToEdge(action.sourceTabId, action.targetPaneId, action.edge);
        }
      }
    },
    [isLayoutMutationDisabled, paneId, swapPanes, movePaneToEdge, moveTabToEdge]
  );

  // Style for the edge-drop indicator rail — a thin bar on the target's edge,
  // not a filled half-pane. movePane removes the dragged pane first, which
  // reflows the whole split tree, so a half-pane preview would lie about the
  // final geometry. The rail only claims "inserted on this side", which stays
  // true through the reflow.
  const edgeRailStyle = useMemo((): React.CSSProperties | null => {
    switch (dropZone) {
      case 'left':
        return { left: 0, top: 0, bottom: 0, width: 4 };
      case 'right':
        return { right: 0, top: 0, bottom: 0, width: 4 };
      case 'top':
        return { left: 0, right: 0, top: 0, height: 4 };
      case 'bottom':
        return { left: 0, right: 0, bottom: 0, height: 4 };
      default:
        return null;
    }
  }, [dropZone]);

  const handleSplitHorizontal = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (isLayoutMutationDisabled || !selectedWorkspaceId || !getSelectedWorkspace()) return;

    try {
      // Focus this pane first so the split happens here, not on another focused pane
      setFocusedPane(paneId);
      const newTerminal = await addTerminalForSplit(addTerminal, selectedWorkspaceId, terminal);
      // Horizontal icon = arrange panes horizontally (side by side)
      splitPane('vertical', newTerminal.id);
    } catch (error) {
      console.error('Failed to create terminal for split:', error);
      useToastStore
        .getState()
        .addToast(`Failed to split the pane: ${ipcErrorMessage(error)}`, 'error');
    }
  };

  const handleSplitVertical = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (isLayoutMutationDisabled || !selectedWorkspaceId || !getSelectedWorkspace()) return;

    try {
      // Focus this pane first so the split happens here, not on another focused pane
      setFocusedPane(paneId);
      const newTerminal = await addTerminalForSplit(addTerminal, selectedWorkspaceId, terminal);
      // Vertical icon = arrange panes vertically (stacked)
      splitPane('horizontal', newTerminal.id);
    } catch (error) {
      console.error('Failed to create terminal for split:', error);
      useToastStore
        .getState()
        .addToast(`Failed to split the pane: ${ipcErrorMessage(error)}`, 'error');
    }
  };

  const handleSplitLocalCopy = async (direction: 'vertical' | 'horizontal') => {
    if (isLayoutMutationDisabled || !selectedWorkspaceId || !getSelectedWorkspace()) return;

    try {
      setFocusedPane(paneId);
      const newTerminal = await addLocalCopyTerminal(addTerminal, selectedWorkspaceId);
      splitPane(direction, newTerminal.id);
    } catch (error) {
      console.error('Failed to create local terminal for split:', error);
      useToastStore
        .getState()
        .addToast(`Failed to open local terminal: ${ipcErrorMessage(error)}`, 'error');
    }
  };

  const handleSplitSshTerminal = async (direction: 'vertical' | 'horizontal') => {
    if (isLayoutMutationDisabled || !selectedWorkspaceId || !getSelectedWorkspace()) return;

    try {
      setFocusedPane(paneId);
      const newTerminal = await addTerminal(selectedWorkspaceId);
      splitPane(direction, newTerminal.id);
    } catch (error) {
      console.error('Failed to create SSH terminal for split:', error);
      useToastStore
        .getState()
        .addToast(`Failed to open SSH terminal: ${ipcErrorMessage(error)}`, 'error');
    }
  };

  const handleClose = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (isLayoutMutationDisabled) return;
    // Focus this pane first so we close this pane, not another focused pane
    setFocusedPane(paneId);
    executeShortcutAction('pane.close');
  };

  const handleCopy = useCallback(() => {
    const selection = getTerminalRendererSelection(terminalId);
    if (selection) {
      window.api.copyToClipboard(selection);
    }
  }, [terminalId]);

  const handlePaste = useCallback(async () => {
    try {
      await pasteClipboardIntoTerminal(terminalId, {
        workspaceId: effectiveWorkspaceId ?? undefined,
        executionLocation: terminal?.executionLocation,
        canImportClipboardImage:
          !isLocalTerminalExecutionLocation(terminal?.executionLocation) && !!remoteWorkspace,
      });
    } catch {
      // Clipboard read can fail if IPC is unavailable (e.g. during shutdown)
    }
  }, [effectiveWorkspaceId, remoteWorkspace, terminal?.executionLocation, terminalId]);

  const handleSearch = useCallback(() => {
    useTerminalSearchStore.getState().openSearch(terminalId);
  }, [terminalId]);

  // Detect URL in selection when context menu opens
  const handleContextMenuOpen = useCallback(
    (open: boolean) => {
      setContextMenuOpen(open);
      if (open) {
        // Context-menu gestures do not fire the pane's click handler. Focus the
        // pane as the menu opens so terminal-scoped actions target this pane.
        setFocusedPane(paneId);
        void loadActions();
        void loadPresets();
        const selection = getTerminalRendererSelection(terminalId);
        if (selection) {
          const matches = selection.match(URL_REGEX);
          setUrlInSelection(matches ? matches[0] : null);
        } else {
          setUrlInSelection(null);
        }
      } else {
        setContextMenuLink(null);
      }
    },
    [loadActions, loadPresets, paneId, setFocusedPane, terminalId]
  );

  // Radix calls onOpenChange only for closes it makes itself.
  const closeContextMenuThen = (run: () => void) => {
    handleContextMenuOpen(false);
    run();
  };

  const contextMenuUrl =
    contextMenuLink?.type === 'url'
      ? contextMenuLink.url
      : contextMenuLink === null
        ? urlInSelection
        : null;

  const { confirm, confirmDialog } = useConfirmDialog();
  const openNewQuickCommand = () =>
    closeContextMenuThen(() =>
      openNewActionEditor(projectId, () => focusTerminalRenderer(terminalId))
    );
  const manageQuickCommands = () =>
    closeContextMenuThen(() =>
      window.dispatchEvent(new CustomEvent('open-settings', { detail: 'actions' }))
    );
  // Replace With and each split submenu end with the quick commands, sharing the + menu's default
  // since they all start something new.
  const quickCommandMenuItem = (place: ActionPlace) => (
    <QuickCommandMenuItem
      menuType="context"
      groups={actionMenuGroups}
      defaultActionId={actionWorkspace?.defaultActionId}
      presets={presets}
      onRun={(action) =>
        closeContextMenuThen(() => {
          // The list isn't a menu item, so a lock that arrives while it's open doesn't grey it out.
          if (place.kind === 'split' && isLayoutMutationDisabled) return;
          runAction(action, place);
        })
      }
      onNew={openNewQuickCommand}
      onManage={manageQuickCommands}
    />
  );

  const handleRestartWithAgent = useCallback(
    (presetId: string, launchModeId: string | null) =>
      replaceTerminal(
        terminalId,
        {
          kind: 'agent',
          name: getAgentPresetName(launchablePresets, presetId),
          presetId,
          launchModeId,
        },
        confirm
      ),
    [confirm, launchablePresets, terminalId]
  );

  const handleConvertToLocalCopy = useCallback(
    () => replaceTerminal(terminalId, { kind: 'local-copy-shell' }, confirm),
    [confirm, terminalId]
  );

  const handleConvertToSshShell = useCallback(
    () => replaceTerminal(terminalId, { kind: 'ssh-shell' }, confirm),
    [confirm, terminalId]
  );

  const handleRestartSsh = useCallback(
    (plainShell: boolean) =>
      replaceTerminal(terminalId, { kind: 'remote-retry', plainShell }, confirm),
    [confirm, terminalId]
  );

  const handleReconnectSsh = useCallback(async () => {
    if (!remoteWorkspace) return;
    if (!claimTerminal(terminalId, 'reconnect')) return;
    try {
      await reconnectAllSshTerminals(remoteWorkspace.id);
    } finally {
      releaseTerminal(terminalId);
    }
  }, [reconnectAllSshTerminals, remoteWorkspace, terminalId]);

  const handleReconnectRunningSsh = useCallback(async () => {
    const dimensions = getTerminalRendererDimensions(terminalId);
    if (!claimTerminal(terminalId, 'reconnect')) return;
    try {
      await reconnectSshTerminal(terminalId, dimensions?.cols, dimensions?.rows);
      // Also rebuild the renderer, so this one item covers everything Refresh Terminal fixes.
      refreshTerminalRenderer(terminalId);
    } finally {
      releaseTerminal(terminalId);
    }
  }, [reconnectSshTerminal, terminalId]);

  const handleCopyRemoteAttachCommand = useCallback(() => {
    if (!remoteAttachCommand) return;
    window.api.copyToClipboard(remoteAttachCommand);
    useToastStore.getState().addToast('Copied tmux attach command', 'success');
  }, [remoteAttachCommand]);

  const handleCopyUrl = useCallback(() => {
    if (contextMenuUrl) {
      window.api.copyToClipboard(contextMenuUrl);
    }
  }, [contextMenuUrl]);

  const handleOpenUrl = useCallback(() => {
    if (!contextMenuUrl) return;
    openTerminalUrl(contextMenuUrl, 'external', {
      workspaceId: effectiveWorkspaceId,
      executionLocation: terminal?.executionLocation,
    });
  }, [contextMenuUrl, effectiveWorkspaceId, terminal?.executionLocation]);

  const contextMenuUrlIsWebPage = !!contextMenuUrl && isBrowserUrl(contextMenuUrl);
  const handleOpenUrlInKomla = useCallback(() => {
    if (!contextMenuUrl) return;
    openTerminalUrl(contextMenuUrl, 'preview', {
      workspaceId: effectiveWorkspaceId,
      executionLocation: terminal?.executionLocation,
    });
  }, [contextMenuUrl, effectiveWorkspaceId, terminal?.executionLocation]);

  const handleOpenFileLink = useCallback(() => {
    if (contextMenuLink?.type === 'file') contextMenuLink.open();
  }, [contextMenuLink]);

  const handleCopyFileLink = useCallback(() => {
    if (contextMenuLink?.type === 'file') {
      window.api.copyToClipboard(contextMenuLink.rawPath);
    }
  }, [contextMenuLink]);

  const handleRevealFileLink = useCallback(() => {
    if (revealableTerminalFilePath) {
      window.api.showItemInFolder(revealableTerminalFilePath);
    }
  }, [revealableTerminalFilePath]);

  const handleRefreshTerminal = useCallback(() => {
    refreshTerminalRenderer(terminalId);
  }, [terminalId]);

  const handleSetPrimary = async () => {
    if (!selectedWorkspaceId || isPrimary) return;
    await setPrimaryTerminal(selectedWorkspaceId, terminalId);
  };

  const handleTitleChange = useCallback(
    (title: string) => {
      setTerminalDynamicTitle(terminalId, title);
    },
    [terminalId, setTerminalDynamicTitle]
  );

  const getTabName = (): string => {
    return terminal?.dynamicTitle || terminal?.name || 'Terminal';
  };

  const attentionAppearance = getWorkspaceAttentionAppearance(terminal?.attention);
  const showAttentionBorder =
    notificationPaneBorder && !!attentionAppearance && !(isTabActive && isFocused);

  const paneStyle = useMemo(() => {
    if (!focusedPaneBorder) return undefined;
    return {
      borderBottomWidth: '2px',
      borderBottomStyle: 'solid' as const,
      borderBottomColor: isFocused
        ? projectColor || 'oklch(var(--primary))'
        : 'oklch(var(--border) / 0.4)',
      transition: 'border-color 150ms, background-color 150ms',
    };
  }, [focusedPaneBorder, isFocused, projectColor]);

  const terminalContentStyle = useMemo(
    () => ({ opacity: isFocused ? 1 : unfocusedPaneDimOpacity }),
    [isFocused, unfocusedPaneDimOpacity]
  );

  // In the slim strip, badges drop their outline and share one corner tab, keeping the project
  // color in their text.
  const stripBadgeClassName = showStatusStrip ? 'px-0 ring-0' : undefined;
  const paneStatus = (
    <>
      {!!remoteWorkspace && terminal?.executionLocation === 'local-mirror' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              tone="primary"
              variant="outline"
              className={cn('min-w-0 shrink overflow-hidden', stripBadgeClassName)}
            >
              <Copy className="size-2.5 shrink-0" weight="fill" />
              <span className="truncate">Local copy · Read-only</span>
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Source syncs one way from the SSH workspace. Local source edits are not uploaded and may
            be overwritten.
          </TooltipContent>
        </Tooltip>
      )}
      {terminal?.executionLocation === 'local-mirror' &&
        localMirrorSyncStatus?.state === 'syncing' && (
          <span
            role="status"
            aria-label="Syncing local copy"
            className="flex shrink-0 items-center gap-1 text-2xs font-medium text-primary"
          >
            <Spinner size="xs" />
            <span>Syncing…</span>
          </span>
        )}
      {terminal?.executionLocation === 'local-mirror' &&
        localMirrorSyncStatus?.state === 'error' && (
          <button
            type="button"
            aria-label="Retry local copy sync"
            title={`${localMirrorSyncStatus.message} Click to retry.`}
            className="flex shrink-0 items-center gap-1 text-2xs font-medium text-error hover:underline"
            draggable={false}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (!effectiveWorkspaceId) return;
              void window.api.retryLocalMirrorSync(effectiveWorkspaceId).catch((error) => {
                useToastStore
                  .getState()
                  .addToast(
                    `Failed to retry local copy sync: ${(error as Error).message}`,
                    'error'
                  );
              });
            }}
          >
            <WarningCircle className="size-3" weight="fill" />
            <span>Sync failed · Retry</span>
          </button>
        )}
      {showRemotePill && (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* An empty title keeps the header's drag hint off this tooltip. */}
            <Badge tone="primary" variant="outline" title="" className={stripBadgeClassName}>
              <Cloud className="size-2.5" weight="fill" />
              <span className="max-w-[120px] truncate">{remoteHostLabel}</span>
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-sm">
            <div className="flex items-start gap-2 text-xs">
              <div className="min-w-0">
                <p className="font-medium">{remoteTarget}</p>
                <p
                  data-testid="remote-path"
                  className="mt-0.5 font-mono text-ui text-muted-foreground"
                >
                  <WrappingPath path={remotePath} />
                </p>
              </div>
              {remoteAttachCommand && (
                <button
                  type="button"
                  aria-label="Copy tmux attach command"
                  title="Copy tmux attach command"
                  onClick={handleCopyRemoteAttachCommand}
                  className="-mr-1.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
                >
                  <Copy className="size-3.5" />
                </button>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );

  return (
    <>
      <ContextMenu open={contextMenuOpen} onOpenChange={handleContextMenuOpen}>
        <ContextMenuTrigger asChild>
          <div
            ref={paneRef}
            className={cn(
              'relative isolate flex h-full min-h-0 flex-col transition-opacity',
              isDragging && 'opacity-40',
              // Allotment draws the split's divider over the pane's top or left edge at
              // z-index 5; the notification border takes that edge's place.
              showAttentionBorder && 'z-[6]',
              paneScope.className
            )}
            style={paneScope.style}
            onClick={handleFocus}
            {...paneDragGripRevealProps(showDragGrip, setIsPointerNearTop)}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {flashAt !== null && (
              <div
                key={flashAt}
                aria-hidden="true"
                className="pane-flash pointer-events-none absolute inset-0 z-40 motion-reduce:hidden"
              />
            )}
            {/* Pane header — the whole bar is the drag handle */}
            {showHeader && (
              <div
                className="group/pane-header relative flex h-6 cursor-grab items-center justify-between border-b border-foreground/10 px-2 active:cursor-grabbing"
                // On the terminal's own color, so the header doesn't cut a band across the pane.
                style={{ backgroundColor: terminalBackground, ...paneStyle }}
                draggable={!isLayoutMutationDisabled}
                onMouseDown={handleHeaderMouseDown}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                title="Drag to move this pane"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                  <TruncatedText
                    className={cn(
                      'max-w-[240px] text-xs transition-colors duration-150',
                      isFocused ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {getTabName()}
                  </TruncatedText>
                  {paneStatus}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label="Split terminal right"
                        onClick={handleSplitHorizontal}
                        disabled={isLayoutMutationDisabled}
                        className={cn(
                          'rounded-md p-1 transition-opacity hover:bg-muted/50',
                          showButtonsOnFocus && isFocused
                            ? 'opacity-100'
                            : 'opacity-0 group-hover/pane-header:opacity-100'
                        )}
                      >
                        <SquareSplitHorizontal className="size-3 text-muted-foreground" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <span className="flex items-center gap-2">
                        Split Right
                        {splitRightShortcut && <Kbd>{splitRightShortcut}</Kbd>}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label="Split terminal down"
                        onClick={handleSplitVertical}
                        disabled={isLayoutMutationDisabled}
                        className={cn(
                          'rounded-md p-1 transition-opacity hover:bg-muted/50',
                          showButtonsOnFocus && isFocused
                            ? 'opacity-100'
                            : 'opacity-0 group-hover/pane-header:opacity-100'
                        )}
                      >
                        <SquareSplitVertical className="size-3 text-muted-foreground" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <span className="flex items-center gap-2">
                        Split Down
                        {splitDownShortcut && <Kbd>{splitDownShortcut}</Kbd>}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={isClosing ? 'Closing terminal' : 'Close terminal pane'}
                        onClick={handleClose}
                        disabled={isLayoutMutationDisabled}
                        className={cn(
                          'rounded-md p-1 transition-opacity',
                          isClosing ? 'cursor-wait opacity-100' : 'hover:bg-muted/50',
                          !isClosing && showButtonsOnFocus && isFocused
                            ? 'opacity-100'
                            : !isClosing && 'opacity-0 group-hover/pane-header:opacity-100'
                        )}
                      >
                        {isClosing ? (
                          <Spinner size="xs" className="text-muted-foreground" />
                        ) : (
                          <X className="size-3 text-muted-foreground" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <span className="flex items-center gap-2">
                        Close Pane
                        {closePaneShortcut && <Kbd>{closePaneShortcut}</Kbd>}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            )}

            {showStatusStrip && (
              <div
                data-testid="pane-status-strip"
                className="flex h-4 shrink-0 justify-end"
                // On the terminal's own color, so only the corner tab stands out from the terminal.
                style={{ backgroundColor: terminalBackground }}
              >
                {/* Above the drag grip, which shares this row and could cover it in a narrow pane. */}
                <div className="relative z-30 flex min-w-0 items-center gap-2 overflow-hidden rounded-bl-md bg-foreground/7 px-2">
                  {paneStatus}
                </div>
              </div>
            )}

            {/* Headerless panes drag by a grip at the top middle, shown near the top edge. */}
            {showDragGrip && (
              <PaneDragGrip
                revealed={isPointerNearTop}
                backgroundColor={terminalBackground}
                onDragStart={(e) => {
                  // The grip holds no buttons, so clear a press left by the header's controls.
                  dragFromControlRef.current = false;
                  handleDragStart(e);
                }}
                onDragEnd={handleDragEnd}
              />
            )}

            {/* Terminal content. Isolated, as dimming already isolates it in an unfocused pane, so
                its overlays stay under the grip the way they stayed under the header. */}
            <div
              className="relative isolate min-h-0 flex-1 overflow-clip transition-opacity duration-150"
              style={terminalContentStyle}
            >
              <TerminalView
                terminalId={terminalId}
                isActive={isTabActive && isFocused && !isClosing}
                isTabActive={isTabActive}
                workingDirectory={actionWorkspace?.workingDirectory}
                fileLinkWorkspaceRoot={
                  remoteWorkspace && terminal?.executionLocation !== 'local-mirror'
                    ? remoteWorkspace.backend.remoteDirectory
                    : actionWorkspace?.workingDirectory
                }
                workspaceId={effectiveWorkspaceId ?? undefined}
                executionLocation={terminal?.executionLocation}
                workspaceBackendKind={remoteWorkspace ? 'ssh' : 'local'}
                allowOsc52Clipboard={usesManagedTmux}
                copyOnSelect={usesManagedTmux}
                searchesInTmux={searchesInTmux}
                onTitleChange={handleTitleChange}
                onLinkContextMenu={setContextMenuLink}
              />
              {isClosing && (
                <div className="absolute inset-0 z-40 flex cursor-wait items-center justify-center bg-background/35 backdrop-blur-[1px]">
                  <div className="flex items-center gap-2 rounded-md bg-card/90 px-3 py-2 text-xs text-muted-foreground shadow-xs">
                    <Spinner size="md" />
                    <span>Closing terminal…</span>
                  </div>
                </div>
              )}
              {isRemoteConnectionPending && (
                <div
                  className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
                  style={terminalCover(70)}
                >
                  <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
                    <Spinner size="lg" className="text-primary" />
                    <span>Connecting to remote workspace…</span>
                  </div>
                </div>
              )}
              {terminal?.startupError && (
                <div
                  className="absolute inset-0 z-30 flex items-center justify-center p-6"
                  style={terminalCover(100)}
                >
                  <div className="max-w-md text-center">
                    <p className="text-sm font-medium">
                      {terminal.executionLocation === 'local-mirror'
                        ? 'Couldn’t prepare the local copy'
                        : 'Couldn’t connect to the remote workspace'}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">{terminal.startupError}</p>
                    <button
                      type="button"
                      onClick={handleClose}
                      className="mt-4 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
                    >
                      Close terminal
                    </button>
                  </div>
                </div>
              )}
              {offer.stopped && !terminal?.startupError && !isRemoteConnectionPending && (
                <div
                  className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 p-6 backdrop-blur-[1px]"
                  style={terminalCover(70)}
                >
                  {connectionProblem && (
                    <div role="alert" className="max-w-md text-center">
                      <p className="text-sm font-medium">{connectionProblem.title}</p>
                      {connectionProblem.detail && (
                        <p className="mt-1 text-xs break-words text-muted-foreground">
                          {connectionProblem.detail}
                        </p>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    {offer.stopped === 'reconnect' && (
                      <button
                        type="button"
                        onClick={() => void handleReconnectSsh()}
                        disabled={busyReason !== undefined || isAutoReconnectingSsh}
                        className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium shadow-xs transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-80"
                      >
                        <Cloud className="size-4" />
                        Reconnect session
                      </button>
                    )}
                    {offer.stopped === 'restart' && (
                      <button
                        type="button"
                        onClick={() => void handleRestartSsh(false)}
                        disabled={busyReason !== undefined}
                        className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium shadow-xs transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-80"
                      >
                        {busyReason === 'remote-agent' ? (
                          <>
                            <Spinner size="md" />
                            Retrying agent…
                          </>
                        ) : (
                          <>
                            <ArrowClockwise className="size-4" />
                            Retry agent
                          </>
                        )}
                      </button>
                    )}
                    {offer.stopped === 'restart' && (
                      <button
                        type="button"
                        onClick={() => void handleRestartSsh(true)}
                        disabled={busyReason !== undefined}
                        className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium shadow-xs transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-80"
                      >
                        {busyReason === 'remote-shell' ? (
                          <>
                            <Spinner size="md" />
                            Opening shell…
                          </>
                        ) : (
                          <>
                            <TerminalIcon className="size-4" />
                            Open shell
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {showAttentionBorder && (
              <div
                className="pointer-events-none absolute inset-0 z-10 border transition-colors duration-150"
                style={{
                  borderColor: attentionAppearance.borderColor,
                  opacity: attentionAppearance.borderOpacity ?? 0.6,
                }}
              />
            )}

            {/* Drop indicator while a pane is dragged over this one. */}
            {dropZone === 'center' && (
              <div className="pointer-events-none absolute inset-0 z-20 rounded-sm border-2 border-primary bg-primary/20" />
            )}
            {edgeRailStyle && (
              <>
                <div className="pointer-events-none absolute inset-0 z-20 rounded-sm border-2 border-primary/40" />
                <div
                  className="pointer-events-none absolute z-20 rounded-full bg-primary"
                  style={edgeRailStyle}
                />
              </>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {contextMenuLink?.type === 'file' && (
            <>
              <ContextMenuItem onSelect={handleOpenFileLink}>
                <FileCode />
                Open File
              </ContextMenuItem>
              {revealableTerminalFilePath && (
                <ContextMenuItem onSelect={handleRevealFileLink}>
                  <MagnifyingGlass />
                  {getRevealInFileManagerLabel()}
                </ContextMenuItem>
              )}
              <ContextMenuItem onSelect={handleCopyFileLink}>
                <Copy />
                Copy Path
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          {contextMenuUrl && (
            <>
              {contextMenuUrlIsWebPage && effectiveWorkspaceId && (
                <ContextMenuItem onSelect={handleOpenUrlInKomla}>
                  <Globe />
                  Open in Komla Browser
                </ContextMenuItem>
              )}
              <ContextMenuItem onSelect={handleOpenUrl}>
                <ArrowSquareOut />
                {contextMenuUrlIsWebPage ? 'Open in Default Browser' : 'Open URL'}
              </ContextMenuItem>
              <ContextMenuItem onSelect={handleCopyUrl}>
                <Link />
                Copy URL
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          {usesManagedTmux ? (
            <ContextMenuItem disabled>
              <Copy />
              Selection copies automatically
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={handleCopy}>
              <Copy />
              Copy
              <ContextMenuShortcut>{copyShortcut}</ContextMenuShortcut>
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={handlePaste}>
            <Clipboard />
            Paste
            <ContextMenuShortcut>{pasteShortcut}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleSearch}>
            <MagnifyingGlass />
            Find...
            <ContextMenuShortcut>{searchShortcut}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* Near the top: without pane headers, this menu is where panes split. */}
          <SplitPaneMenuItems
            workspaceId={effectiveWorkspaceId}
            paneId={paneId}
            disabled={isLayoutMutationDisabled}
            onSplitTerminal={(direction) =>
              direction === 'vertical' ? handleSplitHorizontal() : handleSplitVertical()
            }
            onSplitLocalTerminal={
              canConvertToLocalCopy
                ? (direction) => void handleSplitLocalCopy(direction)
                : undefined
            }
            onSplitSshTerminal={
              offersSshTerminal ? (direction) => void handleSplitSshTerminal(direction) : undefined
            }
            quickCommands={(direction) =>
              quickCommandMenuItem({
                kind: 'split',
                paneId,
                terminalId,
                tabId: activeTabId,
                direction,
              })
            }
          />
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Swap />
              Replace With
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {canConvertToLocalCopy && (
                <ContextMenuItem
                  disabled={isClosing || busyReason !== undefined || isAutoReconnectingSsh}
                  onSelect={() => void handleConvertToLocalCopy()}
                >
                  <Desktop />
                  Local Terminal
                </ContextMenuItem>
              )}
              {offersSshTerminal && (
                <ContextMenuItem
                  disabled={isClosing || busyReason !== undefined}
                  onSelect={() => void handleConvertToSshShell()}
                >
                  <Cloud />
                  SSH Terminal
                </ContextMenuItem>
              )}
              {(
                [
                  { kind: 'browser', label: 'Browser', icon: <Globe /> },
                  { kind: 'note', label: 'Note', icon: <NotePencil /> },
                ] as const
              ).map(({ kind, label, icon }) => (
                <ContextMenuItem
                  key={kind}
                  disabled={!canReplaceWithSurface}
                  onSelect={() =>
                    effectiveWorkspaceId &&
                    void replaceTerminalWithPaneSurface(
                      effectiveWorkspaceId,
                      terminalId,
                      paneId,
                      kind,
                      confirm
                    )
                  }
                >
                  {icon}
                  {label}
                </ContextMenuItem>
              ))}
              <ContextMenuSeparator />
              {/* The workspace prompt Actions launch in, so both pick the same default agent. */}
              <AgentPresetMenuItems
                workspaceId={actionWorkspace?.id}
                menuType="context"
                onLaunch={(presetId, launchModeId) =>
                  void handleRestartWithAgent(presetId, launchModeId)
                }
              />
              <ContextMenuSeparator />
              {quickCommandMenuItem({ kind: 'replace', terminalId, confirm })}
            </ContextMenuSubContent>
          </ContextMenuSub>
          {/* Saved Prompts typed into this terminal, ready to send, with a default of their own. */}
          {promptMenuGroups.length > 0 ? (
            <QuickCommandMenuItem
              menuType="context"
              groups={promptMenuGroups}
              defaultActionId={actionWorkspace?.paneDefaultActionId}
              presets={presets}
              hint="Paste"
              disabled={terminal?.status === 'stopped'}
              onRun={(action) =>
                closeContextMenuThen(() => runAction(action, { kind: 'type', terminalId }))
              }
              onNew={openNewQuickCommand}
              onManage={manageQuickCommands}
            />
          ) : (
            <ContextMenuItem disabled>
              <Sparkle />
              Paste Prompt
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          {usesManagedTmux && terminal?.status === 'running' ? (
            <ContextMenuItem
              onSelect={() => void handleReconnectRunningSsh()}
              disabled={isClosing || busyReason !== undefined || isAutoReconnectingSsh}
            >
              <ArrowClockwise />
              Refresh SSH Session
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={handleRefreshTerminal}>
              <ArrowClockwise />
              Refresh Terminal
            </ContextMenuItem>
          )}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <DotsThree />
              More
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={handleSetPrimary} disabled={isPrimary}>
                <Star className={cn(isPrimary && 'fill-current text-yellow-500')} />
                {isPrimary ? 'Primary Terminal' : 'Set as Primary'}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  window.dispatchEvent(
                    new CustomEvent('open-settings', {
                      detail: { tab: 'general', section: 'terminal' },
                    })
                  )
                }
              >
                <GearSix />
                Terminal Settings
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={isLayoutMutationDisabled} onSelect={() => handleClose()}>
            <X />
            Close Pane
            <ContextMenuShortcut>{closePaneShortcut}</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {actionInputDialog}
      {confirmDialog}
    </>
  );
});
