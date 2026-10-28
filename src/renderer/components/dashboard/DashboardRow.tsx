import {
  ArrowCounterClockwise,
  ArrowElbowDownRight,
  ArrowsClockwise,
  EnvelopeSimple,
  PushPin,
  PushPinSlash,
  CheckSquare,
  Cloud,
  Folder,
  GearSix,
  GitBranch,
  PencilSimple,
  Square,
  Trash,
  XCircle,
} from '@phosphor-icons/react';
import React, { useEffect, useRef, useState } from 'react';

import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TruncatedText } from '@/components/ui/truncated-text';
import {
  WorkingAgentsGlyph,
  workingAgentCount,
  workingCommandCount,
} from '@/components/workspaces/agent-state';
import {
  AttentionGlyph,
  AttentionTooltipContent,
} from '@/components/workspaces/AttentionTooltipContent';
import { BulkContextMenuContent } from '@/components/workspaces/BulkContextMenu';
import { ColorPickerSubmenu } from '@/components/workspaces/ColorPickerSubmenu';
import { CopyWorkspaceSubmenu } from '@/components/workspaces/CopyWorkspaceSubmenu';
import { GitStatusIndicator } from '@/components/workspaces/GitStatusIndicator';
import {
  getWorkspaceDisplayTitle,
  getWorkspaceDynamicTitle,
  stripAgentTitleGlyphs,
  WorkspaceInfoCardContent,
} from '@/components/workspaces/WorkspaceInfoCard';
import { TagSubmenu, WorkspaceTagPill } from '@/components/workspaces/WorkspaceTagMenu';
import { formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { getUnreadBadge, getWorkspaceAttentionAppearance } from '@/lib/workspace-attention';
import { getWorkspaceLastTouchedAt } from '@/lib/workspace-state-groups';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useConfigStore } from '@/stores/config.store';
import { useGitStatusStore } from '@/stores/git-status.store';
import { useProjectsStore } from '@/stores/projects.store';
import {
  canDeleteWorkspaceBranch,
  canStop,
  isSshWorkspace,
  showsRunning,
  type SshHost,
  type Workspace,
} from '@/types';

function shouldShowDescriptionContext(
  workspace: Workspace,
  displayTitle: string,
  searchQuery: string | null | undefined
): boolean {
  const trimmed = searchQuery?.trim();
  if (!trimmed || !workspace.customDescription) return false;
  const needle = trimmed.toLowerCase();
  if (displayTitle.toLowerCase().includes(needle)) return false;
  const branchMatches =
    workspace.isWorktree &&
    workspace.branchName &&
    workspace.branchName.toLowerCase().includes(needle);
  return !branchMatches;
}

const ROW_SELECTOR = '[data-dashboard-row]';

// Agent messages and prompts can run long, so their tooltip scrolls and keeps line breaks.
function RowStatusText({ children, className }: { children: string; className?: string }) {
  return (
    <TruncatedText
      className={className}
      contentClassName="max-h-72 max-w-md overflow-y-auto whitespace-pre-wrap"
    >
      {children}
    </TruncatedText>
  );
}

function focusAdjacentDashboardRow(currentTarget: HTMLElement, step: 1 | -1) {
  const rows = Array.from(document.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  const currentIndex = rows.indexOf(currentTarget);
  if (currentIndex === -1) return;
  rows[currentIndex + step]?.focus();
}

// An unread mark shows when the workspace has nothing else to show.
function rowAttention(workspace: Workspace) {
  const unreadBadge = workspace.attention ? undefined : getUnreadBadge(workspace);
  const attention = workspace.attention ?? unreadBadge?.attention;
  return {
    attention,
    attentionAppearance: unreadBadge?.appearance ?? getWorkspaceAttentionAppearance(attention),
  };
}

/**
 * What the agent asked or reported, what it is working on, or else what you last asked it.
 */
function RowStatus({
  workspace,
  displayTitle,
  searchQuery,
}: {
  workspace: Workspace;
  displayTitle: string;
  searchQuery: string | null | undefined;
}) {
  const showAgentSpinner = useConfigStore((state) => state.config?.showAgentSpinner) !== false;
  const { attention, attentionAppearance } = rowAttention(workspace);
  const workingCount = workingAgentCount(workspace);
  const workingCommands = workingCommandCount(workspace);

  if (attention && attentionAppearance) {
    const detail = attentionAppearance.detail;
    return (
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              tone={attentionAppearance.tone}
              className="max-w-40 shrink-0"
              style={attentionAppearance.badgeStyle}
            >
              <AttentionGlyph
                attention={attention}
                aria-hidden="true"
                weight="bold"
                className="size-2.5 shrink-0"
              />
              <span className="truncate">{attentionAppearance.label}</span>
            </Badge>
          </TooltipTrigger>
          <AttentionTooltipContent attention={attention} appearance={attentionAppearance} />
        </Tooltip>
        {/* Another agent can still work, or this one after a notice mid-turn. */}
        {showAgentSpinner && workingCount > 0 && (
          <WorkingAgentsGlyph count={workingCount} commands={workingCommands} />
        )}
        {detail && detail !== attentionAppearance.label && (
          <RowStatusText className="text-foreground/90">{detail}</RowStatusText>
        )}
      </div>
    );
  }

  if (workingCount > 0) {
    const dynamicTitle = getWorkspaceDynamicTitle(workspace);
    // The row draws its own spinner, so drop the agent's spinner glyph from the title.
    const doing =
      dynamicTitle && dynamicTitle !== displayTitle
        ? stripAgentTitleGlyphs(dynamicTitle)
        : 'Working…';
    return (
      <div className="flex min-w-0 items-center gap-2 text-xs text-foreground/90">
        {showAgentSpinner && <WorkingAgentsGlyph count={workingCount} decorative />}
        <RowStatusText>{doing}</RowStatusText>
      </div>
    );
  }

  const idleStatus = (
    <IdleRowStatus workspace={workspace} displayTitle={displayTitle} searchQuery={searchQuery} />
  );
  if (!workspace.tag) return idleStatus;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <WorkspaceTagPill
        tag={workspace.tag}
        fromPullRequest={workspace.tagSource === 'pull-request'}
        tooltip={workspace.tagTooltip}
        className="max-w-40"
      />
      {idleStatus}
    </div>
  );
}

/** What the workspace is about, or else what you last asked it. */
function IdleRowStatus({
  workspace,
  displayTitle,
  searchQuery,
}: {
  workspace: Workspace;
  displayTitle: string;
  searchQuery: string | null | undefined;
}) {
  if (
    workspace.customDescription &&
    shouldShowDescriptionContext(workspace, displayTitle, searchQuery)
  ) {
    return (
      <RowStatusText className="text-xs text-muted-foreground">
        {workspace.customDescription}
      </RowStatusText>
    );
  }

  const lastPrompt = workspace.promptSubmits?.at(-1)?.prompt;
  if (!lastPrompt) return <span />;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <ArrowElbowDownRight aria-label="Your last prompt" className="size-3 shrink-0 opacity-60" />
      <RowStatusText>{lastPrompt}</RowStatusText>
    </div>
  );
}

interface DashboardRowProps {
  workspace: Workspace;
  projectInfo: { name: string; color: string } | null;
  sshHost?: SshHost | null;
  searchQuery?: string | null;
  selectionMode?: boolean;
  isMultiSelected?: boolean;
  onOpen: () => void;
  onToggleTrashed: () => void;
  onStopWorkspace: () => void;
  onSaveCustomName: (customName: string | null) => Promise<void> | void;
  onRegenerateCustomName: () => Promise<void> | void;
  onDeleteWorkspace: (force: boolean, deleteBranch?: boolean) => Promise<void> | void;
  onOpenProjectSettings: () => void;
  onTogglePinned: () => void;
  onMarkUnread: () => void;
  onColorChange?: (color: string) => void;
  onEnterSelectionMode?: () => void;
  onToggleSelection?: () => void;
  onShiftSelect?: () => void;
}

interface DashboardRowMenuContentProps {
  workspace: Workspace;
  showStop: boolean;
  onRegenerateCustomName: () => Promise<void> | void;
  onTogglePinned: () => void;
  onMarkUnread: () => void;
  onColorChange?: (color: string) => void;
  onOpenProjectSettings: () => void;
  onStopWorkspace: () => void;
  onEnterSelectionMode?: () => void;
  onToggleTrashed: () => void;
  onOpenCustomNameDialog: () => void;
  onDelete: () => void;
}

function DashboardRowMenuContent({
  workspace,
  showStop,
  onRegenerateCustomName,
  onTogglePinned,
  onMarkUnread,
  onColorChange,
  onOpenProjectSettings,
  onStopWorkspace,
  onEnterSelectionMode,
  onToggleTrashed,
  onOpenCustomNameDialog,
  onDelete,
}: DashboardRowMenuContentProps) {
  const canRegenerateName = (workspace.promptSubmits?.length ?? 0) > 0;

  return (
    <ContextMenuContent>
      {workspace.customName ? (
        <div className="flex items-center gap-1">
          {canRegenerateName && (
            <ContextMenuItem
              onClick={() => void onRegenerateCustomName()}
              className="min-w-0 flex-1"
            >
              <ArrowsClockwise />
              Regenerate Title
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onClick={onOpenCustomNameDialog}
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
            <ContextMenuItem
              onClick={() => void onRegenerateCustomName()}
              className="min-w-0 flex-1"
            >
              <ArrowsClockwise />
              Generate Title
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onClick={onOpenCustomNameDialog}
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
      {!workspace.isWorktree && !workspace.projectId && onColorChange && (
        <ColorPickerSubmenu currentColor={workspace.color} onColorChange={onColorChange} />
      )}
      <ContextMenuSeparator />
      {workspace.projectId && (
        <ContextMenuItem onClick={onOpenProjectSettings}>
          <GearSix />
          Project Settings
        </ContextMenuItem>
      )}
      <CopyWorkspaceSubmenu workspace={workspace} />
      <ContextMenuSeparator />
      {showStop && (
        <ContextMenuItem onClick={onStopWorkspace}>
          <Square />
          Stop Workspace
        </ContextMenuItem>
      )}
      {onEnterSelectionMode && (
        <ContextMenuItem onClick={onEnterSelectionMode}>
          <CheckSquare />
          Select
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onToggleTrashed}>
        {workspace.status === 'trashed' ? <ArrowCounterClockwise /> : <Trash />}
        {workspace.status === 'trashed' ? 'Restore Workspace' : 'Move to Trash'}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onDelete} variant="destructive">
        <XCircle />
        Delete Permanently...
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

export function DashboardRow({
  workspace,
  projectInfo,
  sshHost,
  onOpen,
  onToggleTrashed,
  onStopWorkspace,
  searchQuery,
  selectionMode,
  isMultiSelected,
  onSaveCustomName,
  onRegenerateCustomName,
  onDeleteWorkspace,
  onOpenProjectSettings,
  onTogglePinned,
  onMarkUnread,
  onColorChange,
  onEnterSelectionMode,
  onToggleSelection,
  onShiftSelect,
}: DashboardRowProps) {
  // Shown running also while its tmux session runs on its SSH host.
  const isRunning = showsRunning(workspace);
  const showStop = canStop(workspace);
  const isPinned = !!workspace.pinned;
  const preset = useAgentPresetsStore(
    (state) => state.presets.find((p) => p.id === workspace.presetId) ?? null
  );
  const fetchStatusIfStale = useGitStatusStore((state) => state.fetchStatusIfStale);
  const [customNameDialogOpen, setCustomNameDialogOpen] = useState(false);
  const [customNameInput, setCustomNameInput] = useState('');
  const customNameInputRef = useRef<HTMLInputElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteBranchChecked, setDeleteBranchChecked] = useState(false);

  const projectBaseBranch = useProjectsStore((state) =>
    workspace.projectId
      ? state.projects.find((project) => project.id === workspace.projectId)?.baseBranch
      : undefined
  );
  const canDeleteBranch = canDeleteWorkspaceBranch(workspace, projectBaseBranch);

  const gitStatus = useGitStatusStore((state) => state.statusMap.get(workspace.id)?.status);
  const branchHasRemote = gitStatus?.hasRemote ?? false;

  useEffect(() => {
    if (workspace.workingDirectory) {
      void fetchStatusIfStale(
        workspace.id,
        workspace.workingDirectory,
        workspace.projectId,
        300_000
      );
    }
  }, [workspace.id, workspace.workingDirectory, workspace.projectId, fetchStatusIfStale]);

  const displayTitle = getWorkspaceDisplayTitle(workspace);

  const lastActivity = getWorkspaceLastTouchedAt(workspace);

  const branchName = workspace.isWorktree && workspace.branchName ? workspace.branchName : null;
  const isRemoteWorkspace = isSshWorkspace(workspace);
  const showDirectoryIcon = !workspace.isWorktree;
  const handleOpenCustomNameDialog = () => {
    setCustomNameInput(displayTitle);
    setCustomNameDialogOpen(true);
    setTimeout(() => customNameInputRef.current?.select(), 0);
  };

  const handleSaveCustomName = async () => {
    const trimmed = customNameInput.trim();
    if (trimmed || workspace.customName) await onSaveCustomName(trimmed || null);
    setCustomNameDialogOpen(false);
  };

  const handleDeleteClick = () => {
    if (canDeleteBranch) {
      setDeleteBranchChecked(true);
    }
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    const shouldDeleteBranch = deleteBranchChecked && canDeleteBranch;
    setDeleteDialogOpen(false);
    setDeleteBranchChecked(false);
    await onDeleteWorkspace(true, shouldDeleteBranch || undefined);
  };

  const handleCardClick = (e: React.MouseEvent) => {
    if (e.shiftKey && !selectionMode && onEnterSelectionMode) {
      onEnterSelectionMode();
      return;
    }
    if (selectionMode) {
      if (e.shiftKey && onShiftSelect) {
        onShiftSelect();
      } else if (onToggleSelection) {
        onToggleSelection();
      }
      return;
    }
    onOpen();
  };

  const handleContextMenu = () => {
    if (selectionMode && !isMultiSelected && onToggleSelection) {
      onToggleSelection();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Keys pressed on a control inside the row belong to that control.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (selectionMode && onToggleSelection) {
        onToggleSelection();
      } else {
        onOpen();
      }
      return;
    }
    // Leave Cmd/Ctrl/Alt chords (e.g. select-all, save) to their usual handlers.
    const hasModifier = e.metaKey || e.ctrlKey || e.altKey;
    if (e.key === 't' && !hasModifier) {
      e.preventDefault();
      onToggleTrashed();
      return;
    }
    if (e.key === 's' && !hasModifier && showStop) {
      e.preventDefault();
      onStopWorkspace();
      return;
    }
    if (e.key === 'ArrowDown' || (e.key === 'j' && !hasModifier)) {
      e.preventDefault();
      focusAdjacentDashboardRow(e.currentTarget, 1);
    } else if (e.key === 'ArrowUp' || (e.key === 'k' && !hasModifier)) {
      e.preventDefault();
      focusAdjacentDashboardRow(e.currentTarget, -1);
    }
  };

  const rowBody = (
    <div
      role="button"
      tabIndex={0}
      data-dashboard-row
      onClick={handleCardClick}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      className={cn(
        'group grid cursor-default grid-cols-[minmax(0,17rem)_minmax(0,1fr)_auto] items-center gap-4 rounded-md px-3 py-2 text-left transition-colors',
        // A foreground wash: light themes' accents sit too close to Overview's --chrome to show.
        'hover:bg-foreground/5 focus-visible:bg-foreground/6 focus-visible:outline-hidden',
        isMultiSelected && 'bg-foreground/8 ring-1 ring-border',
        // Rows in the Trash recede until hovered or focused.
        { 'opacity-60 hover:opacity-100 focus-visible:opacity-100': workspace.status !== 'active' }
      )}
    >
      <Tooltip delayDuration={400}>
        <TooltipTrigger asChild>
          <div className="flex min-w-0 items-center gap-2.5">
            {selectionMode && (
              <span className="inline-flex size-4 shrink-0 items-center justify-center">
                {isMultiSelected ? (
                  <CheckSquare className="size-4 text-foreground" weight="fill" />
                ) : (
                  <Square className="size-4 text-muted-foreground" />
                )}
              </span>
            )}
            {/* The project color tells rows apart; it fades while nothing runs. */}
            <span
              data-running-indicator
              aria-hidden="true"
              className={cn('h-8 w-[3px] shrink-0 rounded-full', !isRunning && 'opacity-40')}
              style={{ backgroundColor: projectInfo?.color ?? 'oklch(var(--border))' }}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{displayTitle}</span>
                {isPinned && (
                  <PushPin
                    aria-label="Pinned"
                    weight="fill"
                    className="size-3 shrink-0 text-muted-foreground"
                  />
                )}
              </div>
              <div className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
                {projectInfo && (
                  <>
                    {showDirectoryIcon && <Folder className="size-3 shrink-0" />}
                    <span className="shrink-0 truncate">{projectInfo.name}</span>
                  </>
                )}
                {branchName && (
                  <>
                    {projectInfo && <span className="opacity-50">/</span>}
                    {isRemoteWorkspace ? (
                      <Cloud className="size-3 shrink-0" />
                    ) : (
                      <GitBranch className="size-3 shrink-0" />
                    )}
                    <span className="truncate font-mono" title={branchName}>
                      {branchName}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="start"
          className="w-[min(20rem,calc(100vw-2rem))] rounded-[calc(var(--radius)+2px)] p-0 shadow-xl select-text"
        >
          <WorkspaceInfoCardContent
            workspace={workspace}
            sshHost={sshHost ?? null}
            showBranch={false}
          />
        </TooltipContent>
      </Tooltip>

      <RowStatus workspace={workspace} displayTitle={displayTitle} searchQuery={searchQuery} />

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {workspace.workingDirectory && branchName && (
          <GitStatusIndicator
            workspaceId={workspace.id}
            workingDirectory={workspace.workingDirectory}
            projectId={workspace.projectId}
            inactive={!isRunning}
          />
        )}
        {preset && <AgentPresetIcon preset={preset} className="size-3.5 shrink-0" />}
        <span className="w-10 text-right text-2xs tabular-nums group-focus-within:hidden group-hover:hidden">
          {formatRelativeTime(lastActivity)}
        </span>
        <span className="hidden w-10 items-center justify-end gap-0.5 group-focus-within:flex group-hover:flex">
          {showStop && (
            <IconButton
              label="Stop workspace"
              size="xs"
              onClick={(e) => {
                e.stopPropagation();
                onStopWorkspace();
              }}
            >
              <Square className="size-3.5" />
            </IconButton>
          )}
          <IconButton
            label={workspace.status === 'trashed' ? 'Restore workspace' : 'Move to Trash'}
            size="xs"
            onClick={(e) => {
              e.stopPropagation();
              onToggleTrashed();
            }}
          >
            {workspace.status === 'trashed' ? (
              <ArrowCounterClockwise className="size-3.5" />
            ) : (
              <Trash className="size-3.5" />
            )}
          </IconButton>
        </span>
      </div>
    </div>
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{rowBody}</ContextMenuTrigger>
        {selectionMode ? (
          <BulkContextMenuContent />
        ) : (
          <DashboardRowMenuContent
            workspace={workspace}
            showStop={showStop}
            onRegenerateCustomName={onRegenerateCustomName}
            onTogglePinned={onTogglePinned}
            onMarkUnread={onMarkUnread}
            onColorChange={onColorChange}
            onOpenProjectSettings={onOpenProjectSettings}
            onStopWorkspace={onStopWorkspace}
            onEnterSelectionMode={onEnterSelectionMode}
            onToggleTrashed={onToggleTrashed}
            onOpenCustomNameDialog={handleOpenCustomNameDialog}
            onDelete={handleDeleteClick}
          />
        )}
      </ContextMenu>
      <Dialog open={customNameDialogOpen} onOpenChange={setCustomNameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set Static Title</DialogTitle>
            <DialogDescription>
              Set a static title for this workspace. It will replace the dynamic terminal title.
              {workspace.customName && ' Leave it empty to reset the title and its prompt history.'}
            </DialogDescription>
          </DialogHeader>
          <Input
            ref={customNameInputRef}
            value={customNameInput}
            onChange={(event) => setCustomNameInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleSaveCustomName();
            }}
            placeholder="Custom workspace name"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCustomNameDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleSaveCustomName()}>
              {workspace.customName && !customNameInput.trim() ? 'Reset' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) setDeleteBranchChecked(false);
        }}
      >
        <DialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            deleteButtonRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete Workspace Permanently</DialogTitle>
            <DialogDescription>
              {workspace.isWorktree
                ? `Delete workspace "${workspace.name}"? This will also remove the ${isSshWorkspace(workspace) ? 'remote ' : ''}git worktree${isSshWorkspace(workspace) ? ' and its local copy' : ''}.`
                : `Delete workspace "${workspace.name}"? The directory will NOT be deleted.`}
            </DialogDescription>
          </DialogHeader>
          {canDeleteBranch && (
            <div className="flex items-center justify-between py-2">
              <div className="flex flex-col gap-0.5">
                <label htmlFor="dashboard-delete-branch" className="text-sm">
                  {isSshWorkspace(workspace)
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
                id="dashboard-delete-branch"
                checked={deleteBranchChecked}
                onCheckedChange={setDeleteBranchChecked}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              ref={deleteButtonRef}
              variant="destructive"
              onClick={() => void handleConfirmDelete()}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
