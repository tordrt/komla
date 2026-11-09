import {
  Alarm,
  CaretRight,
  CircleNotch,
  EyeSlash,
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
import React, { useMemo, useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useDragAutoScroll } from '@/hooks/useDragAutoScroll';
import { getProjectColor } from '@/lib/project-colors';
import { getProjectMoveIndex } from '@/lib/project-order';
import { PINNED_GROUP_KEY } from '@/lib/sidebar-collapsed-groups';
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
import { GroupHeaderIcon } from './GroupHeaderIcon';
import { ProjectGroupContextMenu } from './ProjectGroupContextMenu';
import { SIDEBAR_PANEL_CLASS } from './sidebar-panel';
import {
  SshRepositoryGroupContextMenu,
  SshRepositoryNotAProjectCallout,
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
  getDropOrder,
  getWorkspaceDropTarget,
  placeLeftInbox,
  readDraggableCards,
  sortByLastTouched,
  sortInboxFirst,
  splitWorkspaceListSections,
  trackInbox,
  type NeedsYouEntry,
  type WorkspaceDropTarget,
  type WorkspaceGroup,
  type WorkspaceMove,
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
        className="size-5 text-muted-foreground hover:text-foreground"
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
        className="size-5 text-muted-foreground-70 opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100"
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
  { group, expanded, containsSelection, groupProject, onToggle, className, ...rest },
  ref
) {
  return (
    <div
      {...rest}
      ref={ref}
      data-group-header=""
      data-contains-selection={containsSelection || undefined}
      className={cn(
        // Flush to its panel's edges, so its hover and selection fills take the panel's corners. Its
        // icon and action sit where they did when the panel had padding: 8px in on the left, 6px
        // on the right.
        'group/header flex items-center gap-0.5 rounded-xl pr-1.5 transition-colors hover:bg-accent/30',
        containsSelection && 'bg-accent hover:bg-accent',
        className
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-l-xl rounded-r-md py-1.5 pl-2 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset"
      >
        <GroupHeaderIcon
          isDirectory={group.isDirectory ?? false}
          expanded={expanded}
          color={group.projectInfo!.color}
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
        {!expanded && <CollapsedGroupSummary workspaces={group.workspaces} />}
      </button>
      <GroupHeaderAction group={group} groupProject={groupProject} />
    </div>
  );
});

/** What a collapsed header says about the workspaces it hides: who needs you, and how many. */
function CollapsedGroupSummary({ workspaces }: { workspaces: Workspace[] }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
      <GroupAttentionSummary workspaces={workspaces} />
      <span className="text-2xs text-muted-foreground tabular-nums">
        {workspaces.length}
        <span className="sr-only">{workspaces.length === 1 ? ' workspace' : ' workspaces'}</span>
      </span>
    </span>
  );
}

/**
 * The Pinned shelf's header, which collapses it as a project's header does its group, and is laid
 * out like one so the sections down the sidebar read as one set. It has no action, so its toggle
 * runs the full row.
 */
function PinnedShelfHeader({
  workspaces,
  expanded,
  containsSelection,
  onToggle,
}: {
  workspaces: Workspace[];
  expanded: boolean;
  /** The selected workspace is hidden on the collapsed shelf. */
  containsSelection: boolean;
  onToggle: () => void;
}) {
  return (
    <h3
      data-group-header=""
      data-contains-selection={containsSelection || undefined}
      className={cn(
        'flex rounded-xl text-[13px] transition-colors hover:bg-accent/30',
        containsSelection && 'bg-accent hover:bg-accent'
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-xl py-1.5 pr-1.5 pl-2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset"
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          <PushPin
            aria-hidden="true"
            weight="bold"
            className={cn(
              'size-3.5 text-muted-foreground transition-opacity',
              !expanded && 'opacity-60'
            )}
          />
        </span>
        <span className="font-semibold tracking-normal text-foreground">Pinned</span>
        {!expanded && <CollapsedGroupSummary workspaces={workspaces} />}
      </button>
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

/**
 * Who leads their group in the Inbox, while it's on; null while it's off. Each look builds on the
 * last, so a workspace keeps the place it joined at.
 */
function useInboxEntries(
  enabled: boolean,
  workspaces: Workspace[],
  selectedWorkspaceId: string | null
): ReadonlyMap<string, NeedsYouEntry> | null {
  const previous = useRef<ReadonlyMap<string, NeedsYouEntry> | null>(null);
  const entries = useMemo(
    () =>
      enabled ? trackInbox(previous.current, workspaces, selectedWorkspaceId, Date.now()) : null,
    [enabled, workspaces, selectedWorkspaceId]
  );
  useEffect(() => {
    // Until the workspaces load, the next look is still the first.
    previous.current = workspaces.length > 0 ? entries : null;
  }, [entries, workspaces]);
  return entries;
}

/** Drops each workspace where a move says, as a drag would, reading the order each left behind. */
function applyMoves(
  moves: WorkspaceMove[],
  reorderWorkspace: (workspaceId: string, newOrder: number) => Promise<void>
): void {
  for (const move of moves) {
    // Each reorder updates the store at once, so the next move sees the order it left.
    const { workspaces } = useWorkspacesStore.getState();
    const workspace = workspaces.find((w) => w.id === move.workspaceId);
    const target = workspaces.find((w) => w.id === move.targetId);
    if (!workspace || !target) continue;
    const oldOrder = workspace.order ?? 0;
    const newOrder = getDropOrder(oldOrder, target.order ?? 0, move.position);
    if (newOrder !== oldOrder) void reorderWorkspace(move.workspaceId, newOrder);
  }
}

/**
 * In the Inbox, a workspace seen to and left goes to the top of the workspaces below the line
 * rather than back to its old place, so the last handled leads the rest: it's moved in the manual
 * order, as if dragged, before the list paints.
 */
function usePlaceLeftInbox(
  inbox: ReadonlyMap<string, NeedsYouEntry> | null,
  groups: WorkspaceGroup[],
  reorderWorkspace: (workspaceId: string, newOrder: number) => Promise<void>
): void {
  const previousInbox = useRef<ReadonlyMap<string, NeedsYouEntry> | null>(null);
  useLayoutEffect(() => {
    const before = previousInbox.current;
    previousInbox.current = inbox;
    if (!inbox || !before) return;
    const moves = groups.flatMap((group) => {
      const left = new Set(
        group.workspaces.filter((w) => before.has(w.id) && !inbox.has(w.id)).map((w) => w.id)
      );
      return left.size > 0 ? placeLeftInbox(group.workspaces, inbox, left) : [];
    });
    if (moves.length > 0) applyMoves(moves, reorderWorkspace);
  }, [inbox, groups, reorderWorkspace]);
}

/** The line under a group's Inbox, between it and the workspaces that don't need the user. */
function InboxDivider() {
  return (
    <div role="separator" aria-label="End of Inbox" className="px-2.5 py-1">
      <div className="h-px bg-border/60" />
    </div>
  );
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
  onPanel,
  onToggle,
}: {
  label: string;
  icon: Icon;
  count: number;
  expanded: boolean;
  /** The shelf shows cards, so it sits on a panel this header titles. */
  onPanel: boolean;
  onToggle: () => void;
}) {
  // Without cards, it's a quiet line under the projects. With them, it heads their panel as a
  // project's header does, so it reads as the panel's title and is as easy to hit to close.
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className={cn(
        'flex w-full items-center rounded-xl py-1.5 pr-2 transition-colors hover:bg-accent/30 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden',
        onPanel
          ? 'gap-2 pl-2 text-sm focus-visible:ring-inset'
          : 'gap-1.5 pl-2.5 text-2xs font-medium text-muted-foreground hover:text-foreground'
      )}
    >
      <span className={cn('flex shrink-0 items-center justify-center', onPanel && 'size-5')}>
        <ShelfIcon
          aria-hidden="true"
          weight="bold"
          className={onPanel ? 'size-3.5 text-muted-foreground' : 'size-3'}
        />
      </span>
      <span className={cn(onPanel && 'font-semibold tracking-normal text-foreground')}>
        {label}
      </span>
      <span
        className={cn(
          'ml-auto flex items-center gap-1 tabular-nums',
          expanded && 'text-2xs text-muted-foreground'
        )}
      >
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

// Docked at the bottom of the pane, as wide as the panels above it; one shelf opens at a time,
// growing up to half of it and scrolling. A shelf showing cards sits on a panel, as a project does,
// so it stands apart from the closed shelves' headers.
function ShelfDock({
  shelves,
  onToggle,
  onOpenOverview,
  onEmptyTrash,
  renderCard,
}: {
  shelves: Shelf[];
  onToggle: (shelf: Shelf) => void;
  onOpenOverview: () => void;
  onEmptyTrash: () => void;
  renderCard: (workspace: Workspace) => React.ReactNode;
}) {
  if (shelves.length === 0) return null;
  return (
    <div className="flex max-h-1/2 shrink-0 flex-col border-t border-border/20 pt-1 pr-0.5 pl-2.5">
      {shelves.map((shelf) => (
        <section
          key={shelf.key}
          aria-label={shelf.label}
          // Only a shelf showing cards gives up height; a closed one keeps its header.
          className={cn(
            'flex flex-col',
            shelf.shown.length > 0 ? ['my-1 min-h-0', SIDEBAR_PANEL_CLASS] : 'shrink-0'
          )}
        >
          <ShelfHeader
            label={shelf.label}
            icon={shelf.icon}
            count={shelf.count}
            expanded={shelf.open}
            onPanel={shelf.shown.length > 0}
            onToggle={() => onToggle(shelf)}
          />
          {shelf.shown.length > 0 && (
            <ScrollArea
              type="scroll"
              className="min-h-0 [&_[data-radix-scroll-area-viewport]>div]:!block [&>[data-radix-scroll-area-scrollbar]]:w-1"
            >
              {/* Room under the last card for the selected card's shadow, which the viewport clips. */}
              <div className="space-y-0.5 pb-1">
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
            <div className="flex shrink-0 items-center justify-between gap-2 pr-1 pb-1 pl-2.5 text-2xs text-muted-foreground">
              Deleted after {TRASH_RETENTION_DAYS} days
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2.5 text-2xs text-muted-foreground hover:text-error"
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
  const inboxMode = useConfigStore((s) => s.config?.inboxMode) === true;
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
  const [dropTarget, setDropTarget] = useState<WorkspaceDropTarget | null>(null);
  const dropTargetRef = useRef<WorkspaceDropTarget | null>(null);

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

  const inboxEntries = useInboxEntries(inboxMode, workspaces, selectedWorkspaceId);

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
        if (inboxEntries) group.workspaces = sortInboxFirst(group.workspaces, inboxEntries);
      }

      return groups;
    },
    [getGroupKey, getProjectInfo, projectMap, inboxEntries]
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
        workspaces: inboxEntries
          ? sortInboxFirst(sections.grouped, inboxEntries)
          : sections.grouped,
      },
    ];
  }, [
    sections.pinned,
    sections.working,
    sections.tagged,
    sections.grouped,
    groupWorkspaces,
    grouping,
    inboxEntries,
  ]);

  usePlaceLeftInbox(inboxEntries, allActiveGroups, reorderWorkspace);

  // Filter out hidden project groups
  const workspaceGroups = useMemo(
    () => allActiveGroups.filter((g) => !g.projectId || !hiddenProjectIds.has(g.projectId)),
    [allActiveGroups, hiddenProjectIds]
  );

  // Refs for stable drag callbacks, read at call time. The drag handlers own draggedIdRef, so
  // drag events between a drag starting and its render see it. The rest are updated after commit
  // (not during render) for React 18 StrictMode safety.
  const draggedIdRef = useRef<string | null>(null);
  const visibleWorkspacesRef = useRef(visibleWorkspaces);
  useEffect(() => {
    visibleWorkspacesRef.current = visibleWorkspaces;
  });

  // Drag handlers (stable references — safe to pass through React.memo)
  const handleDragStart = useCallback((workspaceId: string) => {
    draggedIdRef.current = workspaceId;
    setDraggedId(workspaceId);
  }, []);

  const showDropTarget = useCallback((target: WorkspaceDropTarget | null) => {
    const current = dropTargetRef.current;
    if (current?.workspaceId === target?.workspaceId && current?.position === target?.position) {
      return;
    }
    dropTargetRef.current = target;
    setDropTarget(target);
  }, []);

  const handleDragEnd = useCallback(() => {
    draggedIdRef.current = null;
    setDraggedId(null);
    showDropTarget(null);
  }, [showDropTarget]);

  // A workspace dragged over the list it's in (the Pinned shelf, or its group) goes to the slot
  // nearest the pointer. Any other list refuses it. True when this list took the drag.
  const handleCardListDragOver = useCallback(
    (e: React.DragEvent<HTMLElement>): boolean => {
      const currentDraggedId = draggedIdRef.current;
      if (!currentDraggedId) return false;
      const cards = readDraggableCards(e.currentTarget);
      if (!cards.some((card) => card.id === currentDraggedId)) return false;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showDropTarget(getWorkspaceDropTarget(cards, currentDraggedId, e.clientY));
      return true;
    },
    [showDropTarget]
  );

  // Off the dragged workspace's list, a release leaves it where it was, so no line shows.
  const handleListAreaDragOver = useCallback(
    (e: React.DragEvent) => {
      if (draggedIdRef.current && !e.defaultPrevented) showDropTarget(null);
    },
    [showDropTarget]
  );
  const handleListAreaDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) showDropTarget(null);
    },
    [showDropTarget]
  );

  const handleCardListDrop = useCallback(
    (e: React.DragEvent<HTMLElement>): boolean => {
      const currentDraggedId = draggedIdRef.current;
      if (!currentDraggedId) return false;
      if (!readDraggableCards(e.currentTarget).some((card) => card.id === currentDraggedId)) {
        return false;
      }
      e.preventDefault();
      const target = dropTargetRef.current;
      const ws = visibleWorkspacesRef.current;
      const draggedWorkspace = ws.find((w) => w.id === currentDraggedId);
      const targetWorkspace = target && ws.find((w) => w.id === target.workspaceId);
      if (target && draggedWorkspace && targetWorkspace) {
        const oldOrder = draggedWorkspace.order ?? 0;
        const newOrder = getDropOrder(oldOrder, targetWorkspace.order ?? 0, target.position);
        if (newOrder !== oldOrder) {
          void reorderWorkspace(currentDraggedId, newOrder);
        }
      }
      handleDragEnd();
      return true;
    },
    [reorderWorkspace, handleDragEnd]
  );

  // Group drag handlers
  const handleGroupDragStart = useCallback(
    (groupKey: string) => {
      // A card that left its list mid-drag, as one a turn sends to the Working shelf does, never
      // got its dragend; its drag mustn't take this one's drop.
      handleDragEnd();
      setDraggedGroupKey(groupKey);
    },
    [handleDragEnd]
  );

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
  const pinnedExpanded = !collapsedGroupKeys.has(PINNED_GROUP_KEY);

  // Full ordered IDs — used for shift-click range selection and Cmd+Arrow keyboard
  // navigation (via ShortcutProvider). Excludes workspaces inside collapsed groups so
  // neither action can silently select a workspace the user can't see.
  // Stabilized: only produces a new reference when the actual IDs change,
  // so memoized WorkspaceCards don't re-render on unrelated workspace updates.
  const prevOrderedIdsRef = useRef<string[]>([]);
  const allOrderedIds = useMemo(() => {
    const next = [
      ...(pinnedExpanded ? sections.pinned.map((w) => w.id) : []),
      ...getVisibleOrderedWorkspaceIds(workspaceGroups, isGroupExpanded),
      // Opening a workspace in the Trash restores it, so the arrow keys pass the Trash shelf by.
      ...shelves.filter((s) => s.key !== 'trash').flatMap((s) => s.shown.map((w) => w.id)),
    ];
    const prev = prevOrderedIdsRef.current;
    if (prev.length === next.length && prev.every((id, i) => id === next[i])) {
      return prev;
    }
    return next;
  }, [sections.pinned, pinnedExpanded, workspaceGroups, isGroupExpanded, shelves]);
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

  // Dragging near the list's top or bottom edge scrolls it, to reach cards and groups out of view.
  const listScrollRef = useRef<HTMLDivElement>(null);
  useDragAutoScroll(listScrollRef, !paneEmptyReason);

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

  // A group's cards, with a line under its Inbox when cards that don't need the user follow it.
  // The Inbox orders itself, so only the cards below the line can be dragged.
  const renderGroupCards = (
    workspaces: Workspace[],
    renderCard: (workspace: Workspace, dndEnabled: boolean) => React.ReactNode
  ): React.ReactNode[] => {
    const cards = workspaces.map((workspace) =>
      renderCard(workspace, !selectionMode && !inboxEntries?.has(workspace.id))
    );
    const inboxCount = inboxEntries
      ? workspaces.filter((workspace) => inboxEntries.has(workspace.id)).length
      : 0;
    if (inboxCount === 0 || inboxCount === workspaces.length) return cards;
    return [
      ...cards.slice(0, inboxCount),
      <InboxDivider key="inbox-divider" />,
      ...cards.slice(inboxCount),
    ];
  };

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
          ref={listScrollRef}
          type="scroll"
          className={cn(
            'min-h-0 flex-1 [&>[data-radix-scroll-area-scrollbar]]:w-1 [&>[data-radix-scroll-area-viewport]]:scroll-fade-y [&_[data-radix-scroll-area-viewport]>div]:!block',
            selectionMode && 'select-none'
          )}
        >
          {/* Little padding on the right: the panes' 6px gutter beyond the sidebar's edge makes up
              the rest, so a panel sits as far from the pane beside it as the pane from the drawer. */}
          <div
            className="py-2.5 pr-0.5 pl-2.5"
            onDragOver={handleListAreaDragOver}
            onDragLeave={handleListAreaDragLeave}
          >
            {sections.pinned.length > 0 && (
              <section
                aria-label="Pinned"
                className={cn(SIDEBAR_PANEL_CLASS, workspaceGroups.length > 0 && 'mb-2.5')}
                onDragOver={handleCardListDragOver}
                onDrop={handleCardListDrop}
              >
                <PinnedShelfHeader
                  workspaces={sections.pinned}
                  expanded={pinnedExpanded}
                  containsSelection={
                    !pinnedExpanded && sections.pinned.some((w) => w.id === selectedWorkspaceId)
                  }
                  onToggle={() => toggleWorkspaceGroupCollapsed(PINNED_GROUP_KEY)}
                />
                {pinnedExpanded && (
                  <div className="relative space-y-0.5 [clip-path:inset(-4px_-100vw)]">
                    {sections.pinned.map((workspace) =>
                      renderWorkspaceCard(workspace, getProjectInfo(workspace))
                    )}
                  </div>
                )}
              </section>
            )}
            {workspaceGroups.map((group, index) => {
              const isGroupDraggable = !selectionMode;
              const isGroupBeingDragged = draggedGroupKey === group.key;

              // Groups without project info, and the ungrouped list: cards on a panel with no
              // header, each naming its project
              if (!group.projectInfo) {
                return (
                  <div
                    key={group.key}
                    className={cn(SIDEBAR_PANEL_CLASS, index > 0 && 'mt-2.5')}
                    onDragOver={handleCardListDragOver}
                    onDrop={handleCardListDrop}
                  >
                    <div className="relative space-y-0.5 [clip-path:inset(-4px_-100vw)]">
                      {renderGroupCards(group.workspaces, (workspace, dndEnabled) =>
                        renderWorkspaceCard(
                          workspace,
                          getProjectInfo(workspace),
                          undefined,
                          dndEnabled
                        )
                      )}
                    </div>
                  </div>
                );
              }

              // Groups with project info: always show header + indented children
              const expanded = isGroupExpanded(group);
              const containsSelection =
                !expanded && group.workspaces.some((w) => w.id === selectedWorkspaceId);
              const groupProject = group.projectId ? projectMap.get(group.projectId) : undefined;
              const [unaddedSshWorkspace] = sshWorkspacesWithoutProject(group);

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
                    SIDEBAR_PANEL_CLASS,
                    index > 0 && 'mt-2.5',
                    isGroupBeingDragged && 'opacity-50',
                    getDropIndicatorClass(group.key, groupDropTarget)
                  )}
                  onDragOver={(e) => {
                    if (!handleCardListDragOver(e)) dragHandlers.onDragOver?.(e);
                  }}
                  onDrop={(e) => {
                    if (!handleCardListDrop(e)) dragHandlers.onDrop?.(e);
                  }}
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
                  {/* Shown collapsed too, so workspaces synced in for a repository not added here
                      stand out until the user adds it. */}
                  {unaddedSshWorkspace && (
                    <SshRepositoryNotAProjectCallout
                      workspace={unaddedSshWorkspace}
                      repoName={group.projectInfo.name}
                      className="mx-1 mt-0.5 mb-1"
                    />
                  )}
                  {expanded && (
                    // The clip keeps a selection gliding in from another group from sweeping
                    // across the gap and this group's header.
                    <div className="relative space-y-0.5 [clip-path:inset(-4px_-100vw)]">
                      {renderGroupCards(group.workspaces, (workspace, dndEnabled) =>
                        renderWorkspaceCard(workspace, null, group.isDirectory, dndEnabled)
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
