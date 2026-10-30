import { Cloud, DesktopTower, DotsSixVertical, Funnel, GearSix } from '@phosphor-icons/react';
import { useMemo, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { ProjectMark } from '@/components/projects/ProjectMark';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuSegmentItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuSwitchItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ignoreFocusAfterPointer } from '@/components/ui/icon-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useWorkspaceHostOptions } from '@/components/workspaces/WorkspaceHostFilterMenu';
import { ToneDot, UntaggedDot } from '@/components/workspaces/WorkspaceTagMenu';
import { getProjectColor } from '@/lib/project-colors';
import { getProjectMoveIndex } from '@/lib/project-order';
import { cn } from '@/lib/utils';
import {
  getWorkspaceHostId,
  isWorkspaceHostVisible,
  LOCAL_WORKSPACE_HOST_ID,
} from '@/lib/workspace-host';
import { useWorkspaceTags } from '@/lib/workspace-tags';
import { useConfigStore } from '@/stores/config.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isHiddenByHideStopped, type Project, type Workspace } from '@/types';

import {
  getWorkspaceTagOptions,
  UNTAGGED_WORKSPACE_TAG_KEY,
} from '../../../shared/lib/workspace-tags';

import type { WorkspaceGrouping } from '../../../shared/lib/workspace-grouping';

const countTextClass = 'text-[11px] text-muted-foreground tabular-nums';
const countClass = `ml-auto pl-4 ${countTextClass}`;

/**
 * Shown on the highlighted row of a list with others: lists only this row's workspaces, by
 * unchecking every other row. Not focusable, so the arrow keys keep moving between rows.
 */
function OnlyButton({ name, onOnly }: { name: string; onOnly: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`Show only ${name}`}
      className="hidden rounded-sm bg-foreground/10 px-1.5 text-[11px] leading-4 text-foreground group-data-highlighted:inline-block hover:bg-foreground/16"
      // Keeps focus, and with it the highlight that shows this button, on the row.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        // The row would toggle its own checkbox.
        event.stopPropagation();
        onOnly();
      }}
    >
      Only
    </button>
  );
}

/** A row's count, with its Only button before it while there are other rows to uncheck. */
function CountWithOnly({
  name,
  count,
  onOnly,
}: {
  name: string;
  count: number;
  onOnly: (() => void) | null;
}) {
  return (
    <span className="ml-auto flex items-center gap-1.5 pl-4">
      {onOnly && <OnlyButton name={name} onOnly={onOnly} />}
      <span className={countTextClass}>{count}</span>
    </span>
  );
}

/**
 * What the filters hide in this window, and which filters "Show all workspaces" has to clear.
 * Projects and hosts hidden only for another window stay hidden. Hiding stopped or working
 * workspaces hides nothing: it moves them to the Stopped or Working shelf.
 */
function summarizeHidden(
  windowWorkspaces: Workspace[],
  hiddenProjectIds: ReadonlySet<string>,
  hiddenWorkspaceHostIds: ReadonlySet<string>
) {
  const projectIds = new Set<string>();
  const hostIds = new Set<string>();
  let count = 0;
  let stopped = 0;
  for (const workspace of windowWorkspaces) {
    if (isHiddenByHideStopped(workspace)) stopped++;
    const projectId = workspace.projectId;
    const hiddenByProject = !!projectId && hiddenProjectIds.has(projectId);
    const hiddenByHost = !isWorkspaceHostVisible(workspace, hiddenWorkspaceHostIds);
    if (!hiddenByProject && !hiddenByHost) continue;
    count++;
    if (hiddenByProject) projectIds.add(projectId);
    if (hiddenByHost) hostIds.add(getWorkspaceHostId(workspace));
  }
  return { count, stopped, projectIds, hostIds };
}

/** Projects with workspaces in this window, in sidebar order, with their workspace counts. */
function getProjectOptions(projects: Project[], windowWorkspaces: Workspace[]) {
  const counts = new Map<string, number>();
  for (const workspace of windowWorkspaces) {
    if (workspace.projectId) {
      counts.set(workspace.projectId, (counts.get(workspace.projectId) ?? 0) + 1);
    }
  }
  const projectOptions = [...projects]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter((project) => counts.has(project.id))
    .map((project) => ({
      id: project.id,
      name: project.name,
      color: project.color || getProjectColor(project.name),
      icon: project.icon,
      count: counts.get(project.id) ?? 0,
    }));
  // Workspaces outside a project, such as opened folders, form groups of their own.
  const hasOtherGroups = windowWorkspaces.some(
    (w) => !w.projectId || !projectOptions.some((p) => p.id === w.projectId)
  );
  return { projectOptions, hasOtherGroups };
}

/** The tag rows this window's workspaces offer, Untagged among them, and whether any is unchecked. */
function useTagFilterOptions(windowWorkspaces: Workspace[]) {
  const hiddenWorkspaceTags = useWorkspacesStore((s) => s.hiddenWorkspaceTags);
  const tags = useWorkspaceTags();
  const tagOptions = useMemo(
    () => getWorkspaceTagOptions(tags, windowWorkspaces),
    [tags, windowWorkspaces]
  );
  const untaggedCount = windowWorkspaces.filter((w) => !w.tag).length;
  const untaggedHidden = hiddenWorkspaceTags.has(UNTAGGED_WORKSPACE_TAG_KEY);
  const offeredTagKeys = [
    ...tagOptions.map((tag) => tag.key),
    ...(untaggedCount > 0 || untaggedHidden ? [UNTAGGED_WORKSPACE_TAG_KEY] : []),
  ];
  return {
    tagOptions,
    untaggedCount,
    offeredTagKeys,
    // Hidden untagged workspaces keep the section, so they can be shown again once no tag is in use.
    showTags: tagOptions.length > 0 || untaggedHidden,
    tagsFiltered: offeredTagKeys.some((key) => hiddenWorkspaceTags.has(key)),
  };
}

/**
 * The sidebar's filter and grouping menu: how the list is grouped and its cards look, which
 * projects, hosts and tags it lists, and what folds away at the bottom. The trigger counts the
 * workspaces the filters hide in this window.
 */
export function SidebarFilterMenu() {
  const { workspaces, grouping, hiddenProjectIds, hiddenWorkspaceHostIds } = useWorkspacesStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      grouping: s.grouping,
      hiddenProjectIds: s.hiddenProjectIds,
      hiddenWorkspaceHostIds: s.hiddenWorkspaceHostIds,
    }))
  );
  const { projects } = useProjectsStore();
  const { windowId: currentWindowId } = useWindowStore();
  const hostOptions = useWorkspaceHostOptions();

  const windowWorkspaces = useMemo(
    () => workspaces.filter((w) => w.windowId === currentWindowId && w.status === 'active'),
    [workspaces, currentWindowId]
  );

  const hidden = useMemo(
    () => summarizeHidden(windowWorkspaces, hiddenProjectIds, hiddenWorkspaceHostIds),
    [windowWorkspaces, hiddenProjectIds, hiddenWorkspaceHostIds]
  );
  const hiddenCount = hidden.count;

  const { projectOptions, hasOtherGroups } = useMemo(
    () => getProjectOptions(projects, windowWorkspaces),
    [projects, windowWorkspaces]
  );
  const tagFilter = useTagFilterOptions(windowWorkspaces);
  const { showTags, tagsFiltered, offeredTagKeys } = tagFilter;

  const showProjects =
    projectOptions.length + (hasOtherGroups ? 1 : 0) > 1 ||
    projectOptions.some((p) => hiddenProjectIds.has(p.id));
  const showHosts = hostOptions.length > 1;

  return (
    <DropdownMenu>
      <FilterTrigger hiddenCount={hiddenCount} tagsFiltered={tagsFiltered} />
      <DropdownMenuContent align="end" side="top" className="max-w-72 min-w-60">
        <div className="flex items-center">
          <GroupingRow />
          <CardOptionsSubmenu />
        </div>
        {(showProjects || showHosts || showTags) && <DropdownMenuSeparator />}
        {showProjects && (
          <ProjectFilterItems
            projectOptions={projectOptions}
            reorderable={grouping === 'project'}
          />
        )}
        {showHosts && (
          <>
            <DropdownMenuLabel>Hosts</DropdownMenuLabel>
            <HostFilterItems hostOptions={hostOptions} />
          </>
        )}
        {showTags && <TagFilterItems {...tagFilter} />}
        <DropdownMenuSeparator />
        <FoldAwayItems stoppedCount={hidden.stopped} />
        <ShowAllItem hidden={hidden} tagsFiltered={tagsFiltered} offeredTagKeys={offeredTagKeys} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Lists every workspace again: filters set here come off, and nothing stays folded away. Offered
 * while anything is hidden, filtered by tag or folded.
 */
function ShowAllItem({
  hidden,
  tagsFiltered,
  offeredTagKeys,
}: {
  hidden: ReturnType<typeof summarizeHidden>;
  tagsFiltered: boolean;
  offeredTagKeys: string[];
}) {
  const unhideProjectGroups = useWorkspacesStore((s) => s.unhideProjectGroups);
  const toggleWorkspaceHostVisibility = useWorkspacesStore((s) => s.toggleWorkspaceHostVisibility);
  const hiddenWorkspaceTags = useWorkspacesStore((s) => s.hiddenWorkspaceTags);
  const setHiddenWorkspaceTags = useWorkspacesStore((s) => s.setHiddenWorkspaceTags);
  const hideWorking = useWorkspacesStore((s) => s.hideWorking);
  const setHideWorking = useWorkspacesStore((s) => s.setHideWorking);
  const hideStopped = useWorkspacesStore((s) => s.hideStopped);
  const setHideStopped = useWorkspacesStore((s) => s.setHideStopped);
  // Folding stopped workspaces away with none here folds nothing.
  const folded = hideWorking || (hideStopped && hidden.stopped > 0);
  if (hidden.count === 0 && !tagsFiltered && !folded) return null;

  const showAll = () => {
    if (hideWorking) setHideWorking(false);
    if (hideStopped) setHideStopped(false);
    if (hidden.projectIds.size > 0) unhideProjectGroups(hidden.projectIds);
    for (const hostId of hidden.hostIds) toggleWorkspaceHostVisibility(hostId);
    if (tagsFiltered) {
      // Tags this window doesn't offer keep their state, as they're hidden for other windows.
      const offered = new Set(offeredTagKeys);
      setHiddenWorkspaceTags([...hiddenWorkspaceTags].filter((key) => !offered.has(key)));
    }
  };

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        aria-label={
          hidden.count > 0 ? `Show all workspaces (${hidden.count} hidden)` : 'Show all workspaces'
        }
        onSelect={showAll}
      >
        Show all workspaces
        {hidden.count > 0 && <span className={countClass}>{hidden.count} hidden</span>}
      </DropdownMenuItem>
    </>
  );
}

/** Group by project or list every workspace together, as two segments on one row. */
function GroupingRow() {
  const grouping = useWorkspacesStore((s) => s.grouping);
  const setGrouping = useWorkspacesStore((s) => s.setGrouping);
  return (
    <DropdownMenuRadioGroup
      aria-label="Group workspaces"
      value={grouping}
      onValueChange={(v) => setGrouping(v as WorkspaceGrouping)}
      className="flex min-w-0 flex-1 items-center py-1 pr-1 pl-2 text-[12px] leading-[17px] font-[450]"
    >
      <span className="pr-2.5">Group</span>
      <span className="flex gap-0.5 rounded-md bg-foreground/6 p-0.5">
        <DropdownMenuSegmentItem value="project" onSelect={(event) => event.preventDefault()}>
          By project
        </DropdownMenuSegmentItem>
        <DropdownMenuSegmentItem value="none" onSelect={(event) => event.preventDefault()}>
          One list
        </DropdownMenuSegmentItem>
      </span>
    </DropdownMenuRadioGroup>
  );
}

/**
 * How workspace cards look, as in Settings, so it's found while looking at the list. Behind a gear
 * on the Group row, so it costs the menu no height.
 */
function CardOptionsSubmenu() {
  const alwaysShowBranch = useConfigStore(
    (s) => s.config?.alwaysShowBranchNameInWorkspaceCards !== false
  );
  const compact = useConfigStore((s) => s.config?.compactWorkspaceList === true);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        hideCaret
        aria-label="Workspace card options"
        title="Workspace card options"
        className="mr-1 shrink-0 p-1 text-muted-foreground"
      >
        <GearSix className="size-3.5" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuSwitchItem
          checked={alwaysShowBranch}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(checked) =>
            void updateConfig({ alwaysShowBranchNameInWorkspaceCards: checked })
          }
        >
          <span className="truncate">Always show branch names</span>
        </DropdownMenuSwitchItem>
        <DropdownMenuSwitchItem
          checked={compact}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(checked) => void updateConfig({ compactWorkspaceList: checked })}
        >
          <span className="truncate">Compact list</span>
        </DropdownMenuSwitchItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** Switched on, working or stopped workspaces leave the list for a folded section at its end. */
function FoldAwayItems({ stoppedCount }: { stoppedCount: number }) {
  const hideWorking = useWorkspacesStore((s) => s.hideWorking);
  const setHideWorking = useWorkspacesStore((s) => s.setHideWorking);
  const hideStopped = useWorkspacesStore((s) => s.hideStopped);
  const setHideStopped = useWorkspacesStore((s) => s.setHideStopped);
  return (
    <>
      <DropdownMenuLabel>Fold away at the bottom</DropdownMenuLabel>
      {/* Offered with nothing working too, so it can be turned on before agents start. The
          Working section counts what it holds. */}
      <DropdownMenuSwitchItem
        checked={hideWorking}
        onSelect={(event) => event.preventDefault()}
        onCheckedChange={setHideWorking}
      >
        <span className="truncate">Workspaces with a working agent</span>
      </DropdownMenuSwitchItem>
      {stoppedCount > 0 && (
        <DropdownMenuSwitchItem
          aria-label={`Stopped workspaces (${stoppedCount})`}
          checked={hideStopped}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={setHideStopped}
        >
          <span className="truncate">Stopped workspaces</span>
          <span className={countClass}>{stoppedCount}</span>
        </DropdownMenuSwitchItem>
      )}
    </>
  );
}

const shownOf = (shown: number, total: number) => `${shown} of ${total}`;

/** Counts what the filters hide, and lights up while tags are filtered, as that hides nothing. */
function FilterTrigger({
  hiddenCount,
  tagsFiltered,
}: {
  hiddenCount: number;
  tagsFiltered: boolean;
}) {
  const isFiltered = hiddenCount > 0;
  const label = isFiltered
    ? `Filter workspaces (${hiddenCount} hidden)`
    : tagsFiltered
      ? 'Filter workspaces (filtered by tag)'
      : 'Filter workspaces';
  return (
    <Tooltip>
      <TooltipTrigger asChild onFocus={ignoreFocusAfterPointer}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={label}
            className={cn(
              'h-6 shrink-0 gap-1 text-xs text-muted-foreground tabular-nums hover:text-foreground',
              isFiltered ? 'px-1.5' : 'w-6 px-0',
              (isFiltered || tagsFiltered) && 'text-foreground'
            )}
          >
            <Funnel className="size-3.5" />
            {isFiltered && <span className="text-[11px] opacity-70">{hiddenCount}</span>}
          </Button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ProjectFilterItems({
  projectOptions,
  reorderable,
}: {
  projectOptions: ReturnType<typeof getProjectOptions>['projectOptions'];
  /** Project order only shows while workspaces are grouped by project. */
  reorderable: boolean;
}) {
  const hiddenProjectIds = useWorkspacesStore((s) => s.hiddenProjectIds);
  const hideProjectGroup = useWorkspacesStore((s) => s.hideProjectGroup);
  const unhideProjectGroup = useWorkspacesStore((s) => s.unhideProjectGroup);
  const projects = useProjectsStore((s) => s.projects);
  const reorderProject = useProjectsStore((s) => s.reorderProject);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    position: 'before' | 'after';
  } | null>(null);
  const canReorder = reorderable && projectOptions.length > 1;

  const hideProjectGroups = useWorkspacesStore((s) => s.hideProjectGroups);
  const showOnly = (projectId: string) => {
    unhideProjectGroup(projectId);
    hideProjectGroups(projectOptions.filter((p) => p.id !== projectId).map((p) => p.id));
  };

  const moveProject = (sourceId: string, targetId: string, position: 'before' | 'after') => {
    const index = getProjectMoveIndex(projects, sourceId, targetId, position);
    if (index !== null) void reorderProject(sourceId, index);
  };

  const endDrag = () => {
    setDraggingId(null);
    setDropTarget(null);
  };

  const shownCount = projectOptions.filter((p) => !hiddenProjectIds.has(p.id)).length;
  const label = (
    <DropdownMenuLabel className="flex items-baseline">
      Projects
      <span className="ml-auto pl-4 font-normal">
        {shownCount < projectOptions.length
          ? shownOf(shownCount, projectOptions.length)
          : canReorder && 'Drag to reorder'}
      </span>
    </DropdownMenuLabel>
  );

  const rows = projectOptions.map((project, index) => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      // Stops the menu from also moving the highlight.
      event.preventDefault();
      // Each move saves every shifted project, so held keys would start overlapping saves.
      if (event.repeat) return;
      const up = event.key === 'ArrowUp';
      const neighbour = projectOptions[index + (up ? -1 : 1)];
      if (neighbour) moveProject(project.id, neighbour.id, up ? 'before' : 'after');
    };
    const getDropPosition = (event: DragEvent) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    };
    const onDragOver = (event: DragEvent) => {
      if (!draggingId) return;
      event.preventDefault();
      const position = getDropPosition(event);
      if (dropTarget?.id !== project.id || dropTarget.position !== position) {
        setDropTarget({ id: project.id, position });
      }
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDropTarget((target) => (target?.id === project.id ? null : target));
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      // The drop event's position, since the last dragover may not have rendered yet.
      if (draggingId) moveProject(draggingId, project.id, getDropPosition(event));
      endDrag();
    };
    const dropPosition = dropTarget?.id === project.id ? dropTarget.position : null;
    return (
      <DropdownMenuCheckboxItem
        key={project.id}
        aria-label={`${project.name} (${project.count})`}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        className={cn(
          'group',
          canReorder && 'pr-1',
          draggingId === project.id && 'opacity-50',
          dropPosition === 'before' && 'shadow-[inset_0_2px_0_0_var(--color-primary)]',
          dropPosition === 'after' && 'shadow-[inset_0_-2px_0_0_var(--color-primary)]'
        )}
        checked={!hiddenProjectIds.has(project.id)}
        onSelect={(event) => event.preventDefault()}
        onCheckedChange={(checked) =>
          checked ? unhideProjectGroup(project.id) : hideProjectGroup(project.id)
        }
        onKeyDown={onKeyDown}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <ProjectMark project={project} />
        <span className="truncate">{project.name}</span>
        <CountWithOnly
          name={project.name}
          count={project.count}
          onOnly={projectOptions.length > 1 ? () => showOnly(project.id) : null}
        />
        {canReorder && (
          <span
            draggable
            title="Drag to reorder"
            data-testid={`drag-project-${project.id}`}
            className="-my-1 flex h-6 w-5 cursor-grab items-center justify-center rounded-sm text-muted-foreground/60 group-data-highlighted:text-muted-foreground hover:bg-foreground/10 hover:text-foreground! active:cursor-grabbing"
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', project.name);
              const row = event.currentTarget.closest('[role="menuitemcheckbox"]');
              if (row) event.dataTransfer.setDragImage(row, 16, 12);
              setDraggingId(project.id);
            }}
            onDragEnd={endDrag}
            // A click without a drag would toggle the project's checkbox.
            onClick={(event) => event.stopPropagation()}
          >
            <DotsSixVertical className="size-3.5" />
          </span>
        )}
      </DropdownMenuCheckboxItem>
    );
  });
  return (
    <>
      {label}
      {rows}
    </>
  );
}

/**
 * Unchecked, a tag's workspaces move to the Filtered shelf, as hidden working ones do. Untagged
 * does the same for workspaces without a tag, so the list can hold just one tag's workspaces.
 */
function TagFilterItems({
  tagOptions,
  untaggedCount,
  offeredTagKeys,
  tagsFiltered,
}: Pick<
  ReturnType<typeof useTagFilterOptions>,
  'tagOptions' | 'untaggedCount' | 'offeredTagKeys' | 'tagsFiltered'
>) {
  const hiddenWorkspaceTags = useWorkspacesStore((s) => s.hiddenWorkspaceTags);
  const toggleWorkspaceTagShown = useWorkspacesStore((s) => s.toggleWorkspaceTagShown);
  const setHiddenWorkspaceTags = useWorkspacesStore((s) => s.setHiddenWorkspaceTags);
  const untaggedHidden = hiddenWorkspaceTags.has(UNTAGGED_WORKSPACE_TAG_KEY);
  // Tags this window doesn't offer keep their state, as they're hidden or shown for other windows.
  const onlyFor = (key: string) =>
    offeredTagKeys.length > 1
      ? () =>
          setHiddenWorkspaceTags(
            [...hiddenWorkspaceTags, ...offeredTagKeys].filter((other) => other !== key)
          )
      : null;
  return (
    <>
      <DropdownMenuLabel className="flex items-baseline">
        Tags
        {tagsFiltered && (
          <span className="ml-auto pl-4 font-normal">
            {shownOf(
              offeredTagKeys.filter((key) => !hiddenWorkspaceTags.has(key)).length,
              offeredTagKeys.length
            )}
          </span>
        )}
      </DropdownMenuLabel>
      {tagOptions.map((tag) => (
        <DropdownMenuCheckboxItem
          key={tag.key}
          aria-label={`${tag.name} (${tag.count})`}
          className="group"
          checked={!hiddenWorkspaceTags.has(tag.key)}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => toggleWorkspaceTagShown(tag.key)}
        >
          <ToneDot tone={tag.tone} />
          <span className="truncate">{tag.name}</span>
          <CountWithOnly name={tag.name} count={tag.count} onOnly={onlyFor(tag.key)} />
        </DropdownMenuCheckboxItem>
      ))}
      {(untaggedCount > 0 || untaggedHidden) && (
        <DropdownMenuCheckboxItem
          aria-label={`Untagged (${untaggedCount})`}
          className="group"
          checked={!untaggedHidden}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => toggleWorkspaceTagShown(UNTAGGED_WORKSPACE_TAG_KEY)}
        >
          <UntaggedDot />
          <span className="truncate">Untagged</span>
          <CountWithOnly
            name="untagged workspaces"
            count={untaggedCount}
            onOnly={onlyFor(UNTAGGED_WORKSPACE_TAG_KEY)}
          />
        </DropdownMenuCheckboxItem>
      )}
    </>
  );
}

function HostFilterItems({
  hostOptions,
}: {
  hostOptions: ReturnType<typeof useWorkspaceHostOptions>;
}) {
  const hiddenWorkspaceHostIds = useWorkspacesStore((s) => s.hiddenWorkspaceHostIds);
  const toggleWorkspaceHostVisibility = useWorkspacesStore((s) => s.toggleWorkspaceHostVisibility);
  return hostOptions.map((host) => (
    <DropdownMenuCheckboxItem
      key={host.id}
      checked={!hiddenWorkspaceHostIds.has(host.id)}
      onSelect={(event) => event.preventDefault()}
      onCheckedChange={() => toggleWorkspaceHostVisibility(host.id)}
    >
      {host.id === LOCAL_WORKSPACE_HOST_ID ? <DesktopTower /> : <Cloud />}
      <span className="truncate">{host.name}</span>
    </DropdownMenuCheckboxItem>
  ));
}
