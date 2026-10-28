import {
  Alarm,
  CaretRight,
  CircleNotch,
  EyeSlash,
  Folder,
  Palette,
  Plus,
  PushPin,
  Question,
  RocketLaunch,
  Square,
  Tag,
  Trash,
  Warning,
  type Icon,
} from '@phosphor-icons/react';
import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';

import { ProjectMark } from '@/components/projects/ProjectMark';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { getProjectColor } from '@/lib/project-colors';
import { getProjectMoveIndex } from '@/lib/project-order';
import { cn } from '@/lib/utils';
import { summarizeWorkspaceAttention } from '@/lib/workspace-attention';
import { isWorkspaceHostVisible } from '@/lib/workspace-host';
import { useConfigStore } from '@/stores/config.store';
import { openNewWorkspaceDialog } from '@/stores/dialogs.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { TRASH_RETENTION_DAYS, type Project, type Workspace } from '@/types';

import { ActivitySpinner } from './activity-spinners';
import { BulkDeleteDialog } from './BulkDeleteDialog';
import { DirectoryGroupContextMenu } from './DirectoryGroupContextMenu';
import { PROJECT_PANEL_CLASS } from './project-panel';
import { ProjectGroupContextMenu } from './ProjectGroupContextMenu';
import {
  AddSshRepositoryAsProjectButton,
  SshRepositoryGroupContextMenu,
  sshWorkspacesWithoutProject,
} from './SshRepositoryGroupContextMenu';
import {
  goesOnTaggedShelf,
  goesOnWorkingShelf,
  hasWorkspacesHiddenByHost,
  isListedInWorkspaceList,
  isListedOnStoppedShelf,
  isListedOnTrashShelf,
  matchesWorkspaceListFiltersExceptHost,
} from './workspace-list-filtering';
import {
  getVisibleOrderedWorkspaceIds,
  sortByLastTouched,
  splitWorkspaceListSections,
  type WorkspaceGroup,
} from './workspace-list-ordering';
import { WorkspaceCard } from './WorkspaceCard';

interface WorkspaceListProps {
  onNewWorkspaceDialogChange?: (open: boolean) => void;
}

function reorderProjectGroups(
  sourceProjectId: string,
  targetProjectId: string,
  position: 'before' | 'after',
  projects: Project[],
  reorderProject: (projectId: string, index: number) => void | Promise<void>
) {
  const index = getProjectMoveIndex(projects, sourceProjectId, targetProjectId, position);
  if (index !== null) void reorderProject(sourceProjectId, index);
}

async function reorderNonProjectGroups(
  sourceMembers: Workspace[],
  targetMembers: Workspace[],
  position: 'before' | 'after',
  activeWorkspaces: Workspace[],
  reorderWorkspace: (workspaceId: string, index: number) => Promise<void>
) {
  const manualOrderWorkspaces = [...activeWorkspaces].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0)
  );
  const sourceIds = new Set(sourceMembers.map((workspace) => workspace.id));
  const targetIds = new Set(targetMembers.map((workspace) => workspace.id));

  const moving = manualOrderWorkspaces.filter((workspace) => sourceIds.has(workspace.id));
  if (moving.length === 0) return;

  const remaining = manualOrderWorkspaces.filter((workspace) => !sourceIds.has(workspace.id));
  const firstTargetIndex = remaining.findIndex((workspace) => targetIds.has(workspace.id));
  let lastTargetIndex = -1;
  for (let i = 0; i < remaining.length; i++) {
    if (targetIds.has(remaining[i].id)) lastTargetIndex = i;
  }
  if (firstTargetIndex === -1 || lastTargetIndex === -1) return;

  const insertionIndex = position === 'before' ? firstTargetIndex : lastTargetIndex + 1;
  const desiredOrder = [
    ...remaining.slice(0, insertionIndex),
    ...moving,
    ...remaining.slice(insertionIndex),
  ].map((workspace) => workspace.id);

  const currentOrder = manualOrderWorkspaces.map((workspace) => workspace.id);
  for (let desiredIndex = 0; desiredIndex < desiredOrder.length; desiredIndex++) {
    const desiredId = desiredOrder[desiredIndex];
    if (currentOrder[desiredIndex] === desiredId) continue;
    const currentIndex = currentOrder.indexOf(desiredId);
    if (currentIndex === -1) continue;

    await reorderWorkspace(desiredId, desiredIndex);
    currentOrder.splice(currentIndex, 1);
    currentOrder.splice(desiredIndex, 0, desiredId);
  }
}

type GroupDropTarget = {
  groupKey: string;
  position: 'before' | 'after';
} | null;

function getDropIndicatorClass(groupKey: string, groupDropTarget: GroupDropTarget): string | false {
  if (groupDropTarget?.groupKey !== groupKey) return false;
  return groupDropTarget.position === 'before'
    ? 'group-drop-indicator-before'
    : 'group-drop-indicator-after';
}

interface GroupDragHandlers {
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}

function buildGroupDragHandlers(
  groupKey: string,
  draggedGroupKey: string | null,
  onStart: (key: string) => void,
  onEnd: () => void,
  onOver: (key: string, position: 'before' | 'after') => void,
  onDrop: () => void | Promise<void>
): GroupDragHandlers {
  return {
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-komla-group', groupKey);
      onStart(groupKey);
    },
    onDragEnd: onEnd,
    onDragOver: (e) => {
      if (!draggedGroupKey) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = e.currentTarget.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      const position = e.clientY < midpoint ? 'before' : 'after';
      onOver(groupKey, position);
    },
    onDrop: (e) => {
      e.preventDefault();
      void onDrop();
    },
  };
}

interface GroupContextMenuWrapperProps {
  group: WorkspaceGroup;
  groupProject: Project | undefined;
  children: React.ReactNode;
}

function GroupContextMenuWrapper({ group, groupProject, children }: GroupContextMenuWrapperProps) {
  if (groupProject) {
    return <ProjectGroupContextMenu project={groupProject}>{children}</ProjectGroupContextMenu>;
  }
  if (group.isDirectory) {
    return (
      <DirectoryGroupContextMenu workspace={group.workspaces[0]}>
        {children}
      </DirectoryGroupContextMenu>
    );
  }
  const sshWorkspaces = sshWorkspacesWithoutProject(group);
  if (sshWorkspaces.length > 0) {
    return (
      <SshRepositoryGroupContextMenu workspaces={sshWorkspaces}>
        {children}
      </SshRepositoryGroupContextMenu>
    );
  }
  return <>{children}</>;
}

interface GroupHeaderIconProps {
  isDirectory: boolean;
  expanded: boolean;
  icon?: string;
}

function GroupHeaderIcon({ isDirectory, expanded, icon }: GroupHeaderIconProps) {
  if (icon) {
    return (
      <ProjectMark
        project={{ icon }}
        iconClassName={cn('size-5 transition-opacity', !expanded && 'opacity-60')}
      />
    );
  }
  if (isDirectory) {
    return (
      <Folder className="light-darken size-5 shrink-0 text-[color:var(--group-header-color)]" />
    );
  }
  return (
    <span
      className={cn(
        'light-darken mx-1.25 shrink-0 rounded-full bg-[var(--group-header-color)] transition-all',
        expanded ? 'size-2.5' : 'h-0.5 w-2.5'
      )}
    />
  );
}

// What the cards of a collapsed group would show: who needs the user, and who is working.
function GroupAttentionSummary({ workspaces }: { workspaces: Workspace[] }) {
  const { needsInput, errors, running } = summarizeWorkspaceAttention(workspaces);
  if (needsInput + errors + running === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {needsInput > 0 && (
        <Badge tone="attention" variant="solid" title={`${needsInput} needs input`}>
          <Question aria-hidden="true" weight="bold" className="size-2.5" />
          {needsInput}
          <span className="sr-only"> needs input</span>
        </Badge>
      )}
      {errors > 0 && (
        <Badge
          tone="error"
          variant="solid"
          title={`${errors} ${errors === 1 ? 'error' : 'errors'}`}
        >
          <Warning aria-hidden="true" weight="bold" className="size-2.5" />
          {errors}
          <span className="sr-only">{errors === 1 ? ' error' : ' errors'}</span>
        </Badge>
      )}
      {running > 0 && (
        <span
          className="inline-flex items-center gap-0.5 text-2xs text-muted-foreground"
          title={`${running} running`}
        >
          <ActivitySpinner className="size-3" />
          {running}
          <span className="sr-only"> running</span>
        </span>
      )}
    </span>
  );
}

interface GroupHeaderActionProps {
  group: WorkspaceGroup;
  groupProject: Project | undefined;
}

function GroupHeaderAction({ group, groupProject }: GroupHeaderActionProps) {
  if (groupProject) {
    return (
      <IconButton
        size="xs"
        // Faint so it doesn't compete with the project name.
        className="size-5 text-muted-foreground/50 hover:text-foreground"
        label={`New workspace in ${groupProject.name}`}
        tooltipSide="right"
        onClick={() => openNewWorkspaceDialog({ prefill: { projectId: groupProject.id } })}
      >
        <Plus className="size-3" />
      </IconButton>
    );
  }
  if (group.isDirectory) {
    return (
      <IconButton
        size="xs"
        className="size-5 text-muted-foreground/70 opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100"
        label="Change color"
        tooltipSide="right"
        onClick={(e) => {
          e.currentTarget.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              clientX: e.clientX,
              clientY: e.clientY,
            })
          );
        }}
      >
        <Palette className="size-3.5" />
      </IconButton>
    );
  }
  const [sshWorkspace] = sshWorkspacesWithoutProject(group);
  if (sshWorkspace) {
    return (
      <AddSshRepositoryAsProjectButton
        workspace={sshWorkspace}
        repoName={group.projectInfo!.name}
      />
    );
  }
  return null;
}

interface GroupHeaderProps {
  group: WorkspaceGroup;
  expanded: boolean;
  /** The selected workspace is hidden inside this collapsed group. */
  containsSelection: boolean;
  groupProject: Project | undefined;
  onToggle: () => void;
}

// The row is the context-menu trigger, so it forwards the trigger's ref and props.
const GroupHeader = React.forwardRef<
  HTMLDivElement,
  GroupHeaderProps & React.HTMLAttributes<HTMLDivElement>
>(function GroupHeader(
  { group, expanded, containsSelection, groupProject, onToggle, className, style, ...rest },
  ref
) {
  const groupStyle = {
    '--group-header-color': group.projectInfo!.color,
    ...style,
  } as React.CSSProperties;

  return (
    <div
      {...rest}
      ref={ref}
      data-group-header=""
      data-contains-selection={containsSelection || undefined}
      className={cn(
        'group/header flex items-center gap-0.5 rounded-md pr-1 transition-colors hover:bg-accent/30',
        containsSelection && 'bg-accent hover:bg-accent',
        className
      )}
      style={groupStyle}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-1.5 text-[13px] focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
      >
        <GroupHeaderIcon
          isDirectory={group.isDirectory ?? false}
          expanded={expanded}
          icon={group.projectInfo!.icon}
        />
        <span
          className="truncate font-semibold tracking-normal text-foreground"
          // A folder's path tells apart folders of the same name.
          title={
            groupProject?.kind === 'directory'
              ? groupProject.repositoryPath
              : group.projectInfo!.name
          }
        >
          {group.projectInfo!.name}
        </span>
        {!expanded && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
            <GroupAttentionSummary workspaces={group.workspaces} />
            <span className="text-2xs text-muted-foreground tabular-nums">
              {group.workspaces.length}
              <span className="sr-only">
                {group.workspaces.length === 1 ? ' workspace' : ' workspaces'}
              </span>
            </span>
          </span>
        )}
      </button>
      <GroupHeaderAction group={group} groupProject={groupProject} />
    </div>
  );
});

function PinnedShelfHeader() {
  return (
    <h3 className="flex items-center gap-1.5 px-2 py-1.5 text-2xs font-medium text-muted-foreground">
      <PushPin aria-hidden="true" weight="bold" className="size-3" />
      Pinned
    </h3>
  );
}

interface GroupHeaderRowProps {
  group: WorkspaceGroup;
  expanded: boolean;
  containsSelection: boolean;
  groupProject: Project | undefined;
  onToggle: (groupKey: string) => void;
}

// The list re-renders on every workspace change, such as an agent's title, so headers skip
// the renders that change nothing they show.
const GroupHeaderRow = React.memo(function GroupHeaderRow({
  group,
  expanded,
  containsSelection,
  groupProject,
  onToggle,
}: GroupHeaderRowProps) {
  return (
    <GroupContextMenuWrapper group={group} groupProject={groupProject}>
      <GroupHeader
        group={group}
        expanded={expanded}
        containsSelection={containsSelection}
        groupProject={groupProject}
        onToggle={() => onToggle(group.key)}
      />
    </GroupContextMenuWrapper>
  );
}, sameGroupHeaderRowProps);

function sameGroupHeaderRowProps(prev: GroupHeaderRowProps, next: GroupHeaderRowProps): boolean {
  const [a, b] = [prev.group, next.group];
  if (
    prev.expanded !== next.expanded ||
    prev.containsSelection !== next.containsSelection ||
    prev.groupProject !== next.groupProject ||
    prev.onToggle !== next.onToggle ||
    a.key !== b.key ||
    a.isDirectory !== b.isDirectory ||
    a.projectInfo?.name !== b.projectInfo?.name ||
    a.projectInfo?.color !== b.projectInfo?.color ||
    a.projectInfo?.icon !== b.projectInfo?.icon
  ) {
    return false;
  }
  // An expanded project header shows none of its workspaces; collapsed headers summarize
  // them, and directory and SSH group menus act on them.
  if (next.groupProject && next.expanded) return true;
  return (
    a.workspaces.length === b.workspaces.length &&
    a.workspaces.every((w, i) => w === b.workspaces[i])
  );
}

interface OpenPlacement {
  id: string | null;
  hideWorking: boolean;
  hiddenTags: ReadonlySet<string>;
  tag: string | undefined;
  onWorkingShelf: boolean;
  onTaggedShelf: boolean;
}

/**
 * Where the open workspace stays: where it was when it was opened, in the list or on the Working or
 * Filtered shelf, so prompting its agent or seeing its done doesn't send it away and a card clicked
 * on a shelf stays there. Hiding working workspaces or tags, or changing its tag, leaves the open
 * one in the list.
 */
function useOpenPlacement(
  workspaces: Workspace[],
  selectedWorkspaceId: string | null,
  hideWorking: boolean,
  hiddenWorkspaceTags: ReadonlySet<string>
): OpenPlacement {
  const open = workspaces.find((w) => w.id === selectedWorkspaceId);
  const [placement, setPlacement] = useState<OpenPlacement>({
    id: null,
    hideWorking,
    hiddenTags: hiddenWorkspaceTags,
    tag: undefined,
    onWorkingShelf: false,
    onTaggedShelf: false,
  });
  if (placement.id !== selectedWorkspaceId) {
    const next = {
      id: selectedWorkspaceId,
      hideWorking,
      hiddenTags: hiddenWorkspaceTags,
      tag: open?.tag,
      onWorkingShelf: hideWorking && !!open && goesOnWorkingShelf(open),
      onTaggedShelf: !!open && goesOnTaggedShelf(open, hiddenWorkspaceTags),
    };
    setPlacement(next);
    return next;
  }
  if (placement.hideWorking !== hideWorking) {
    const next = { ...placement, hideWorking, onWorkingShelf: false };
    setPlacement(next);
    return next;
  }
  if (placement.hiddenTags !== hiddenWorkspaceTags || placement.tag !== open?.tag) {
    const next = {
      ...placement,
      hiddenTags: hiddenWorkspaceTags,
      tag: open?.tag,
      onTaggedShelf: false,
    };
    setPlacement(next);
    return next;
  }
  return placement;
}

type ShelfKey = 'working' | 'tagged' | 'snoozed' | 'stopped' | 'trash';

interface Shelf {
  key: ShelfKey;
  label: string;
  icon: Icon;
  count: number;
  open: boolean;
  shown: Workspace[];
  /** Left off the open shelf for the Overview to show. */
  overflow: number;
}

// Opening the Trash shelf mounts a card per workspace, so it lists the most recent ones and
// leaves the rest to the Overview.
const TRASH_SHELF_LIMIT = 50;

function ShelfHeader({
  label,
  icon: ShelfIcon,
  count,
  expanded,
  onToggle,
}: {
  label: string;
  icon: Icon;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-2xs font-medium text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
    >
      <ShelfIcon aria-hidden="true" weight="bold" className="size-3" />
      {label}
      <span className="ml-auto flex items-center gap-1 tabular-nums">
        {count}
        <CaretRight
          aria-hidden="true"
          className={cn('size-3 transition-transform', expanded && 'rotate-90')}
        />
      </span>
    </button>
  );
}

type PaneEmptyReason = 'hidden-hosts' | 'no-projects';

function getPaneEmptyReason({
  listsNothing,
  hasHiddenHostWorkspaces,
  hasProjects,
}: {
  listsNothing: boolean;
  hasHiddenHostWorkspaces: boolean;
  hasProjects: boolean;
}): PaneEmptyReason | null {
  if (!listsNothing) return null;
  if (hasHiddenHostWorkspaces) return 'hidden-hosts';
  return hasProjects ? null : 'no-projects';
}

// The list pane when nothing is listed: every workspace is on a hidden host, or there are no
// projects yet.
function PaneEmptyState({
  reason,
  onShowAllHosts,
}: {
  reason: PaneEmptyReason;
  onShowAllHosts: () => void;
}) {
  if (reason === 'hidden-hosts') {
    return (
      <EmptyState
        size="sm"
        className="h-full"
        title="No workspaces on visible hosts"
        action={
          <Button variant="outline" size="sm" onClick={onShowAllHosts}>
            Show all hosts
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      size="sm"
      className="h-full"
      icon={<RocketLaunch weight="duotone" />}
      title="Get started"
      description="Add a project to begin"
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            window.dispatchEvent(new CustomEvent('open-settings', { detail: 'projects' }))
          }
        >
          Add Project
        </Button>
      }
    />
  );
}

// Docked at the bottom of the pane; one shelf opens at a time, growing up to half of it and
// scrolling.
function ShelfDock({
  shelves,
  compact,
  onToggle,
  onOpenOverview,
  onEmptyTrash,
  renderCard,
}: {
  shelves: Shelf[];
  compact: boolean;
  onToggle: (shelf: Shelf) => void;
  onOpenOverview: () => void;
  onEmptyTrash: () => void;
  renderCard: (workspace: Workspace) => React.ReactNode;
}) {
  if (shelves.length === 0) return null;
  return (
    <div className="flex max-h-1/2 shrink-0 flex-col border-t border-border/20 px-1.5 pt-1">
      {shelves.map((shelf) => (
        <section
          key={shelf.key}
          aria-label={shelf.label}
          // Only a shelf showing cards gives up height; a closed one keeps its header.
          className={cn('flex flex-col', shelf.shown.length > 0 ? 'min-h-0' : 'shrink-0')}
        >
          <ShelfHeader
            label={shelf.label}
            icon={shelf.icon}
            count={shelf.count}
            expanded={shelf.open}
            onToggle={() => onToggle(shelf)}
          />
          {shelf.shown.length > 0 && (
            <ScrollArea
              type="scroll"
              className="min-h-0 [&_[data-radix-scroll-area-viewport]>div]:!block [&>[data-radix-scroll-area-scrollbar]]:w-1"
            >
              <div className={cn('pb-1', compact ? 'space-y-0.5' : 'space-y-1')}>
                {shelf.shown.map(renderCard)}
                {shelf.overflow > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full text-2xs text-muted-foreground"
                    onClick={onOpenOverview}
                  >
                    {shelf.overflow} more in Overview
                  </Button>
                )}
              </div>
            </ScrollArea>
          )}
          {/* Below the cards, so it stays in sight however many there are. */}
          {shelf.key === 'trash' && shelf.open && (
            <div className="flex shrink-0 items-center justify-between gap-2 pb-1 pl-2 text-2xs text-muted-foreground">
              Deleted after {TRASH_RETENTION_DAYS} days
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-2xs text-muted-foreground hover:text-destructive"
                onClick={onEmptyTrash}
              >
                Empty Trash
              </Button>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

interface WorkspaceListEmptyStateProps {
  hiddenProjectIdsWithWorkspaces: string[];
  onShowProjects: () => void;
}

// Why the list is empty, with the way out. With nothing hidden, the main area says it instead;
// workspaces hidden by "Hide stopped" are on the Stopped shelf.
function WorkspaceListEmptyState({
  hiddenProjectIdsWithWorkspaces,
  onShowProjects,
}: WorkspaceListEmptyStateProps) {
  const hiddenProjectCount = hiddenProjectIdsWithWorkspaces.length;
  if (hiddenProjectCount === 0) return null;

  return (
    <EmptyState
      size="sm"
      icon={<EyeSlash weight="duotone" />}
      title={`${hiddenProjectCount} ${hiddenProjectCount === 1 ? 'project' : 'projects'} hidden`}
      action={
        <Button variant="outline" size="sm" onClick={onShowProjects}>
          {hiddenProjectCount === 1 ? 'Show project' : 'Show projects'}
        </Button>
      }
    />
  );
}

export function WorkspaceList({
  onNewWorkspaceDialogChange: _onNewWorkspaceDialogChange,
}: WorkspaceListProps) {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const selectedWorkspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);
  const collapsedGroupKeys = useWorkspacesStore((s) => s.collapsedWorkspaceGroupKeys);
  const toggleWorkspaceGroupCollapsed = useWorkspacesStore((s) => s.toggleWorkspaceGroupCollapsed);
  const unhideProjectGroups = useWorkspacesStore((s) => s.unhideProjectGroups);
  const reorderWorkspace = useWorkspacesStore((s) => s.reorderWorkspace);
  const hideStopped = useWorkspacesStore((s) => s.hideStopped);
  const grouping = useWorkspacesStore((s) => s.grouping);
  const hiddenWorkspaceHostIds = useWorkspacesStore((s) => s.hiddenWorkspaceHostIds);
  const compact = useConfigStore((s) => s.config?.compactWorkspaceList) === true;
  const hideWorking = useWorkspacesStore((s) => s.hideWorking);
  const hiddenWorkspaceTags = useWorkspacesStore((s) => s.hiddenWorkspaceTags);
  const showAllWorkspaceHosts = useWorkspacesStore((s) => s.showAllWorkspaceHosts);
  const setDisplayOrderedWorkspaceIds = useWorkspacesStore((s) => s.setDisplayOrderedWorkspaceIds);
  const hiddenProjectIds = useWorkspacesStore((s) => s.hiddenProjectIds);
  const selectionMode = useWorkspacesStore((s) => s.selectionMode);
  const selectedWorkspaceIds = useWorkspacesStore((s) => s.selectedWorkspaceIds);
  const deselectWorkspaces = useWorkspacesStore((s) => s.deselectWorkspaces);
  const exitSelectionMode = useWorkspacesStore((s) => s.exitSelectionMode);
  const selectAllWorkspaces = useWorkspacesStore((s) => s.selectAllWorkspaces);
  const deleteWorkspaces = useWorkspacesStore((s) => s.deleteWorkspaces);

  const projects = useProjectsStore((s) => s.projects);
  const reorderProject = useProjectsStore((s) => s.reorderProject);
  const currentWindowId = useWindowStore((s) => s.windowId);

  // Drag-and-drop state
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    workspaceId: string;
    position: 'before' | 'after';
  } | null>(null);
  const dropTargetRef = useRef<{
    workspaceId: string;
    position: 'before' | 'after';
  } | null>(null);

  // Working (while hidden), snoozed, stopped (while hidden) and trashed workspaces stay out of
  // sight on shelves at the bottom until one is opened.
  const [openShelf, setOpenShelf] = useState<ShelfKey | null>(null);
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);

  // Group drag-and-drop state
  const [draggedGroupKey, setDraggedGroupKey] = useState<string | null>(null);
  const [groupDropTarget, setGroupDropTarget] = useState<{
    groupKey: string;
    position: 'before' | 'after';
  } | null>(null);
  const groupDropTargetRef = useRef<{
    groupKey: string;
    position: 'before' | 'after';
  } | null>(null);

  // Tick to force re-renders so relative timestamps stay fresh.
  // Passed to WorkspaceCard so memo doesn't block timestamp updates.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectionMode) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept shortcuts when focus is in an interactive element
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable ||
        target.closest('.xterm') ||
        target.closest('.monaco-editor')
      ) {
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        exitSelectionMode();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        selectAllWorkspaces();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectionMode, exitSelectionMode, selectAllWorkspaces]);

  // Filter workspaces by window assignment, visibility, active status, and stopped filter
  const visibleWorkspaces = useMemo(() => {
    return workspaces.filter((w) =>
      isListedInWorkspaceList(w, {
        currentWindowId,
        hideStopped,
        hiddenProjectIds,
        hiddenWorkspaceHostIds,
      })
    );
  }, [workspaces, hideStopped, currentWindowId, hiddenWorkspaceHostIds, hiddenProjectIds]);

  // Why the list is empty, when it is: hidden projects that would otherwise show workspaces here.
  const hiddenProjectIdsWithWorkspaces = useMemo(() => {
    const hiddenProjects = new Set<string>();
    const unfiltered = { currentWindowId, hideStopped: false, hiddenProjectIds: new Set<string>() };
    for (const workspace of workspaces) {
      if (!isWorkspaceHostVisible(workspace, hiddenWorkspaceHostIds)) continue;
      if (!matchesWorkspaceListFiltersExceptHost(workspace, unfiltered)) continue;
      if (workspace.projectId && hiddenProjectIds.has(workspace.projectId)) {
        hiddenProjects.add(workspace.projectId);
      }
    }
    return Array.from(hiddenProjects);
  }, [workspaces, hiddenWorkspaceHostIds, currentWindowId, hiddenProjectIds]);

  // Stopped workspaces count even while hidden: they would be on the Stopped shelf.
  const hasHiddenHostWorkspaces = useMemo(
    () =>
      hasWorkspacesHiddenByHost(workspaces, hiddenWorkspaceHostIds, {
        currentWindowId,
        hideStopped: false,
        hiddenProjectIds,
      }),
    [workspaces, currentWindowId, hiddenProjectIds, hiddenWorkspaceHostIds]
  );

  // Create a project lookup map for efficient name resolution
  const projectMap = useMemo(() => {
    return new Map(projects.map((p) => [p.id, p]));
  }, [projects]);

  // Get project info (name, color and icon) for a workspace
  const getProjectInfo = useCallback(
    (workspace: Workspace): { name: string; color: string; icon?: string } | null => {
      if (workspace.projectId) {
        const project = projectMap.get(workspace.projectId);
        if (project) {
          return {
            name: project.name,
            color: project.color || getProjectColor(project.name),
            icon: project.icon,
          };
        }
      }
      if (workspace.repoName) {
        const matchingProject = projects.find((p) => p.name === workspace.repoName);
        const color = matchingProject?.color || getProjectColor(workspace.repoName);
        return { name: workspace.repoName, color };
      }
      if (!workspace.isWorktree && workspace.workingDirectory) {
        const dirName =
          workspace.workingDirectory.split(/[\\/]/).pop() || workspace.workingDirectory;
        return {
          name: dirName,
          color: workspace.color || getProjectColor(dirName),
        };
      }
      return null;
    },
    [projectMap, projects]
  );

  // Get group key for a workspace
  const getGroupKey = useCallback(
    (workspace: Workspace): { key: string; projectId: string | null; isDirectory: boolean } => {
      if (workspace.projectId) {
        const project = projectMap.get(workspace.projectId);
        if (project)
          return {
            key: `project:${project.id}`,
            projectId: project.id,
            isDirectory: project.kind === 'directory',
          };
      }
      if (workspace.repoName) {
        return {
          key: `repo:${workspace.repoName}`,
          projectId: null,
          isDirectory: false,
        };
      }
      if (!workspace.isWorktree && workspace.workingDirectory) {
        return { key: `dir:${workspace.workingDirectory}`, projectId: null, isDirectory: true };
      }
      return {
        key: `none:${workspace.id}`,
        projectId: null,
        isDirectory: false,
      };
    },
    [projectMap]
  );

  const sortedWorkspaces = useMemo(
    () => [...visibleWorkspaces].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [visibleWorkspaces]
  );

  const openPlacement = useOpenPlacement(
    workspaces,
    selectedWorkspaceId,
    hideWorking,
    hiddenWorkspaceTags
  );

  // A working or tagged workspace comes back to the list once its agents need input, fail or
  // finish, and a tagged one also once its tag is shown again, changes or comes off.
  const sections = useMemo(
    () =>
      splitWorkspaceListSections(
        sortedWorkspaces,
        (w) =>
          hideWorking &&
          (w.id === openPlacement.id ? openPlacement.onWorkingShelf : goesOnWorkingShelf(w)),
        (w) =>
          w.id === openPlacement.id
            ? openPlacement.onTaggedShelf
            : goesOnTaggedShelf(w, hiddenWorkspaceTags)
      ),
    [sortedWorkspaces, hideWorking, openPlacement, hiddenWorkspaceTags]
  );

  const stoppedShelfWorkspaces = useMemo(
    () =>
      sortByLastTouched(
        workspaces.filter((w) =>
          isListedOnStoppedShelf(w, {
            currentWindowId,
            hideStopped,
            hiddenProjectIds,
            hiddenWorkspaceHostIds,
          })
        )
      ),
    [workspaces, currentWindowId, hideStopped, hiddenProjectIds, hiddenWorkspaceHostIds]
  );
  const trashShelfWorkspaces = useMemo(
    () =>
      sortByLastTouched(
        workspaces.filter((w) =>
          isListedOnTrashShelf(w, { hiddenProjectIds, hiddenWorkspaceHostIds })
        )
      ),
    [workspaces, hiddenProjectIds, hiddenWorkspaceHostIds]
  );

  const shelves = useMemo((): Shelf[] => {
    const shelf = (
      key: ShelfKey,
      label: string,
      icon: Icon,
      shelved: Workspace[],
      limit = Infinity
    ): Shelf => {
      const open = openShelf === key;
      return {
        key,
        label,
        icon,
        count: shelved.length,
        open,
        // A shelved workspace that's open stays in sight while its shelf is collapsed.
        shown: shelved.filter((w, i) => (open && i < limit) || w.id === selectedWorkspaceId),
        overflow: open ? Math.max(0, shelved.length - limit) : 0,
      };
    };
    return [
      shelf('working', 'Working', CircleNotch, sections.working),
      shelf('tagged', 'Filtered', Tag, sections.tagged),
      shelf('snoozed', 'Snoozed', Alarm, sections.snoozed),
      shelf('stopped', 'Stopped', Square, stoppedShelfWorkspaces),
      shelf('trash', 'Trash', Trash, trashShelfWorkspaces, TRASH_SHELF_LIMIT),
    ].filter((s) => s.count > 0);
  }, [
    sections.working,
    sections.tagged,
    sections.snoozed,
    stoppedShelfWorkspaces,
    trashShelfWorkspaces,
    openShelf,
    selectedWorkspaceId,
  ]);
  // A shelf that empties closes, so it doesn't come back open.
  if (openShelf && !shelves.some((s) => s.key === openShelf)) setOpenShelf(null);

  // A selected workspace that moves onto the closed Working or Filtered shelf, as its agent starts a
  // turn or it's tagged, leaves the selection, so a bulk action doesn't reach a card the user
  // can't see.
  const workingShown = shelves.find((s) => s.key === 'working')?.shown;
  const taggedShown = shelves.find((s) => s.key === 'tagged')?.shown;
  useEffect(() => {
    if (!selectionMode) return;
    const shown = new Set([...(workingShown ?? []), ...(taggedShown ?? [])].map((w) => w.id));
    const outOfSight = [...sections.working, ...sections.tagged]
      .filter((w) => !shown.has(w.id) && selectedWorkspaceIds.has(w.id))
      .map((w) => w.id);
    if (outOfSight.length > 0) deselectWorkspaces(outOfSight);
  }, [
    selectionMode,
    selectedWorkspaceIds,
    sections.working,
    sections.tagged,
    workingShown,
    taggedShown,
    deselectWorkspaces,
  ]);

  // Keep activeWorkspaces as alias for drag-and-drop group reordering. Snoozed workspaces
  // keep their order slots, so they stay in.
  const activeWorkspaces = sortedWorkspaces;

  // Group workspaces by project. Ordering remains stable within each group.
  const groupWorkspaces = useCallback(
    (workspaceList: Workspace[]): WorkspaceGroup[] => {
      const groupMap = new Map<string, WorkspaceGroup>();

      for (const workspace of workspaceList) {
        const { key, projectId, isDirectory } = getGroupKey(workspace);
        const existing = groupMap.get(key);
        if (existing) {
          existing.workspaces.push(workspace);
        } else {
          const group: WorkspaceGroup = {
            key,
            projectInfo: getProjectInfo(workspace),
            projectId,
            isDirectory,
            workspaces: [workspace],
          };
          groupMap.set(key, group);
        }
      }

      const groups = Array.from(groupMap.values());

      // Sort project groups by project.order and inferred groups by workspace order.
      groups.sort((a, b) => {
        const orderA = a.projectId
          ? (projectMap.get(a.projectId)?.order ?? 0)
          : Math.min(...a.workspaces.map((w) => w.order ?? 0));
        const orderB = b.projectId
          ? (projectMap.get(b.projectId)?.order ?? 0)
          : Math.min(...b.workspaces.map((w) => w.order ?? 0));
        return orderA - orderB;
      });

      for (const group of groups) {
        group.workspaces.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      }

      return groups;
    },
    [getGroupKey, getProjectInfo, projectMap]
  );

  const allActiveGroups = useMemo((): WorkspaceGroup[] => {
    if (grouping === 'project') {
      // Pinned, working and tagged workspaces sit on shelves, but still place their group. A project
      // whose workspaces are all pinned or working keeps its header (and New workspace button); one
      // the tag filter emptied goes, so filtering doesn't leave a row of empty projects.
      const grouped = new Set(sections.grouped);
      const filtered = new Set(sections.tagged);
      return groupWorkspaces([
        ...sections.pinned,
        ...sections.working,
        ...sections.tagged,
        ...sections.grouped,
      ])
        .filter(
          (group) =>
            group.workspaces.some((w) => grouped.has(w)) ||
            (group.projectId && !group.workspaces.some((w) => filtered.has(w)))
        )
        .map((group) => ({ ...group, workspaces: group.workspaces.filter((w) => grouped.has(w)) }));
    }
    // One flat list, already in sort order.
    if (sections.grouped.length === 0) return [];
    return [
      {
        key: 'all',
        projectInfo: null,
        projectId: null,
        isDirectory: false,
        workspaces: sections.grouped,
      },
    ];
  }, [
    sections.pinned,
    sections.working,
    sections.tagged,
    sections.grouped,
    groupWorkspaces,
    grouping,
  ]);

  // Filter out hidden project groups
  const workspaceGroups = useMemo(
    () => allActiveGroups.filter((g) => !g.projectId || !hiddenProjectIds.has(g.projectId)),
    [allActiveGroups, hiddenProjectIds]
  );

  // Refs for stable drag callbacks — updated after commit, read at call time.
  // Using useEffect (not render-phase writes) for React 18 StrictMode safety.
  const draggedIdRef = useRef(draggedId);
  const visibleWorkspacesRef = useRef(visibleWorkspaces);
  const getGroupKeyRef = useRef(getGroupKey);
  const groupingRef = useRef(grouping);
  useEffect(() => {
    draggedIdRef.current = draggedId;
    visibleWorkspacesRef.current = visibleWorkspaces;
    getGroupKeyRef.current = getGroupKey;
    groupingRef.current = grouping;
  });

  // Drag handlers (stable references — safe to pass through React.memo)
  const handleDragStart = useCallback((workspaceId: string) => {
    setDraggedId(workspaceId);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedId(null);
    setDropTarget(null);
    dropTargetRef.current = null;
  }, []);

  const handleDragOver = useCallback((workspaceId: string, position: 'before' | 'after') => {
    const currentDraggedId = draggedIdRef.current;
    if (currentDraggedId && workspaceId !== currentDraggedId) {
      // Constrain to the Pinned shelf, or to the same group below it
      const ws = visibleWorkspacesRef.current;
      const draggedWs = ws.find((w) => w.id === currentDraggedId);
      const targetWs = ws.find((w) => w.id === workspaceId);
      if (draggedWs && targetWs) {
        const bothPinned = Boolean(draggedWs.pinned) && Boolean(targetWs.pinned);
        const sameSection =
          Boolean(draggedWs.pinned) === Boolean(targetWs.pinned) &&
          (bothPinned ||
            groupingRef.current === 'none' ||
            getGroupKeyRef.current(draggedWs).key === getGroupKeyRef.current(targetWs).key);
        if (!sameSection) {
          // Different section - reject drop
          setDropTarget(null);
          dropTargetRef.current = null;
          return;
        }
      }
      const target = { workspaceId, position };
      setDropTarget(target);
      dropTargetRef.current = target;
    }
  }, []);

  const handleDrop = useCallback(() => {
    const target = dropTargetRef.current;
    const currentDraggedId = draggedIdRef.current;
    if (!currentDraggedId || !target || currentDraggedId === target.workspaceId) {
      setDraggedId(null);
      setDropTarget(null);
      dropTargetRef.current = null;
      return;
    }

    const ws = visibleWorkspacesRef.current;
    const draggedWorkspace = ws.find((w) => w.id === currentDraggedId);
    const targetWorkspace = ws.find((w) => w.id === target.workspaceId);
    if (draggedWorkspace && targetWorkspace) {
      const oldOrder = draggedWorkspace.order ?? 0;
      const targetOrder = targetWorkspace.order ?? 0;
      let newOrder: number;
      if (target.position === 'before') {
        newOrder = oldOrder < targetOrder ? targetOrder - 1 : targetOrder;
      } else {
        newOrder = oldOrder > targetOrder ? targetOrder + 1 : targetOrder;
      }
      if (newOrder !== oldOrder) {
        void reorderWorkspace(currentDraggedId, newOrder);
      }
    }

    setDraggedId(null);
    setDropTarget(null);
    dropTargetRef.current = null;
  }, [reorderWorkspace]);

  // Group drag handlers
  const handleGroupDragStart = useCallback((groupKey: string) => {
    setDraggedGroupKey(groupKey);
  }, []);

  const handleGroupDragEnd = useCallback(() => {
    setDraggedGroupKey(null);
    setGroupDropTarget(null);
    groupDropTargetRef.current = null;
  }, []);

  const handleGroupDragOver = useCallback(
    (groupKey: string, position: 'before' | 'after') => {
      if (draggedGroupKey && groupKey !== draggedGroupKey) {
        const target = { groupKey, position };
        setGroupDropTarget(target);
        groupDropTargetRef.current = target;
      }
    },
    [draggedGroupKey]
  );

  const handleGroupDrop = useCallback(async () => {
    const target = groupDropTargetRef.current;
    const clearGroupDrag = () => {
      setDraggedGroupKey(null);
      setGroupDropTarget(null);
      groupDropTargetRef.current = null;
    };

    if (!draggedGroupKey || !target || draggedGroupKey === target.groupKey) {
      clearGroupDrag();
      return;
    }

    const sourceGroup = workspaceGroups.find((g) => g.key === draggedGroupKey);
    const targetGroup = workspaceGroups.find((g) => g.key === target.groupKey);

    if (sourceGroup?.projectId && targetGroup?.projectId) {
      reorderProjectGroups(
        sourceGroup.projectId,
        targetGroup.projectId,
        target.position,
        projects,
        reorderProject
      );
    } else if (sourceGroup && targetGroup) {
      // A group's pinned, working and tagged workspaces move with it, off on their shelves.
      const membersOf = (group: WorkspaceGroup) => [
        ...group.workspaces,
        ...[...sections.pinned, ...sections.working, ...sections.tagged].filter(
          (w) => getGroupKey(w).key === group.key
        ),
      ];
      await reorderNonProjectGroups(
        membersOf(sourceGroup),
        membersOf(targetGroup),
        target.position,
        activeWorkspaces,
        reorderWorkspace
      );
    }

    clearGroupDrag();
  }, [
    draggedGroupKey,
    workspaceGroups,
    sections.pinned,
    sections.working,
    sections.tagged,
    getGroupKey,
    projects,
    activeWorkspaces,
    reorderProject,
    reorderWorkspace,
  ]);

  const isGroupExpanded = useCallback(
    (group: WorkspaceGroup): boolean => !collapsedGroupKeys.has(group.key),
    [collapsedGroupKeys]
  );

  // Full ordered IDs — used for shift-click range selection and Cmd+Arrow keyboard
  // navigation (via ShortcutProvider). Excludes workspaces inside collapsed groups so
  // neither action can silently select a workspace the user can't see.
  // Stabilized: only produces a new reference when the actual IDs change,
  // so memoized WorkspaceCards don't re-render on unrelated workspace updates.
  const prevOrderedIdsRef = useRef<string[]>([]);
  const allOrderedIds = useMemo(() => {
    const next = [
      ...sections.pinned.map((w) => w.id),
      ...getVisibleOrderedWorkspaceIds(workspaceGroups, isGroupExpanded),
      // Opening a workspace in the Trash restores it, so the arrow keys pass the Trash shelf by.
      ...shelves.filter((s) => s.key !== 'trash').flatMap((s) => s.shown.map((w) => w.id)),
    ];
    const prev = prevOrderedIdsRef.current;
    if (prev.length === next.length && prev.every((id, i) => id === next[i])) {
      return prev;
    }
    return next;
  }, [sections.pinned, workspaceGroups, isGroupExpanded, shelves]);
  // Update ref after commit (not during render) so StrictMode double-renders are safe
  useEffect(() => {
    prevOrderedIdsRef.current = allOrderedIds;
  }, [allOrderedIds]);

  // Sync display order to store for keyboard navigation (ShortcutProvider)
  useEffect(() => {
    setDisplayOrderedWorkspaceIds(allOrderedIds);
  }, [allOrderedIds, setDisplayOrderedWorkspaceIds]);

  // With nothing to list, say why, while the shelves stay below.
  const paneEmptyReason = getPaneEmptyReason({
    listsNothing: visibleWorkspaces.length === 0 && stoppedShelfWorkspaces.length === 0,
    hasHiddenHostWorkspaces,
    hasProjects: projects.length > 0,
  });

  const handleShowHiddenProjects = () => {
    unhideProjectGroups(hiddenProjectIdsWithWorkspaces);
  };

  // Say why nothing is listed.
  const emptyState =
    visibleWorkspaces.length === 0 ? (
      <WorkspaceListEmptyState
        hiddenProjectIdsWithWorkspaces={hiddenProjectIdsWithWorkspaces}
        onShowProjects={handleShowHiddenProjects}
      />
    ) : null;

  const renderWorkspaceCard = (
    workspace: Workspace,
    projectInfo: { name: string; color: string; icon?: string } | null,
    hideDirectoryPath?: boolean,
    dndEnabled = !selectionMode
  ) => (
    <WorkspaceCard
      key={workspace.id}
      workspace={workspace}
      projectInfo={projectInfo}
      hideDirectoryPath={hideDirectoryPath}
      orderedWorkspaceIds={allOrderedIds}
      tick={tick}
      isDragging={dndEnabled ? draggedId === workspace.id : false}
      dropPosition={
        dndEnabled && dropTarget?.workspaceId === workspace.id ? dropTarget.position : null
      }
      dndEnabled={dndEnabled}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    />
  );

  return (
    <div className="group/sidebar flex h-full flex-col">
      {paneEmptyReason ? (
        <div className="min-h-0 flex-1">
          <PaneEmptyState reason={paneEmptyReason} onShowAllHosts={showAllWorkspaceHosts} />
        </div>
      ) : (
        <ScrollArea
          type="scroll"
          className={cn(
            'min-h-0 flex-1 [&>[data-radix-scroll-area-scrollbar]]:w-1 [&>[data-radix-scroll-area-viewport]]:scroll-fade-y [&_[data-radix-scroll-area-viewport]>div]:!block',
            selectionMode && 'select-none'
          )}
        >
          <div className="p-2.5">
            {sections.pinned.length > 0 && (
              <section aria-label="Pinned" className={cn(workspaceGroups.length > 0 && 'mb-2.5')}>
                <PinnedShelfHeader />
                <div
                  className={cn(
                    'relative [clip-path:inset(-4px_-100vw)]',
                    compact ? 'space-y-0.5' : 'space-y-1'
                  )}
                >
                  {sections.pinned.map((workspace) =>
                    renderWorkspaceCard(workspace, getProjectInfo(workspace))
                  )}
                </div>
              </section>
            )}
            {workspaceGroups.map((group, index) => {
              const isGroupDraggable = !selectionMode;
              const isGroupBeingDragged = draggedGroupKey === group.key;

              // Groups without project info, and the ungrouped list: render cards flat, each
              // naming its project
              if (!group.projectInfo) {
                return (
                  <div
                    key={group.key}
                    className={cn(index > 0 && 'mt-2.5', compact ? 'space-y-0.5' : 'space-y-1')}
                  >
                    {group.workspaces.map((workspace) =>
                      renderWorkspaceCard(workspace, getProjectInfo(workspace))
                    )}
                  </div>
                );
              }

              // Groups with project info: always show header + indented children
              const expanded = isGroupExpanded(group);
              const containsSelection =
                !expanded && group.workspaces.some((w) => w.id === selectedWorkspaceId);
              const groupProject = group.projectId ? projectMap.get(group.projectId) : undefined;

              const dragHandlers: GroupDragHandlers = isGroupDraggable
                ? buildGroupDragHandlers(
                    group.key,
                    draggedGroupKey,
                    handleGroupDragStart,
                    handleGroupDragEnd,
                    handleGroupDragOver,
                    handleGroupDrop
                  )
                : {};

              // Only the header starts a group drag; the whole group is the drop
              // target. Making the group wrapper draggable would turn every card
              // drag into a group drag. Each project sits on its own panel.
              return (
                <div
                  key={group.key}
                  className={cn(
                    'relative',
                    PROJECT_PANEL_CLASS,
                    index > 0 && 'mt-2.5',
                    isGroupBeingDragged && 'opacity-50',
                    getDropIndicatorClass(group.key, groupDropTarget)
                  )}
                  onDragOver={dragHandlers.onDragOver}
                  onDrop={dragHandlers.onDrop}
                >
                  <div
                    draggable={isGroupDraggable}
                    onDragStart={dragHandlers.onDragStart}
                    onDragEnd={dragHandlers.onDragEnd}
                  >
                    <GroupHeaderRow
                      group={group}
                      expanded={expanded}
                      containsSelection={containsSelection}
                      groupProject={groupProject}
                      onToggle={toggleWorkspaceGroupCollapsed}
                    />
                  </div>
                  {expanded && (
                    // The clip keeps a selection gliding in from another group from sweeping
                    // across the gap and this group's header.
                    <div
                      className={cn(
                        'relative [clip-path:inset(-4px_-100vw)]',
                        compact ? 'space-y-0.5' : 'space-y-1'
                      )}
                    >
                      {group.workspaces.map((workspace) =>
                        renderWorkspaceCard(workspace, null, group.isDirectory)
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {emptyState}
          </div>
        </ScrollArea>
      )}
      <ShelfDock
        shelves={shelves}
        compact={compact}
        onToggle={(shelf) => setOpenShelf(shelf.open ? null : shelf.key)}
        onOpenOverview={() => void selectWorkspace(null)}
        onEmptyTrash={() => setEmptyTrashOpen(true)}
        renderCard={(workspace) =>
          renderWorkspaceCard(workspace, getProjectInfo(workspace), false, false)
        }
      />
      <BulkDeleteDialog
        open={emptyTrashOpen}
        onOpenChange={setEmptyTrashOpen}
        workspaces={trashShelfWorkspaces}
        onConfirm={(deleteBranch, workspacesToDelete) =>
          void deleteWorkspaces(
            workspacesToDelete.map((workspace) => workspace.id),
            true,
            deleteBranch
          )
        }
      />
    </div>
  );
}
