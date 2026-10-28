import {
  Square,
  CheckSquare,
  Trash,
  GitBranch,
  GitFork,
  PencilSimple,
  FolderOpen,
  Folder,
  Alarm,
  CalendarDots,
  EnvelopeSimple,
  PushPin,
  PushPinSlash,
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowsClockwise,
  Link as LinkIcon,
  DotsThree,
  CircleNotch,
  Cloud,
  XCircle,
} from '@phosphor-icons/react';
import React, { lazy, useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';

import { ProjectMark } from '@/components/projects/ProjectMark';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { DeferredDialog } from '@/components/ui/DeferredDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getDiffComparison } from '@/hooks/useDiffComparison';
import { useNow } from '@/hooks/useNow';
import { useSelectionGlide } from '@/hooks/useSelectionGlide';
import { formatElapsed, formatRelativeTime } from '@/lib/format-time';
import { openWorkspace } from '@/lib/open-workspace';
import { waitsForNotification } from '@/lib/snooze';
import { cn } from '@/lib/utils';
import { getUnreadBadge, getWorkspaceAttentionAppearance } from '@/lib/workspace-attention';
import { useAutomationsStore } from '@/stores/automations.store';
import { useConfigStore } from '@/stores/config.store';
import { openNewWorkspaceDialog } from '@/stores/dialogs.store';
import { useFileListStore } from '@/stores/file-list.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useGitStatusStore } from '@/stores/git-status.store';
import {
  holdLaunchUndo,
  registerLaunchUndoRow,
  takeLaunchUndo,
  useLaunchUndoStore,
} from '@/stores/launch-undo.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import {
  canStop,
  isRunningHere,
  isSshWorkspace,
  isWorkspaceSnoozed,
  showsRunning,
  TRASH_RETENTION_MS,
} from '@/types';

import { countUnpushedBranchCommits } from '../../../shared/lib/workspace-branch-status';
import { canDeleteWorkspaceBranch } from '../../../shared/types/workspace';

import {
  AGENT_STATES,
  AGENT_STATES_BY_URGENCY,
  AgentStateIcon,
  agentStateOf,
  attentionDetail,
  urgency,
  workspaceCardStatus,
  WorkingAgentsGlyph,
  workingSince,
  type Agent,
  type AgentState,
  type WorkspaceCardStatus,
} from './agent-state';
import { AttentionGlyph, AttentionTooltipContent } from './AttentionTooltipContent';
import { BulkContextMenuContent } from './BulkContextMenu';
import { ColorPickerSubmenu } from './ColorPickerSubmenu';
import { CopyWorkspaceSubmenu } from './CopyWorkspaceSubmenu';
import { GitStatusIndicator } from './GitStatusIndicator';
import { LinkWorkspacesDialog } from './LinkWorkspacesDialog';
import { MoveToWindowMenuItems } from './MoveToWindowMenu';
import { CustomSnoozeDialog, SnoozeCountdown, SnoozeSubmenu, useCiRunning } from './SnoozeMenu';
import { getWorkspaceDynamicTitle, WorkspaceInfoCardContent } from './WorkspaceInfoCard';
import { TagSubmenu, WorkspaceTagPill } from './WorkspaceTagMenu';

import type { GitBranchQuickStatus, Terminal, Workspace, WorkspaceAttention } from '@/types';

// Lazy so the file viewer's code loads on first open rather than at startup.
const FileViewerDialog = lazy(() =>
  import('./file-viewer/FileViewerDialog').then((module) => ({
    default: module.FileViewerDialog,
  }))
);

interface WorkspaceCardProps {
  workspace: Workspace;
  projectInfo?: { name: string; color: string; icon?: string } | null;
  hideDirectoryPath?: boolean;
  isDragging?: boolean;
  dropPosition?: 'before' | 'after' | null;
  orderedWorkspaceIds?: string[];
  /** Monotonic counter that increments every 60s to refresh relative timestamps */
  tick?: number;
  dndEnabled?: boolean;
  onDragStart?: (workspaceId: string) => void;
  onDragEnd?: () => void;
  onDragOver?: (workspaceId: string, position: 'before' | 'after') => void;
  onDrop?: () => void;
}

export const WorkspaceCard = React.memo(function WorkspaceCard({
  workspace,
  projectInfo,
  hideDirectoryPath,
  isDragging,
  dropPosition,
  orderedWorkspaceIds,
  dndEnabled,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: WorkspaceCardProps) {
  // Boolean selectors, so a switch re-renders only the two cards whose selection changed.
  const isSelected = useWorkspacesStore((s) => s.selectedWorkspaceId === workspace.id);
  // While a held arrow key moves the highlight, only its target looks selected.
  const isVisuallySelected = useWorkspacesStore((s) =>
    s.keyboardNavigationWorkspaceId
      ? s.keyboardNavigationWorkspaceId === workspace.id
      : s.selectedWorkspaceId === workspace.id
  );
  // How many workspaces the launch that made this one created, while it can be undone.
  const launchUndoCount = useLaunchUndoStore((s) =>
    s.offer?.workspaceIds.includes(workspace.id) ? s.offer.workspaceIds.length : 0
  );
  const stopWorkspace = useWorkspacesStore((s) => s.stopWorkspace);
  const restartWorkspace = useWorkspacesStore((s) => s.restartWorkspace);
  const isRestarting = useWorkspacesStore(
    (s) => s.restartingWorkspaceIds?.has(workspace.id) ?? false
  );
  const deleteWorkspace = useWorkspacesStore((s) => s.deleteWorkspace);
  const setWorkspaceTrashed = useWorkspacesStore((s) => s.setWorkspaceTrashed);
  const trashWorkspaceWithUndo = useWorkspacesStore((s) => s.trashWorkspaceWithUndo);
  const updateWorkspace = useWorkspacesStore((s) => s.updateWorkspace);
  const moveWorkspaceToWindow = useWorkspacesStore((s) => s.moveWorkspaceToWindow);
  const markUnread = useWorkspacesStore((s) => s.markUnread);
  const setPinned = useWorkspacesStore((s) => s.setPinned);
  const snoozeWorkspace = useWorkspacesStore((s) => s.snoozeWorkspace);
  const selectionMode = useWorkspacesStore((s) => s.selectionMode);
  const selectedWorkspaceIds = useWorkspacesStore((s) => s.selectedWorkspaceIds);
  const enterSelectionMode = useWorkspacesStore((s) => s.enterSelectionMode);
  const toggleWorkspaceSelection = useWorkspacesStore((s) => s.toggleWorkspaceSelection);
  const shiftSelectWorkspaces = useWorkspacesStore((s) => s.shiftSelectWorkspaces);

  const fileViewerWorkspaceId = useFileViewerStore((s) => s.fileViewerWorkspaceId);
  const fileViewerMode = useFileViewerStore((s) => s.fileViewerMode);
  const storeInitialFilePath = useFileViewerStore((s) => s.fileViewerInitialFilePath);
  const storeInitialLineNumber = useFileViewerStore((s) => s.fileViewerInitialLineNumber);
  const fileViewerHistoryFilterPath = useFileViewerStore((s) => s.fileViewerHistoryFilterPath);
  const inlinePreview = useFileViewerStore((s) => s.inlineFilePreviewByWorkspace?.[workspace.id]);
  const closeFileViewer = useFileViewerStore((s) => s.closeFileViewer);

  const currentWindowId = useWindowStore((s) => s.windowId);
  const availableWindows = useWindowStore((s) => s.availableWindows);
  const hideBranchNameInWorkspaceCards =
    useConfigStore((state) => state.config?.hideBranchNameInWorkspaceCards) === true;
  const compact = useConfigStore((state) => state.config?.compactWorkspaceList) === true;
  const sshHosts = useSshHostsStore((state) => state.hosts);
  const automationName = useAutomationsStore(
    (state) => state.automationNameByWorkspace[workspace.id]
  );
  const showAgentSpinner = useConfigStore((state) => state.config?.showAgentSpinner) !== false;
  const gitStatus = useGitStatusStore((state) => state.statusMap.get(workspace.id)?.status);
  const projectBaseBranch = useProjectsStore((state) =>
    workspace.projectId
      ? state.projects.find((project) => project.id === workspace.projectId)?.baseBranch
      : undefined
  );
  const isMultiSelected = selectedWorkspaceIds.has(workspace.id);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useSelectionGlide(cardRef, isVisuallySelected);
  useEffect(() => {
    if (isVisuallySelected) {
      cardRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [isVisuallySelected]);
  const fileViewerOpen = fileViewerWorkspaceId === workspace.id;
  const handleCloseFileViewer = (open: boolean) => {
    if (!open) closeFileViewer();
  };
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteBranchChecked, setDeleteBranchChecked] = useState(false);

  const canDeleteBranch = canDeleteWorkspaceBranch(workspace, projectBaseBranch);

  // Check if branch has been pushed to remote
  const branchHasRemote = gitStatus?.hasRemote ?? false;
  const [customNameDialogOpen, setCustomNameDialogOpen] = useState(false);
  const [customNameInput, setCustomNameInput] = useState('');
  const customNameInputRef = useRef<HTMLInputElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);

  const runningHere = isRunningHere(workspace);
  const inTrash = workspace.status === 'trashed';
  const shownRunning = showsRunning(workspace);
  const isAnyPreviewFullscreen = !!inlinePreview?.open && inlinePreview.layout === 'full';
  // The selected workspace's tab strip shows each agent and the user sees what's done there, so
  // its card keeps only what the workspace still carries, such as a prompt, and its working
  // agents, so selecting a card doesn't make it look idle. A fullscreen preview hides every tab —
  // both the terminals and the tab strip's per-tab spinners/badges — so while one is open the card
  // shows every agent, as it does for a workspace out of view.
  const cardStatus: WorkspaceCardStatus =
    isSelected && !isAnyPreviewFullscreen
      ? {
          attention: workspace.attention,
          others: workspaceCardStatus(workspace).others.filter(
            (agent) => agent.state === 'working'
          ),
        }
      : workspaceCardStatus(workspace);
  // An unread mark shows when nothing an agent raised outranks it, and not while it's open.
  const unreadBadge = cardStatus.attention || isSelected ? undefined : getUnreadBadge(workspace);
  const displayAttention = cardStatus.attention ?? unreadBadge?.attention;
  const otherAgents = showAgentSpinner
    ? cardStatus.others
    : cardStatus.others.filter((agent) => agent.state !== 'working');
  const attentionAppearance =
    unreadBadge?.appearance ?? getWorkspaceAttentionAppearance(displayAttention);

  // Get display title - prefer customName, then primary terminal's dynamic title,
  // fall back to first terminal, then persisted lastDynamicTitle, then workspace name
  const displayTitle =
    workspace.customName || getWorkspaceDynamicTitle(workspace) || workspace.name;

  const handleSetCustomName = useCallback(() => {
    // Pre-fill with current display title (customName, dynamicTitle, or workspace name)
    setCustomNameInput(displayTitle);
    setCustomNameDialogOpen(true);
    // Select all text after dialog opens
    setTimeout(() => {
      customNameInputRef.current?.select();
    }, 0);
  }, [displayTitle]);

  // Listen for shortcut-triggered delete-workspace event
  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent).detail === workspace.id) {
        if (canDeleteBranch) {
          setDeleteBranchChecked(true);
        }
        setDeleteDialogOpen(true);
      }
    };
    window.addEventListener('delete-workspace', handler);
    return () => window.removeEventListener('delete-workspace', handler);
  }, [workspace.id, canDeleteBranch]);

  const handleResetCustomName = async () => {
    updateWorkspace(workspace.id, { customName: undefined, promptSubmits: undefined });
    const updated = await window.api.updateWorkspace(workspace.id, { customName: undefined });
    updateWorkspace(workspace.id, {
      customName: updated.customName,
      customNameSource: updated.customNameSource,
      customNameGeneratedAt: updated.customNameGeneratedAt,
      promptSubmitsSinceCustomNameGeneration: updated.promptSubmitsSinceCustomNameGeneration,
      promptSubmits: updated.promptSubmits,
      autoNaming: updated.autoNaming,
    });
  };

  const handleSaveCustomName = async () => {
    const trimmed = customNameInput.trim();
    if (trimmed) {
      updateWorkspace(workspace.id, { customName: trimmed });
      await window.api.updateWorkspace(workspace.id, { customName: trimmed });
    } else if (workspace.customName) {
      await handleResetCustomName();
    }
    setCustomNameDialogOpen(false);
  };

  const handleRegenerateCustomName = async () => {
    try {
      const updated = await window.api.regenerateWorkspaceName(workspace.id);
      updateWorkspace(workspace.id, updated);
    } catch (err) {
      useToastStore
        .getState()
        .addToast(err instanceof Error ? err.message : 'Failed to regenerate title', 'error');
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    // A click in something portalled out of the card, such as a dialog's backdrop, isn't on it.
    if (!e.currentTarget.contains(e.target as Node)) return;
    // A workspace in the Trash is never picked for a bulk action: any click restores it into
    // this window and opens it.
    if (inTrash) {
      void openWorkspace(workspace, currentWindowId);
      return;
    }
    // Cmd/Ctrl+click picks the card for a bulk action without opening it.
    if (e.metaKey || e.ctrlKey) {
      if (selectionMode) toggleWorkspaceSelection(workspace.id);
      else enterSelectionMode(workspace.id);
      return;
    }
    if (e.shiftKey && !selectionMode) {
      enterSelectionMode(workspace.id);
      return;
    }
    if (selectionMode) {
      if (e.shiftKey && orderedWorkspaceIds) {
        shiftSelectWorkspaces(workspace.id, orderedWorkspaceIds);
      } else {
        toggleWorkspaceSelection(workspace.id);
      }
      return;
    }
    void openWorkspace(workspace, currentWindowId);
  };

  const handleContextMenu = () => {
    if (selectionMode && !isMultiSelected && !inTrash) {
      toggleWorkspaceSelection(workspace.id);
    }
  };

  const handleMoveToWindow = (targetWindowId: string) => {
    void moveWorkspaceToWindow(workspace.id, targetWindowId);
  };

  const handleMoveToNewWindow = async () => {
    const newWindowId = await window.api.createWindow();
    await moveWorkspaceToWindow(workspace.id, newWindowId);
  };

  const handleNewFromHere = useCallback(() => {
    if (!workspace.projectId || !workspace.branchName) return;
    openNewWorkspaceDialog({
      prefill: {
        baseBranch: workspace.branchName,
        projectId: workspace.projectId,
        sourceWorkspaceId: workspace.id,
        ...(isSshWorkspace(workspace) ? { sshHostId: workspace.backend.hostId } : {}),
      },
    });
  }, [workspace]);

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    void stopWorkspace(workspace.id);
  };

  const handleRestart = (e: React.MouseEvent) => {
    e.stopPropagation();
    void restartWorkspace(workspace.id).catch(() => {
      // The store tells the user.
    });
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Default: delete branch with worktree (typical workflow is to clean up both)
    if (canDeleteBranch) {
      setDeleteBranchChecked(true);
    }
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    const shouldDeleteBranch = deleteBranchChecked && canDeleteBranch;
    setDeleteDialogOpen(false);
    setDeleteBranchChecked(false); // Reset for next time
    await deleteWorkspace(workspace.id, true, shouldDeleteBranch);
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', workspace.id);
    onDragStart?.(workspace.id);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const rect = e.currentTarget.getBoundingClientRect();
    const threshold = rect.height * 0.3;
    // Use 30% zones at top/bottom to reduce flickering on the boundary
    const position = e.clientY < rect.top + threshold ? 'before' : 'after';

    onDragOver?.(workspace.id, position);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    onDrop?.();
  };

  const isRemoteWorkspace = isSshWorkspace(workspace);
  const sshHost =
    isRemoteWorkspace && sshHosts
      ? (sshHosts.find((host) => host.id === workspace.backend.hostId) ?? null)
      : null;

  const titleAdornment = (
    <TitleAdornment
      attention={displayAttention}
      attentionTerminal={workspace.terminals.find(
        (terminal) => terminal.id === displayAttention?.terminalId
      )}
      attentionAppearance={attentionAppearance}
      unread={!!unreadBadge}
      otherAgents={otherAgents}
      restarting={isRestarting}
      tag={workspace.tag}
      tagFromPullRequest={workspace.tagSource === 'pull-request'}
      tagTooltip={workspace.tagTooltip}
    />
  );

  const secondaryLine = getSecondaryLineKind(workspace, {
    attentionBody: attentionAppearance?.body,
    hideBranchNameInWorkspaceCards,
    hideDirectoryPath,
  });

  // Shared card content
  const cardContent = (
    <WorkspaceInfoPopover
      label={`Workspace details for ${displayTitle}`}
      content={
        <WorkspaceInfoCardContent
          workspace={workspace}
          sshHost={sshHost}
          showBranch={secondaryLine !== 'branch'}
        />
      }
      footer={
        <ActivityRow
          workspace={workspace}
          shownRunning={shownRunning}
          showWorkingClock={showAgentSpinner}
          launchUndo={
            launchUndoCount > 0 && <LaunchUndoLink count={launchUndoCount} cardRef={cardRef} />
          }
        />
      }
    >
      <div className="min-w-0 overflow-hidden">
        {projectInfo && <ProjectBadge projectInfo={projectInfo} workspace={workspace} />}
        <div
          className={cn(
            'flex items-center gap-1.5 text-sm leading-snug',
            isVisuallySelected ? 'font-medium' : 'font-normal'
          )}
        >
          <span
            className={cn(
              'truncate',
              (workspace.autoNaming || workspace.provisioning) &&
                'animate-pulse text-muted-foreground'
            )}
          >
            {displayTitle}
          </span>
          {/* Unsnoozed, a pinned card sits under the Pinned shelf's heading. */}
          {workspace.pinned && isWorkspaceSnoozed(workspace) && (
            <PushPin
              role="img"
              aria-label="Pinned"
              weight="fill"
              className="size-3 shrink-0 text-muted-foreground"
            />
          )}
          {automationName !== undefined && (
            <CalendarDots
              role="img"
              aria-label={`Started by the ${automationName} automation`}
              className="size-3 shrink-0 text-muted-foreground"
            />
          )}
          {!isWorkspaceSnoozed(workspace) ? (
            titleAdornment
          ) : (
            // One cluster on the right, so the countdown sits beside the badges.
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <SnoozeCountdown
                until={workspace.snoozedUntil}
                untilNotified={workspace.wakesOnNotification}
              />
              {titleAdornment}
            </span>
          )}
        </div>
        <SecondaryLine
          kind={secondaryLine}
          workspace={workspace}
          attentionBody={attentionAppearance?.body}
        />
      </div>
    </WorkspaceInfoPopover>
  );

  const cardClassName = getCardClassName({
    isSelected: isVisuallySelected,
    isDragging,
    dropPosition,
    stopped: !shownRunning,
    selectionMode,
    isMultiSelected,
    compact,
  });

  const dndProps = dndEnabled
    ? {
        draggable: !selectionMode,
        onDragStart: handleDragStart,
        onDragEnd,
        onDragOver: handleDragOver,
        onDrop: handleDrop,
      }
    : {};

  // Regular workspace: full context menu
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={cardRef}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          {...dndProps}
          className={cardClassName}
        >
          {isVisuallySelected && (
            <span
              ref={highlightRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10 origin-top rounded-[inherit] bg-foreground/[0.07] shadow-[inset_0_0_0_1px_oklch(var(--foreground)/0.08),0_1px_2px_rgb(0_0_0/0.15)]"
            />
          )}
          <SelectionCheckbox
            selectionMode={selectionMode && !inTrash}
            isMultiSelected={isMultiSelected}
          />
          {cardContent}
        </div>
      </ContextMenuTrigger>
      {selectionMode && !inTrash ? (
        <BulkContextMenuContent />
      ) : (
        <ContextMenuContent>
          <WorkspaceMenuItems
            workspace={workspace}
            runningHere={runningHere}
            showStop={canStop(workspace)}
            availableWindows={availableWindows}
            currentWindowId={currentWindowId}
            onRegenerateCustomName={handleRegenerateCustomName}
            onSetCustomName={handleSetCustomName}
            onTogglePinned={() => setPinned(workspace.id, !workspace.pinned)}
            onMarkUnread={() => markUnread(workspace.id)}
            onSnooze={(...snooze) => snoozeWorkspace(workspace.id, ...snooze)}
            onCustomSnooze={() => setCustomSnoozeOpen(true)}
            onColorChange={(color) => {
              updateWorkspace(workspace.id, { color });
              void window.api.updateWorkspace(workspace.id, { color });
            }}
            onMoveToWindow={handleMoveToWindow}
            onMoveToNewWindow={() => void handleMoveToNewWindow()}
            onStop={handleStop}
            onRestart={handleRestart}
            isRestarting={isRestarting}
            onNewFromHere={handleNewFromHere}
            onLinkWorkspaces={() => setLinkDialogOpen(true)}
            onEnterSelectionMode={() => enterSelectionMode(workspace.id)}
            onTrash={(trash) =>
              trash
                ? trashWorkspaceWithUndo(workspace.id)
                : setWorkspaceTrashed(workspace.id, false)
            }
            showManualSpinnerToggle={showAgentSpinner && shownRunning}
            onToggleManualSpinner={() => {
              void window.api.setManualSpinner(workspace.id, !workspace.agentActive);
            }}
            onDelete={handleDeleteClick}
          />
        </ContextMenuContent>
      )}

      {/* Each card hosts a viewer; mount it only once opened so idle cards skip its subscriptions. */}
      <DeferredDialog open={fileViewerOpen}>
        <FileViewerDialog
          workspace={workspace}
          open={fileViewerOpen}
          mode={fileViewerMode}
          onOpenChange={handleCloseFileViewer}
          initialFilePath={storeInitialFilePath}
          initialLineNumber={storeInitialLineNumber ?? undefined}
          initialHistoryFilterPath={fileViewerHistoryFilterPath}
        />
      </DeferredDialog>

      <DeleteWorkspaceDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) setDeleteBranchChecked(false);
        }}
        workspace={workspace}
        displayTitle={displayTitle}
        gitStatus={gitStatus}
        canDeleteBranch={!!canDeleteBranch}
        branchHasRemote={branchHasRemote}
        deleteBranchChecked={deleteBranchChecked}
        onDeleteBranchCheckedChange={setDeleteBranchChecked}
        onCancel={() => setDeleteDialogOpen(false)}
        onConfirm={handleConfirmDelete}
        deleteButtonRef={deleteButtonRef}
      />

      <RenameWorkspaceDialog
        open={customNameDialogOpen}
        onOpenChange={setCustomNameDialogOpen}
        value={customNameInput}
        hasCustomName={!!workspace.customName}
        onChange={setCustomNameInput}
        onSave={handleSaveCustomName}
        onCancel={() => setCustomNameDialogOpen(false)}
        inputRef={customNameInputRef}
      />

      {/* Deferred: it subscribes to every workspace, and each card has one. */}
      <DeferredDialog open={linkDialogOpen}>
        <LinkWorkspacesDialog
          open={linkDialogOpen}
          onOpenChange={setLinkDialogOpen}
          workspace={workspace}
        />
      </DeferredDialog>

      <DeferredDialog open={customSnoozeOpen}>
        <CustomSnoozeDialog
          open={customSnoozeOpen}
          onOpenChange={setCustomSnoozeOpen}
          onSnooze={(until) => {
            snoozeWorkspace(workspace.id, until);
            setCustomSnoozeOpen(false);
          }}
        />
      </DeferredDialog>
    </ContextMenu>
  );
}, workspaceCardPropsAreEqual);

function workspaceCardPropsAreEqual(prev: WorkspaceCardProps, next: WorkspaceCardProps): boolean {
  return (
    prev.workspace === next.workspace &&
    prev.hideDirectoryPath === next.hideDirectoryPath &&
    prev.isDragging === next.isDragging &&
    prev.dropPosition === next.dropPosition &&
    prev.dndEnabled === next.dndEnabled &&
    // tick is intentionally unused in the component body — it exists only to
    // invalidate memo every 60s so relative timestamps ("5 min ago") refresh.
    prev.tick === next.tick &&
    prev.orderedWorkspaceIds === next.orderedWorkspaceIds &&
    prev.projectInfo?.name === next.projectInfo?.name &&
    prev.projectInfo?.color === next.projectInfo?.color &&
    prev.projectInfo?.icon === next.projectInfo?.icon
  );
}

type AttentionAppearance = ReturnType<typeof getWorkspaceAttentionAppearance>;

function getCardClassName({
  isSelected,
  isDragging,
  dropPosition,
  stopped,
  selectionMode,
  isMultiSelected,
  compact,
}: {
  isSelected: boolean;
  isDragging: boolean | undefined;
  dropPosition: 'before' | 'after' | null | undefined;
  stopped: boolean;
  selectionMode: boolean;
  isMultiSelected: boolean;
  compact: boolean;
}): string {
  return cn(
    // The scroll margin keeps a card scrolled into view clear of the list's faded edges.
    'relative group flex cursor-pointer items-center gap-2 rounded-lg px-2 scroll-my-10 workspace-card-hover',
    compact ? 'py-2' : 'py-2.5',
    // The selected card's highlight is its own layer, a light wash with a hairline edge, so it
    // can glide between cards; `isolate` keeps it above the sidebar and under the card's content.
    isSelected ? 'isolate' : 'hover:bg-accent/50',
    isDragging && 'opacity-60 scale-[0.97] ring-2 ring-primary/30',
    dropPosition === 'before' && 'drop-indicator-before',
    dropPosition === 'after' && 'drop-indicator-after',
    stopped && !isSelected && 'text-muted-foreground opacity-60 hover:opacity-100',
    selectionMode && 'pl-8',
    isMultiSelected && 'bg-primary/10 ring-1 ring-primary/40'
  );
}

function SelectionCheckbox({
  selectionMode,
  isMultiSelected,
}: {
  selectionMode: boolean;
  isMultiSelected: boolean;
}) {
  if (!selectionMode) return null;
  return (
    <span className="absolute top-1/2 left-2 inline-flex size-5 -translate-y-1/2 items-center justify-center">
      {isMultiSelected ? (
        <CheckSquare className="size-4 text-foreground" weight="fill" />
      ) : (
        <Square className="size-4 text-muted-foreground" />
      )}
    </span>
  );
}

function ProjectBadge({
  projectInfo,
  workspace,
}: {
  projectInfo: { name: string; color: string; icon?: string };
  workspace: Workspace;
}) {
  return (
    <div
      className="flex items-center gap-1.5 text-xs font-medium"
      style={{ '--project-color': projectInfo.color } as React.CSSProperties}
    >
      {projectInfo.icon ? (
        <ProjectMark project={{ icon: projectInfo.icon }} iconClassName="size-3" />
      ) : !workspace.isWorktree ? (
        <Folder className="light-darken size-3 shrink-0 text-[color:var(--project-color)]" />
      ) : (
        <span className="light-darken size-2 shrink-0 rounded-full bg-[var(--project-color)]" />
      )}
      <span className="truncate text-ui font-semibold text-foreground">{projectInfo.name}</span>
    </div>
  );
}

function agentName(terminal: Terminal | undefined): string {
  return terminal ? terminal.dynamicTitle || terminal.name : 'This workspace';
}

/** The badge as a glyph, when it shrinks next to other agents. */
interface CollapsedBadge {
  attention: WorkspaceAttention;
  appearance: NonNullable<AttentionAppearance>;
  terminal: Terminal | undefined;
  /** Its agent state; an idle reminder or a notice has none. */
  state: AgentState | undefined;
}

interface AgentRow {
  key: string;
  state: AgentState | undefined;
  icon: React.ReactNode;
  title: string;
  name: string;
  detail: string | undefined;
}

/** Each agent on the card, most urgent first; an idle reminder or notice just before working ones. */
function agentRows(badge: CollapsedBadge | null, otherAgents: Agent[]): AgentRow[] {
  const rows: AgentRow[] = otherAgents.map((agent) => ({
    key: agent.terminal?.id ?? 'workspace',
    state: agent.state,
    icon: <AgentStateIcon state={agent.state} />,
    title: AGENT_STATES[agent.state].title,
    name: agentName(agent.terminal),
    detail:
      agent.state === 'working'
        ? undefined
        : attentionDetail(agent.terminal ? agent.terminal.attention : agent.workspace.attention),
  }));
  if (badge) {
    rows.unshift({
      key: 'attention',
      state: badge.state,
      icon: badge.state ? (
        <AgentStateIcon state={badge.state} />
      ) : (
        <AttentionGlyph
          attention={badge.attention}
          aria-hidden="true"
          weight="bold"
          className="size-3 shrink-0"
        />
      ),
      title: badge.state ? AGENT_STATES[badge.state].title : badge.appearance.label,
      name: agentName(badge.terminal),
      detail: attentionDetail(badge.attention),
    });
  }
  const rank = (state: AgentState | undefined) =>
    state ? urgency(state) : urgency('working') - 0.5;
  return rows.sort((a, b) => rank(a.state) - rank(b.state));
}

function AttentionBadge({
  attention,
  appearance,
  label = appearance.label,
  tooltip,
}: {
  attention: WorkspaceAttention;
  appearance: NonNullable<AttentionAppearance>;
  label?: string;
  tooltip: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          data-attention-badge
          tone={appearance.tone}
          className="max-w-32"
          style={appearance.badgeStyle}
        >
          <AttentionGlyph
            attention={attention}
            aria-hidden="true"
            weight="bold"
            className="size-2.5 shrink-0"
          />
          <span className="truncate">{label}</span>
        </Badge>
      </TooltipTrigger>
      {tooltip}
    </Tooltip>
  );
}

/** How many agents are in one state: its glyph, with the count when more than one. */
function StateGlyph({
  state,
  count,
  commands,
}: {
  state: AgentState;
  count: number;
  commands: number;
}) {
  if (state === 'working') return <WorkingAgentsGlyph count={count} commands={commands} />;
  return (
    <span className={cn('flex items-center gap-0.5 text-2xs', AGENT_STATES[state].className)}>
      <AgentStateIcon state={state} className="text-current" />
      {count > 1 && (
        <span aria-hidden="true" className="tabular-nums">
          {count}
        </span>
      )}
      <span className="sr-only">{`${count} ${AGENT_STATES[state].label(count)}`}</span>
    </span>
  );
}

function AgentsTooltipContent({ rows }: { rows: AgentRow[] }) {
  return (
    <TooltipContent side="top">
      <ul aria-label="Agents" className="flex max-w-72 flex-col gap-0.5">
        {rows.map((row) => (
          <li key={row.key} className="flex min-w-0 items-center gap-1.5">
            {row.icon}
            <span className="sr-only">{row.title}:</span>
            <span className="shrink-0">{row.name}</span>
            {row.detail && <span className="truncate text-muted-foreground">{row.detail}</span>}
          </li>
        ))}
      </ul>
    </TooltipContent>
  );
}

function AgentsTooltip({ rows, children }: { rows: AgentRow[]; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-attention-badge className="flex items-center gap-1.5">
          {children}
        </span>
      </TooltipTrigger>
      <AgentsTooltipContent rows={rows} />
    </Tooltip>
  );
}

/**
 * Next to other agents, the badge shrinks to a glyph like theirs, so the title keeps its room.
 * Its own agent still working doesn't shrink it.
 */
function collapseBadge(
  attention: WorkspaceAttention | undefined,
  appearance: AttentionAppearance,
  terminal: Terminal | undefined,
  otherAgents: Agent[]
): CollapsedBadge | null {
  if (!attention || !appearance) return null;
  if (!otherAgents.some((agent) => agent.terminal?.id !== attention.terminalId)) return null;
  return { attention, appearance, terminal, state: agentStateOf(attention, false) ?? undefined };
}

/** How many agents are in each state, most urgent first; a restart shows as working. */
function stateCounts(
  badge: CollapsedBadge | null,
  otherAgents: Agent[],
  restarting: boolean
): { state: AgentState; count: number }[] {
  const shown = [...(badge?.state ? [badge.state] : []), ...otherAgents.map(({ state }) => state)];
  return AGENT_STATES_BY_URGENCY.flatMap((state) => {
    const count = shown.filter((shownState) => shownState === state).length;
    return count > 0 || (state === 'working' && restarting) ? [{ state, count }] : [];
  });
}

/** A shrunk idle reminder or notice, which has no agent state of its own. */
function NoticeGlyph({ badge }: { badge: CollapsedBadge }) {
  return (
    <span
      className="flex items-center text-muted-foreground"
      style={badge.attention.color ? { color: badge.appearance.borderColor } : undefined}
    >
      <AttentionGlyph
        attention={badge.attention}
        aria-hidden="true"
        weight="bold"
        className="size-3 shrink-0"
      />
      <span className="sr-only">{badge.appearance.label}</span>
    </span>
  );
}

function TitleAdornment({
  attention,
  attentionTerminal,
  attentionAppearance,
  unread,
  otherAgents,
  restarting,
  tag,
  tagFromPullRequest,
  tagTooltip,
}: {
  attention: WorkspaceAttention | undefined;
  attentionTerminal: Terminal | undefined;
  attentionAppearance: AttentionAppearance;
  /** The badge is an unread mark, not an agent's: it stays a badge of its own. */
  unread: boolean;
  otherAgents: Agent[];
  restarting: boolean;
  /** Shows in the badge's place when no agent has anything to show. */
  tag: string | undefined;
  tagFromPullRequest: boolean;
  tagTooltip: string | undefined;
}) {
  const collapsed = unread
    ? null
    : collapseBadge(attention, attentionAppearance, attentionTerminal, otherAgents);
  const states = stateCounts(collapsed, otherAgents, restarting);
  const rows = agentRows(collapsed, otherAgents);
  const workingCommands = otherAgents.filter(
    (agent) => agent.state === 'working' && agent.terminal?.commandActive
  ).length;
  // Agents that all share the badge's state keep it, with their count.
  if (collapsed?.state && states.length === 1) {
    const { state, count } = states[0];
    return (
      <span className="ml-auto flex shrink-0 items-center">
        <AttentionBadge
          attention={collapsed.attention}
          appearance={collapsed.appearance}
          label={`${count} ${AGENT_STATES[state].label(count)}`}
          tooltip={<AgentsTooltipContent rows={rows} />}
        />
      </span>
    );
  }
  const badge = !collapsed && attention && attentionAppearance && (
    <AttentionBadge
      attention={attention}
      appearance={attentionAppearance}
      tooltip={<AttentionTooltipContent attention={attention} appearance={attentionAppearance} />}
    />
  );
  if (!badge && states.length === 0) {
    // Half the row at most: a tag runs longer than an agent's badge, and the title comes first.
    return tag ? (
      <WorkspaceTagPill
        tag={tag}
        fromPullRequest={tagFromPullRequest}
        tooltip={tagTooltip}
        className="ml-auto max-w-[50%]"
      />
    ) : null;
  }

  const glyphs = (
    <>
      {collapsed && !collapsed.state && <NoticeGlyph badge={collapsed} />}
      {states.map(({ state, count }) => (
        <StateGlyph key={state} state={state} count={count} commands={workingCommands} />
      ))}
    </>
  );
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5">
      {badge}
      {rows.length > 1 ? <AgentsTooltip rows={rows}>{glyphs}</AgentsTooltip> : glyphs}
    </span>
  );
}

/**
 * Takes back the launch that just made this workspace. It stays while the row is hovered or
 * focused, and hands the offer to a toast while the row is out of sight.
 */
function LaunchUndoLink({
  count,
  cardRef,
}: {
  count: number;
  cardRef: React.RefObject<HTMLDivElement | null>;
}) {
  // A layout effect, so the row counts before the store's first check.
  useLayoutEffect(() => {
    const row = registerLaunchUndoRow();
    const card = cardRef.current;
    if (!card) {
      row.setVisible(false);
      return row.release;
    }
    // Out of sight too while the sidebar is collapsed (display: none) or scrolled past it.
    const observer = new IntersectionObserver(([entry]) => row.setVisible(entry.isIntersecting));
    observer.observe(card);

    let hovered = card.matches(':hover');
    let releaseHold: (() => void) | undefined;
    const update = () => {
      if (hovered || card.contains(document.activeElement)) releaseHold ??= holdLaunchUndo();
      else {
        releaseHold?.();
        releaseHold = undefined;
      }
    };
    const enter = () => {
      hovered = true;
      update();
    };
    const leave = () => {
      hovered = false;
      update();
    };
    // Focus leaving the card lands on the next element only after focusout.
    const updateAfterFocusMoves = () => queueMicrotask(update);
    update();
    card.addEventListener('pointerenter', enter);
    card.addEventListener('pointerleave', leave);
    card.addEventListener('focusin', update);
    card.addEventListener('focusout', updateAfterFocusMoves);
    return () => {
      observer.disconnect();
      card.removeEventListener('pointerenter', enter);
      card.removeEventListener('pointerleave', leave);
      card.removeEventListener('focusin', update);
      card.removeEventListener('focusout', updateAfterFocusMoves);
      releaseHold?.();
      row.release();
    };
  }, [cardRef]);

  return (
    <button
      type="button"
      title={count > 1 ? `Undo the launch of these ${count} workspaces` : 'Undo this launch'}
      data-own-tooltip
      onClick={(event) => {
        event.stopPropagation();
        takeLaunchUndo();
      }}
      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-foreground/[0.06] pr-2 pl-1.5 text-2xs leading-3 font-medium text-foreground/80 shadow-xs transition-colors animate-in fade-in-0 hover:bg-foreground/[0.12] hover:text-foreground"
    >
      <ArrowCounterClockwise className="size-3" weight="bold" aria-hidden />
      Undo
    </button>
  );
}

function provisionFailureLabel(workspace: Workspace): string {
  return workspace.removedFromHost ? 'Missing from host' : 'Setup failed';
}

type SecondaryLineKind = 'attention' | 'path' | 'provisioning' | 'setup-failed' | 'branch';

/** What the card's second line shows, so its details card can leave out a branch it shows. */
function getSecondaryLineKind(
  workspace: Workspace,
  {
    attentionBody,
    hideBranchNameInWorkspaceCards,
    hideDirectoryPath,
  }: {
    attentionBody?: string;
    hideBranchNameInWorkspaceCards: boolean;
    hideDirectoryPath?: boolean;
  }
): SecondaryLineKind | null {
  if (attentionBody) return 'attention';
  if (!workspace.isWorktree) {
    return workspace.workingDirectory && !hideDirectoryPath ? 'path' : null;
  }
  if (workspace.provisioning) return 'provisioning';
  if (workspace.provisionError) return 'setup-failed';
  if (workspace.branchName && !hideBranchNameInWorkspaceCards) return 'branch';
  return null;
}

function SecondaryLine({
  kind,
  workspace,
  attentionBody,
}: {
  kind: SecondaryLineKind | null;
  workspace: Workspace;
  attentionBody?: string;
}) {
  switch (kind) {
    case 'attention':
      return <div className="truncate text-xs text-muted-foreground/80">{attentionBody}</div>;
    case 'path':
      return (
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground/80">
          <FolderOpen className="size-3 shrink-0" />
          {/* rtl truncates from the left; bdi keeps the path itself in LTR order */}
          <span className="truncate font-mono text-ui" dir="rtl">
            <bdi>{workspace.workingDirectory}</bdi>
          </span>
        </div>
      );
    case 'provisioning':
      return (
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground/60">
          <GitBranch className="mr-1 inline size-3" />
          <span className="animate-pulse truncate">
            {workspace.provisionStatus ?? 'Setting up...'}
          </span>
        </div>
      );
    case 'setup-failed':
      return (
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-error">
          <span className="truncate">{provisionFailureLabel(workspace)}</span>
        </div>
      );
    case 'branch':
      return <BranchLine workspace={workspace} />;
    default:
      return null;
  }
}

function BranchLine({ workspace }: { workspace: Workspace }) {
  const isRemote = isSshWorkspace(workspace);
  const Icon = isRemote ? Cloud : workspace.branchedFrom ? GitFork : GitBranch;
  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground/80">
      <span className="truncate font-mono text-ui" title={workspace.branchName}>
        <Icon className="mr-1 inline size-3" />
        {workspace.branchName}
      </span>
    </div>
  );
}

/** How long the workspace's agent has been working, to the minute. */
function WorkingClock({ since }: { since: number }) {
  const elapsed = formatElapsed(useNow() - since);
  return (
    <span
      title={`Working for ${elapsed}`}
      className="ml-auto text-2xs whitespace-nowrap text-muted-foreground/70 tabular-nums"
    >
      {elapsed}
    </span>
  );
}

/** How long a workspace has left in the Trash, as in "6d left" or "5h left". */
function TrashTimeLeft({ trashedAt }: { trashedAt: number }) {
  // Rounded down, so it never promises more time than there is.
  const hoursLeft = Math.max(0, (trashedAt + TRASH_RETENTION_MS - useNow()) / 3_600_000);
  const left =
    hoursLeft >= 24
      ? `${Math.floor(hoursLeft / 24)}d`
      : hoursLeft >= 1
        ? `${Math.floor(hoursLeft)}h`
        : '<1h';
  return (
    <span
      title="Deleted for good when its time in the Trash is up"
      className="ml-auto text-2xs whitespace-nowrap text-muted-foreground/50"
    >
      {left} left
    </span>
  );
}

/**
 * How long the agent has been working, or else when the workspace was last active, or how long
 * it has left in the Trash.
 */
function ActivityTime({
  workspace,
  showWorkingClock,
}: {
  workspace: Workspace;
  showWorkingClock: boolean;
}) {
  if (workspace.status === 'trashed' && workspace.trashedAt) {
    return <TrashTimeLeft trashedAt={workspace.trashedAt} />;
  }
  const startedWorking = showWorkingClock ? workingSince(workspace) : undefined;
  if (startedWorking) return <WorkingClock since={startedWorking} />;
  if (!workspace.lastActivityAt) return null;
  return (
    <span className="ml-auto text-2xs whitespace-nowrap text-muted-foreground/50">
      {formatRelativeTime(workspace.lastActivityAt)}
    </span>
  );
}

function ActivityRow({
  workspace,
  shownRunning,
  showWorkingClock,
  launchUndo,
}: {
  workspace: Workspace;
  shownRunning: boolean;
  showWorkingClock: boolean;
  /**
   * The launch's Undo stands in the time's place, under the agent's spinner, so the spinner
   * keeps its spot while the offer lasts. It fits the time's line, so the row keeps its height.
   */
  launchUndo: React.ReactNode;
}) {
  const linkedCount = workspace.linkedWorkspaceIds?.length ?? 0;
  const showGitStatus =
    !!workspace.workingDirectory &&
    workspace.status === 'active' &&
    !workspace.provisioning &&
    !workspace.provisionError &&
    workspace.isWorktree &&
    !!workspace.branchName;
  if (!showGitStatus && linkedCount === 0 && !workspace.lastActivityAt) return null;
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
      {showGitStatus && workspace.workingDirectory && (
        <div className="shrink-0">
          <GitStatusIndicator
            workspaceId={workspace.id}
            workingDirectory={workspace.workingDirectory}
            projectId={workspace.projectId}
            inactive={!shownRunning}
            muteDiffStats={!shownRunning}
          />
        </div>
      )}
      {linkedCount > 0 && (
        <span
          className="hidden shrink-0 items-center gap-0.5 text-2xs font-medium text-muted-foreground/70 min-[360px]:inline-flex"
          title={`Linked to ${linkedCount} workspace${linkedCount === 1 ? '' : 's'}`}
        >
          <LinkIcon className="h-3 w-3" weight="bold" />
          {linkedCount}
        </span>
      )}
      {launchUndo || <ActivityTime workspace={workspace} showWorkingClock={showWorkingClock} />}
    </div>
  );
}

function WorkspaceInfoPopover({
  label,
  content,
  footer,
  children,
}: {
  label: string;
  content: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const suppressFocusOpenRef = useRef(false);
  // A mouse click focuses the trigger too. Only keyboard focus opens the
  // details right away and keeps them open after the pointer leaves.
  const pointerFocusRef = useRef(false);
  const keyboardFocusRef = useRef(false);
  // Whether the pointer was last over the status badge or its card, or null once it left.
  const pointerOnBadgeRef = useRef<boolean | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (!openTimerRef.current) return;
    clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (!closeTimerRef.current) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const openImmediately = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer, clearOpenTimer]);

  const openAfterDelay = useCallback(() => {
    clearCloseTimer();
    if (open || openTimerRef.current) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      setOpen(true);
    }, 400);
  }, [clearCloseTimer, open]);

  const closeAfterDelay = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      if (keyboardFocusRef.current || contentRef.current?.matches(':focus-within')) {
        return;
      }
      setOpen(false);
    }, 100);
  }, [clearCloseTimer, clearOpenTimer]);

  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimer();
    },
    [clearCloseTimer, clearOpenTimer]
  );

  // The status badge shows its own notification card, and the commit counts and a launch's
  // Undo their own tooltips, so the details wait while the pointer is on one. The notification
  // card is portalled, so it isn't inside this element.
  // Only crossing between them and the rest restarts the hover, so a click or a
  // dismissal isn't undone by the next mouse move.
  const handlePointerOver = (event: React.PointerEvent) => {
    const target = event.target;
    const onBadge =
      !(target instanceof Node) ||
      !event.currentTarget.contains(target) ||
      (target instanceof Element &&
        target.closest('[data-attention-badge], [data-own-tooltip]') !== null);
    if (pointerOnBadgeRef.current === onBadge) return;
    pointerOnBadgeRef.current = onBadge;
    if (onBadge) closeAfterDelay();
    else openAfterDelay();
  };

  const handlePointerLeave = () => {
    pointerOnBadgeRef.current = null;
    closeAfterDelay();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div
        className="min-w-0 flex-1 overflow-hidden"
        onPointerEnter={handlePointerOver}
        onPointerMove={handlePointerOver}
        onPointerLeave={handlePointerLeave}
      >
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={label}
            className="block w-full min-w-0 appearance-none overflow-hidden border-0 bg-transparent p-0 text-left text-inherit"
            onPointerDown={() => {
              pointerFocusRef.current = true;
              clearOpenTimer();
            }}
            onFocus={() => {
              keyboardFocusRef.current = !pointerFocusRef.current;
              pointerFocusRef.current = false;
              if (keyboardFocusRef.current && !suppressFocusOpenRef.current) openImmediately();
            }}
            onBlur={() => {
              keyboardFocusRef.current = false;
              closeAfterDelay();
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              openImmediately();
            }}
            onClick={(event) => {
              // Keep PopoverTrigger from toggling the details on click.
              event.preventDefault();
              pointerFocusRef.current = false;
            }}
          >
            {children}
          </button>
        </PopoverTrigger>
        {footer}
      </div>
      <PopoverContent
        ref={contentRef}
        side="right"
        align="start"
        className="w-[min(20rem,calc(100vw-2rem))] overflow-hidden p-0 select-text"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!suppressFocusOpenRef.current) return;
          triggerRef.current?.focus();
          requestAnimationFrame(() => {
            suppressFocusOpenRef.current = false;
          });
        }}
        onEscapeKeyDown={() => {
          suppressFocusOpenRef.current = true;
        }}
        onPointerEnter={clearCloseTimer}
        onPointerLeave={closeAfterDelay}
        onFocus={openImmediately}
        onBlur={closeAfterDelay}
        onClick={(event) => event.stopPropagation()}
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}

interface AvailableWindow {
  id: string;
  displayNumber: number;
}

function RefreshGitStatusItem({ workspace }: { workspace: Workspace }) {
  return (
    <ContextMenuItem
      onClick={() => {
        void (async () => {
          try {
            await window.api.refreshGitStatus(workspace.id);
            const gitStatusStore = useGitStatusStore.getState();
            const fileListStore = useFileListStore.getState();
            gitStatusStore.invalidateStatus(workspace.id);
            fileListStore.invalidate(workspace.workingDirectory);
            // Mark branch comparisons stale instead of dropping them so the
            // inline file tree keeps its data while its comparison refetches.
            fileListStore.invalidateBranchComparisonDiffs(workspace.workingDirectory, workspace.id);
            const inlineComparison = getDiffComparison(workspace.id, 'inline');

            const [status] = await Promise.all([
              gitStatusStore.fetchStatus(
                workspace.id,
                workspace.workingDirectory,
                workspace.projectId
              ),
              fileListStore.fetchDiff(workspace.workingDirectory, undefined, false, workspace.id),
              inlineComparison.comparisonBranch
                ? fileListStore.fetchDiff(
                    workspace.workingDirectory,
                    inlineComparison.comparisonBranch,
                    inlineComparison.useMergeBase,
                    workspace.id
                  )
                : undefined,
            ]);
            if (!status) throw new Error('Git branch status refresh failed');
            if (status.currentBranch && status.currentBranch !== workspace.branchName) {
              useWorkspacesStore
                .getState()
                .updateWorkspace(workspace.id, { branchName: status.currentBranch });
              await window.api.updateWorkspace(workspace.id, {
                branchName: status.currentBranch,
              });
            }
          } catch (err: unknown) {
            console.error('Failed to refresh git status', err);
            useToastStore.getState().addToast('Failed to refresh git status', 'error');
          }
        })();
      }}
    >
      <ArrowClockwise />
      Refresh Git Status
    </ContextMenuItem>
  );
}

function TrashMenuItem({
  workspace,
  onTrash,
}: {
  workspace: Workspace;
  onTrash: (trash: boolean) => void;
}) {
  if (workspace.status === 'trashed') {
    return (
      <ContextMenuItem onClick={() => onTrash(false)}>
        <ArrowCounterClockwise />
        Restore Workspace
      </ContextMenuItem>
    );
  }
  return (
    <ContextMenuItem onClick={() => onTrash(true)}>
      <Trash />
      Move to Trash
    </ContextMenuItem>
  );
}

function WorkspaceMenuItems({
  workspace,
  runningHere,
  showStop,
  availableWindows,
  currentWindowId,
  onRegenerateCustomName,
  onSetCustomName,
  onTogglePinned,
  onMarkUnread,
  onSnooze,
  onCustomSnooze,
  onColorChange,
  onMoveToWindow,
  onMoveToNewWindow,
  onStop,
  onRestart,
  isRestarting,
  onNewFromHere,
  onLinkWorkspaces,
  onEnterSelectionMode,
  onTrash,
  showManualSpinnerToggle,
  onToggleManualSpinner,
  onDelete,
}: {
  workspace: Workspace;
  runningHere: boolean;
  showStop: boolean;
  availableWindows: AvailableWindow[];
  currentWindowId: string | null;
  onRegenerateCustomName: () => void;
  onSetCustomName: () => void;
  onTogglePinned: () => void;
  onMarkUnread: () => void;
  /** Snoozes until a time; undefined wakes the workspace now. */
  onSnooze: (until: number | undefined, wakesOnNotification?: boolean) => void;
  onCustomSnooze: () => void;
  onColorChange: (color: string | undefined) => void;
  onMoveToWindow: (id: string) => void;
  onMoveToNewWindow: () => void;
  onStop: (e: React.MouseEvent) => void;
  onRestart: (e: React.MouseEvent) => void;
  isRestarting: boolean;
  onNewFromHere: () => void;
  onLinkWorkspaces: () => void;
  onEnterSelectionMode: () => void;
  onTrash: (trash: boolean) => void;
  showManualSpinnerToggle: boolean;
  onToggleManualSpinner: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const showRefreshGit =
    !!workspace.workingDirectory && workspace.isWorktree && !!workspace.branchName;
  const showNewFromHere =
    workspace.isWorktree &&
    !!workspace.branchName &&
    !!workspace.projectId &&
    !workspace.provisioning;
  const spinnerActive = !!workspace.agentActive;
  const ciRunning = useCiRunning(
    workspace,
    !isWorkspaceSnoozed(workspace) && workspace.status !== 'trashed'
  );
  const canRegenerateName = (workspace.promptSubmits?.length ?? 0) > 0;

  // Opening a workspace in the Trash restores it; the rest waits until then.
  if (workspace.status === 'trashed') {
    return (
      <>
        <TrashMenuItem workspace={workspace} onTrash={onTrash} />
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onDelete} variant="destructive">
          <XCircle />
          Delete Permanently...
        </ContextMenuItem>
      </>
    );
  }

  return (
    <>
      {workspace.customName ? (
        <div className="flex items-center gap-1">
          {canRegenerateName && (
            <ContextMenuItem onClick={onRegenerateCustomName} className="min-w-0 flex-1">
              <ArrowsClockwise />
              Regenerate Title
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onClick={onSetCustomName}
            title="Edit static title"
            className={
              canRegenerateName
                ? 'justify-center px-2 text-xs text-muted-foreground lowercase focus:text-accent-foreground'
                : 'min-w-0 flex-1'
            }
          >
            {canRegenerateName ? (
              'edit'
            ) : (
              <>
                <PencilSimple />
                Edit Static Title...
              </>
            )}
          </ContextMenuItem>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          {canRegenerateName && (
            <ContextMenuItem onClick={onRegenerateCustomName} className="min-w-0 flex-1">
              <ArrowsClockwise />
              Generate Title
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onClick={onSetCustomName}
            title="Set static title manually"
            className={
              canRegenerateName
                ? 'justify-center px-2 text-xs text-muted-foreground lowercase focus:text-accent-foreground'
                : 'min-w-0 flex-1'
            }
          >
            {canRegenerateName ? (
              'set'
            ) : (
              <>
                <PencilSimple />
                Set Static Title...
              </>
            )}
          </ContextMenuItem>
        </div>
      )}
      <ContextMenuItem onClick={onTogglePinned}>
        {workspace.pinned ? <PushPinSlash /> : <PushPin />}
        {workspace.pinned ? 'Unpin' : 'Pin'}
      </ContextMenuItem>
      {!isWorkspaceSnoozed(workspace) ? (
        <SnoozeSubmenu
          untilNotified={waitsForNotification(workspace)}
          untilCiFinishes={ciRunning}
          onSnooze={onSnooze}
          onCustom={onCustomSnooze}
        />
      ) : (
        <ContextMenuItem onClick={() => onSnooze(undefined)}>
          <Alarm />
          Wake Now
        </ContextMenuItem>
      )}
      {!workspace.unread && (
        <ContextMenuItem onClick={onMarkUnread}>
          <EnvelopeSimple />
          Mark as Unread
        </ContextMenuItem>
      )}
      <TagSubmenu
        workspaceIds={[workspace.id]}
        currentTag={workspace.tag}
        anyTagged={!!workspace.tag}
      />
      {/* A project's workspaces show its color. */}
      {!workspace.isWorktree && !workspace.projectId && (
        <ColorPickerSubmenu currentColor={workspace.color} onColorChange={onColorChange} />
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onLinkWorkspaces}>
        <LinkIcon />
        {(workspace.linkedWorkspaceIds?.length ?? 0) > 0
          ? `Linked Workspaces (${workspace.linkedWorkspaceIds!.length})...`
          : 'Link Workspaces...'}
      </ContextMenuItem>
      {showNewFromHere && (
        <ContextMenuItem onClick={onNewFromHere}>
          <GitFork />
          New Workspace from Here
        </ContextMenuItem>
      )}
      <CopyWorkspaceSubmenu workspace={workspace} />
      {showStop && (
        <>
          <ContextMenuSeparator />
          {/* Restarting would start its agents here, even ones running on another device. */}
          {runningHere && (
            <ContextMenuItem onClick={onRestart} disabled={isRestarting}>
              {isRestarting ? <Spinner size="md" /> : <ArrowsClockwise />}
              {isRestarting ? 'Restarting Workspace...' : 'Restart Workspace'}
            </ContextMenuItem>
          )}
          {/* A spinner can outlive its agent's turn, so stopping it is one click away. */}
          {showManualSpinnerToggle && spinnerActive && (
            <ContextMenuItem onClick={onToggleManualSpinner}>
              <CircleNotch />
              Stop Spinner
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={onStop}>
            <Square />
            Stop Workspace
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <TrashMenuItem workspace={workspace} onTrash={onTrash} />
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <DotsThree weight="bold" />
          More
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onClick={onEnterSelectionMode}>
            <CheckSquare />
            Select
          </ContextMenuItem>
          <MoveToWindowMenuItems
            otherWindows={availableWindows.filter((w) => w.id !== currentWindowId)}
            onMoveToWindow={onMoveToWindow}
            onMoveToNewWindow={onMoveToNewWindow}
          />
          {showRefreshGit && <RefreshGitStatusItem workspace={workspace} />}
          {showManualSpinnerToggle && !spinnerActive && (
            <ContextMenuItem onClick={onToggleManualSpinner}>
              <CircleNotch />
              Start Spinner
            </ContextMenuItem>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onDelete} variant="destructive">
        <XCircle />
        Delete Permanently...
      </ContextMenuItem>
    </>
  );
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getDeleteWorkspaceWarnings(uncommittedFileCount: number, unpushedCommitCount: number) {
  const warnings: string[] = [];
  if (uncommittedFileCount > 0) {
    warnings.push(
      `Uncommitted changes in ${pluralize(uncommittedFileCount, 'file', 'files')} will be lost.`
    );
  }
  if (unpushedCommitCount > 0) {
    warnings.push(
      `${pluralize(unpushedCommitCount, 'unpushed commit', 'unpushed commits')} will be lost with the branch.`
    );
  }
  return warnings;
}

function getDeleteWorkspaceDescription(workspace: Workspace, displayTitle: string): string {
  if (!workspace.isWorktree) {
    return `Delete workspace "${displayTitle}"? The directory will NOT be deleted.`;
  }
  const remoteWorkspace = isSshWorkspace(workspace);
  const branchSuffix = workspace.branchName ? ` on branch "${workspace.branchName}"` : '';
  const worktreeLabel = remoteWorkspace ? 'remote git worktree and its local copy' : 'git worktree';
  return `Delete workspace "${displayTitle}"${branchSuffix}? This will also remove the ${worktreeLabel}.`;
}

function DeleteWorkspaceDialog({
  open,
  onOpenChange,
  workspace,
  displayTitle,
  gitStatus,
  canDeleteBranch,
  branchHasRemote,
  deleteBranchChecked,
  onDeleteBranchCheckedChange,
  onCancel,
  onConfirm,
  deleteButtonRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace;
  displayTitle: string;
  gitStatus: GitBranchQuickStatus | undefined;
  canDeleteBranch: boolean;
  branchHasRemote: boolean;
  deleteBranchChecked: boolean;
  onDeleteBranchCheckedChange: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
  deleteButtonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const remoteWorkspace = isSshWorkspace(workspace);
  // Same cached diff the git status pills show; only read while the dialog is open.
  const uncommittedFileCount = useFileListStore((state) =>
    open && workspace.isWorktree
      ? (state.getDiff(
          workspace.workingDirectory,
          undefined,
          false,
          remoteWorkspace ? workspace.id : undefined
        )?.data.files.length ?? 0)
      : 0
  );
  const unpushedCommitCount =
    canDeleteBranch && deleteBranchChecked ? countUnpushedBranchCommits(gitStatus) : 0;
  const warnings = getDeleteWorkspaceWarnings(uncommittedFileCount, unpushedCommitCount);
  const description = getDeleteWorkspaceDescription(workspace, displayTitle);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          // Delete is focused for fast cleanup; any warning stays visible above it.
          deleteButtonRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Delete Workspace Permanently</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {warnings.length > 0 && (
          <Callout tone="warning">
            <div className="space-y-0.5">
              {warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          </Callout>
        )}
        {canDeleteBranch && (
          <div className="flex items-center justify-between py-2">
            <div className="flex flex-col gap-0.5">
              <label htmlFor="delete-branch" className="text-sm">
                {remoteWorkspace
                  ? `Also delete branch "${workspace.branchName}" on remote host`
                  : `Also delete local branch "${workspace.branchName}"`}
              </label>
              {branchHasRemote && (
                <span className="text-xs text-muted-foreground">
                  The upstream branch will not be deleted
                </span>
              )}
            </div>
            <Switch
              id="delete-branch"
              checked={deleteBranchChecked}
              onCheckedChange={onDeleteBranchCheckedChange}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button ref={deleteButtonRef} variant="destructive" onClick={onConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameWorkspaceDialog({
  open,
  onOpenChange,
  value,
  hasCustomName,
  onChange,
  onSave,
  onCancel,
  inputRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  hasCustomName: boolean;
  onChange: (value: string) => void;
  onSave: () => Promise<void> | void;
  onCancel: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set Static Title</DialogTitle>
          <DialogDescription>
            Enter a static title for this workspace. It will be displayed in the sidebar instead of
            the terminal title.
            {hasCustomName && ' Leave it empty to reset the title and its prompt history.'}
          </DialogDescription>
        </DialogHeader>
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onSave();
          }}
          placeholder="Custom workspace name"
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => void onSave()}>
            {hasCustomName && !value.trim() ? 'Reset' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
