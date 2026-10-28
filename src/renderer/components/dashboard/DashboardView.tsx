import {
  ArrowLeft,
  PushPin,
  CaretDown,
  CaretRight,
  MagnifyingGlass,
  Plus,
  Square,
  Terminal,
  Trash,
  X,
  XCircle,
} from '@phosphor-icons/react';
import React, {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { ProjectMark } from '@/components/projects/ProjectMark';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { ShortcutHint } from '@/components/ui/kbd';
import { ScrollArea } from '@/components/ui/scroll-area';
import { flashWaitingAgents } from '@/components/workspaces/agent-state';
import { BulkDeleteDialog } from '@/components/workspaces/BulkDeleteDialog';
import {
  BulkTrashDialog,
  needsBulkTrashConfirmation,
} from '@/components/workspaces/BulkTrashDialog';
import { QuickCreateMenu } from '@/components/workspaces/QuickCreateMenu';
import { WorkspaceHostFilterMenu } from '@/components/workspaces/WorkspaceHostFilterMenu';
import { ToneDot, UntaggedDot } from '@/components/workspaces/WorkspaceTagMenu';
import { executeShortcutAction } from '@/lib/shortcut-actions';
import { cn } from '@/lib/utils';
import { getWorkspaceHostId } from '@/lib/workspace-host';
import { useWorkspaceTags } from '@/lib/workspace-tags';
import { useProjectsStore } from '@/stores/projects.store';
import { useShortcutsStore } from '@/stores/shortcuts.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { canStop, type SshHost, type Workspace } from '@/types';

import { UNTAGGED_WORKSPACE_TAG_KEY } from '../../../shared/lib/workspace-tags';

import {
  buildDashboardOverview,
  type DashboardProjectInfo,
  type DashboardSection,
  type DashboardSectionKey,
} from './dashboard-view-model';
import { DashboardRow } from './DashboardRow';

interface DashboardViewProps {
  onNewWorkspaceDialogChange?: (open: boolean) => void;
}

// Set-aside groups start folded; a search opens every group.
const INITIALLY_FOLDED: DashboardSectionKey[] = ['trash'];
// Groups of workspaces nobody touched lately, which can be trashed or deleted together.
const STALE_SECTIONS: ReadonlySet<DashboardSectionKey> = new Set(['week', 'month']);
// Enough rows to fill a tall window. The rest mount in a transition after the first frame, so the
// Overview opens without waiting for every row.
const FIRST_FRAME_ROW_COUNT = 40;

/** A project or tag filter above the list: one of each kind is picked at a time. */
function FilterChip({
  selected,
  onToggle,
  count,
  children,
}: {
  selected: boolean;
  onToggle: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
        selected
          ? 'bg-foreground/10 text-foreground'
          : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
      )}
    >
      {children}
      <span className="text-2xs text-muted-foreground">{count}</span>
    </button>
  );
}

type WorkspacesStoreState = ReturnType<typeof useWorkspacesStore.getState>;

type OverviewRowActions = Pick<
  WorkspacesStoreState,
  | 'selectWorkspace'
  | 'stopWorkspace'
  | 'setWorkspaceTrashed'
  | 'trashWorkspaceWithUndo'
  | 'updateWorkspace'
  | 'deleteWorkspace'
  | 'setPinned'
  | 'markUnread'
  | 'enterSelectionMode'
  | 'toggleWorkspaceSelection'
> & { shiftSelect: (workspaceId: string) => void };

interface OverviewRowProps {
  workspace: Workspace;
  projectInfo: DashboardProjectInfo | null;
  sshHost: SshHost | null;
  searchQuery: string;
  selectionMode: boolean;
  isMultiSelected: boolean;
  /** Changes every minute, so the row's relative time stays fresh. */
  minute: number;
  actions: OverviewRowActions;
}

// The view model builds a new projectInfo each time, so compare what it holds.
function sameOverviewRowProps(prev: OverviewRowProps, next: OverviewRowProps): boolean {
  return (Object.keys(next) as (keyof OverviewRowProps)[]).every((key) =>
    key === 'projectInfo'
      ? prev.projectInfo?.name === next.projectInfo?.name &&
        prev.projectInfo?.color === next.projectInfo?.color &&
        prev.projectInfo?.icon === next.projectInfo?.icon
      : prev[key] === next[key]
  );
}

/**
 * A row that re-renders only when its own workspace or row state changes. Agents update their
 * workspaces several times a second, and re-rendering every row each time kept the Overview busy.
 */
const OverviewRow = memo(function OverviewRow({
  workspace,
  projectInfo,
  sshHost,
  searchQuery,
  selectionMode,
  isMultiSelected,
  actions,
}: OverviewRowProps) {
  const {
    selectWorkspace,
    stopWorkspace,
    setWorkspaceTrashed,
    trashWorkspaceWithUndo,
    updateWorkspace,
    deleteWorkspace,
    setPinned,
    markUnread,
    enterSelectionMode,
    toggleWorkspaceSelection,
    shiftSelect,
  } = actions;
  return (
    <DashboardRow
      workspace={workspace}
      projectInfo={projectInfo}
      sshHost={sshHost}
      searchQuery={searchQuery}
      selectionMode={selectionMode}
      isMultiSelected={isMultiSelected}
      onOpen={() => {
        flashWaitingAgents(workspace);
        void selectWorkspace(workspace.id);
      }}
      onEnterSelectionMode={() => enterSelectionMode(workspace.id)}
      onToggleSelection={() => toggleWorkspaceSelection(workspace.id)}
      onShiftSelect={() => shiftSelect(workspace.id)}
      onToggleTrashed={() => {
        void (workspace.status === 'trashed'
          ? setWorkspaceTrashed(workspace.id, false)
          : trashWorkspaceWithUndo(workspace.id));
      }}
      onStopWorkspace={() => {
        void stopWorkspace(workspace.id);
      }}
      onSaveCustomName={async (customName) => {
        const updates = customName
          ? { customName }
          : { customName: undefined as string | undefined };
        updateWorkspace(
          workspace.id,
          customName ? updates : { ...updates, promptSubmits: undefined }
        );
        const updated = await window.api.updateWorkspace(workspace.id, updates);
        if (!customName) {
          updateWorkspace(workspace.id, {
            customName: updated.customName,
            customNameSource: updated.customNameSource,
            customNameGeneratedAt: updated.customNameGeneratedAt,
            promptSubmitsSinceCustomNameGeneration: updated.promptSubmitsSinceCustomNameGeneration,
            promptSubmits: updated.promptSubmits,
            autoNaming: updated.autoNaming,
          });
        }
      }}
      onRegenerateCustomName={async () => {
        try {
          const updated = await window.api.regenerateWorkspaceName(workspace.id);
          updateWorkspace(workspace.id, updated);
        } catch (err) {
          useToastStore
            .getState()
            .addToast(err instanceof Error ? err.message : 'Failed to regenerate title', 'error');
        }
      }}
      onDeleteWorkspace={async (force, deleteBranch) => {
        await deleteWorkspace(workspace.id, force, deleteBranch);
      }}
      onOpenProjectSettings={() => {
        if (!workspace.projectId) return;
        window.dispatchEvent(
          new CustomEvent('open-project-settings', {
            detail: workspace.projectId,
          })
        );
      }}
      onTogglePinned={() => setPinned(workspace.id, !workspace.pinned)}
      onMarkUnread={() => markUnread(workspace.id)}
      onColorChange={(color) => {
        updateWorkspace(workspace.id, { color });
        void window.api.updateWorkspace(workspace.id, { color });
      }}
    />
  );
}, sameOverviewRowProps);

// Memoized: its parents re-render as the Overview opens, and each pass would re-render every row.
export const DashboardView = memo(function DashboardView({
  onNewWorkspaceDialogChange,
}: DashboardViewProps) {
  const {
    workspaces,
    selectWorkspace,
    stopWorkspace,
    setWorkspaceTrashed,
    trashWorkspaceWithUndo,
    trashWorkspaces,
    updateWorkspace,
    deleteWorkspace,
    setPinned,
    markUnread,
    dashboardFilterProject: filterProjectName,
    dashboardHiddenWorkspaceHostIds,
    showAllDashboardWorkspaceHosts,
    setDashboardFilterProject: setFilterProjectName,
    selectionMode,
    selectedWorkspaceIds,
    enterSelectionMode,
    exitSelectionMode,
    toggleWorkspaceSelection,
    shiftSelectWorkspaces,
    stopSelectedWorkspaces,
    trashSelectedWorkspaces,
    deleteSelectedWorkspaces,
    deleteWorkspaces,
  } = useWorkspacesStore();
  const { projects } = useProjectsStore();
  const sshHosts = useSshHostsStore((state) => state.hosts);
  const { windowId: currentWindowId } = useWindowStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [showPinnedOnly, setShowPinnedOnly] = useState(false);
  const [filterTagKey, setFilterTagKey] = useState<string | null>(null);
  const tags = useWorkspaceTags();
  const [foldedSections, setFoldedSections] = useState<ReadonlySet<DashboardSectionKey>>(
    () => new Set(INITIALLY_FOLDED)
  );
  const [bulkDialog, setBulkDialog] = useState<'trash' | 'delete' | 'empty-trash' | null>(null);
  // A group's workspaces to trash or delete, or null to act on the selection.
  const [bulkGroup, setBulkGroup] = useState<Workspace[] | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [rowLimit, setRowLimit] = useState(FIRST_FRAME_ROW_COUNT);

  useEffect(() => {
    startTransition(() => setRowLimit(Infinity));
  }, []);

  const overview = useMemo(() => {
    return buildDashboardOverview({
      workspaces,
      projects,
      currentWindowId,
      filterProjectName,
      filterTagKey,
      tags,
      hiddenWorkspaceHostIds: dashboardHiddenWorkspaceHostIds,
      pinnedOnly: showPinnedOnly,
      searchQuery: searchQuery || null,
    });
  }, [
    workspaces,
    projects,
    currentWindowId,
    filterProjectName,
    filterTagKey,
    tags,
    dashboardHiddenWorkspaceHostIds,
    showPinnedOnly,
    searchQuery,
  ]);

  const pinnedCount = useMemo(() => workspaces.filter((w) => w.pinned).length, [workspaces]);

  // The overview toggle returns to the previous workspace (or the first running one).
  const overviewShortcut = useShortcutsStore((s) => s.getDisplayShortcut('workspace.overview'));
  const canReturnToWorkspace = workspaces.some(
    (w) => w.status === 'active' && w.windowId === currentWindowId
  );

  const selectedWorkspaces = workspaces.filter((w) => selectedWorkspaceIds.has(w.id));
  const selectedRunningCount = selectedWorkspaces.filter(canStop).length;
  const selectedTrashableWorkspaces = selectedWorkspaces.filter((w) => w.status !== 'trashed');

  useEffect(() => {
    if (pinnedCount === 0) setShowPinnedOnly(false);
  }, [pinnedCount]);

  // A picked tag that no workspace has any more leaves no chip to unpick, so the overview already
  // leaves it out; forget it too, so it doesn't come back with the tag.
  const tagFilterDropped = filterTagKey !== null && overview.tagFilterKey === null;
  useEffect(() => {
    if (tagFilterDropped) setFilterTagKey(null);
  }, [tagFilterDropped]);
  const toggleTagFilter = (key: string) => setFilterTagKey(filterTagKey === key ? null : key);

  const isFolded = useCallback(
    (key: DashboardSectionKey) => !searchQuery.trim() && foldedSections.has(key),
    [searchQuery, foldedSections]
  );

  const openBulkDialog = (
    dialog: 'trash' | 'delete' | 'empty-trash',
    group: Workspace[] | null
  ) => {
    setBulkGroup(group);
    setBulkDialog(dialog);
  };

  const toggleFolded = (key: DashboardSectionKey) => {
    const next = new Set(foldedSections);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setFoldedSections(next);
  };

  // Ordered workspace IDs of the visible rows (folded groups excluded) for shift-click selection.
  const orderedDashboardIds = useMemo(() => {
    return overview.sections
      .filter((section) => !isFolded(section.key))
      .flatMap((section) => section.items.map((item) => item.workspace.id));
  }, [overview.sections, isFolded]);

  // Each unfolded group's rows within the row limit.
  const shownItemsBySection = useMemo(() => {
    let rowsLeft = rowLimit;
    const shown = new Map<DashboardSectionKey, DashboardSection['items']>();
    for (const section of overview.sections) {
      if (isFolded(section.key)) continue;
      const items = section.items.slice(0, rowsLeft);
      rowsLeft -= items.length;
      shown.set(section.key, items);
    }
    return shown;
  }, [overview.sections, isFolded, rowLimit]);

  // Read when a row is shift-clicked, so the row actions stay the same while the list changes.
  const orderedDashboardIdsRef = useRef(orderedDashboardIds);
  useEffect(() => {
    orderedDashboardIdsRef.current = orderedDashboardIds;
  }, [orderedDashboardIds]);

  // One object for every row, unchanged across renders, so rows re-render only for their own data.
  const rowActions = useMemo<OverviewRowActions>(
    () => ({
      selectWorkspace,
      stopWorkspace,
      setWorkspaceTrashed,
      trashWorkspaceWithUndo,
      updateWorkspace,
      deleteWorkspace,
      setPinned,
      markUnread,
      enterSelectionMode,
      toggleWorkspaceSelection,
      shiftSelect: (workspaceId) =>
        shiftSelectWorkspaces(workspaceId, orderedDashboardIdsRef.current),
    }),
    [
      selectWorkspace,
      stopWorkspace,
      setWorkspaceTrashed,
      trashWorkspaceWithUndo,
      updateWorkspace,
      deleteWorkspace,
      setPinned,
      markUnread,
      enterSelectionMode,
      toggleWorkspaceSelection,
      shiftSelectWorkspaces,
    ]
  );

  // Rows only re-render for their own changes, so a minute tick keeps their relative times fresh.
  const [minute, setMinute] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setMinute((value) => value + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Selection mode keyboard shortcuts (Escape, Cmd/Ctrl+A)
  useEffect(() => {
    if (!selectionMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        exitSelectionMode();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        // Select only the rows visible in the dashboard (respects search,
        // project filter, pinned-only, and folded groups)
        if (orderedDashboardIds.length > 0) {
          useWorkspacesStore.setState({
            selectionMode: true,
            selectedWorkspaceIds: new Set(orderedDashboardIds),
          });
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectionMode, exitSelectionMode, orderedDashboardIds]);

  // Opening the overview puts the cursor in the filter, so typing filters right away.
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Focus the filter on Cmd/Ctrl+F
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Focus the first row on ArrowDown or j when no row is focused
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'j') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Don't intercept if focus is on an interactive element
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // Don't intercept if a row already has focus
      if ((e.target as HTMLElement)?.hasAttribute('data-dashboard-row')) return;
      const firstRow = document.querySelector<HTMLElement>('[data-dashboard-row]');
      if (firstRow) {
        e.preventDefault();
        firstRow.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  if (overview.totalWindowCount === 0) {
    return (
      <EmptyState
        className="empty-work-area overview-surface h-full bg-card"
        icon={<Terminal weight="duotone" />}
        title="No workspaces"
        description="Create a workspace to get started"
        action={
          onNewWorkspaceDialogChange && (
            <Button variant="outline" size="sm" onClick={() => onNewWorkspaceDialogChange(true)}>
              New Workspace
            </Button>
          )
        }
      />
    );
  }

  const renderSectionHeader = (section: DashboardSection) => {
    const folded = isFolded(section.key);
    return (
      <div className="flex items-center gap-2 border-b border-border/60 px-1 pb-1.5">
        <h3>
          <button
            type="button"
            aria-expanded={!folded}
            onClick={() => toggleFolded(section.key)}
            className={cn(
              'flex items-center gap-1.5 rounded-sm text-xs font-medium',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
              section.key === 'attention'
                ? 'text-attention'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {folded ? <CaretRight className="size-3" /> : <CaretDown className="size-3" />}
            {section.title}
            <span className="font-normal opacity-70">{section.items.length}</span>
          </button>
        </h3>
        {STALE_SECTIONS.has(section.key) && (
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs text-muted-foreground"
              onClick={() => {
                const group = section.items.map((i) => i.workspace);
                if (needsBulkTrashConfirmation(group.length)) {
                  openBulkDialog('trash', group);
                } else {
                  void trashWorkspaces(group.map((workspace) => workspace.id));
                }
              }}
            >
              <Trash className="size-3.5" />
              Move all to Trash
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() =>
                openBulkDialog(
                  'delete',
                  section.items.map((i) => i.workspace)
                )
              }
            >
              <XCircle className="size-3.5" />
              Delete all
            </Button>
          </div>
        )}
        {section.key === 'trash' && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
            onClick={() =>
              openBulkDialog(
                'empty-trash',
                section.items.map((i) => i.workspace)
              )
            }
          >
            <XCircle className="size-3.5" />
            Delete all
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="empty-work-area overview-surface flex h-full flex-col bg-card">
      <div className="mx-auto w-full max-w-5xl shrink-0 px-6 pt-6 pb-2">
        <div className="flex items-center gap-2">
          {canReturnToWorkspace && (
            <IconButton
              label="Back to workspace"
              shortcut={overviewShortcut}
              onClick={() => executeShortcutAction('workspace.overview')}
            >
              <ArrowLeft className="size-4" />
            </IconButton>
          )}
          <div className="relative flex-1">
            <MagnifyingGlass className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              aria-label="Filter workspaces"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                // Escape clears the filter first; on an empty filter it leaves the overview.
                if (e.key === 'Escape' && searchQuery) {
                  e.stopPropagation();
                  setSearchQuery('');
                }
                if (e.key === 'ArrowDown') {
                  const firstRow = document.querySelector<HTMLElement>('[data-dashboard-row]');
                  if (firstRow) {
                    e.preventDefault();
                    firstRow.focus();
                  }
                }
              }}
              placeholder="Filter by title, branch, or prompt"
              className="h-8 pr-7 pl-8 text-sm"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearchQuery('')}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <WorkspaceHostFilterMenu scope="dashboard" />
          {pinnedCount > 0 && (
            <IconButton
              label={
                showPinnedOnly
                  ? `Showing pinned (${pinnedCount})`
                  : `Show pinned only (${pinnedCount})`
              }
              aria-pressed={showPinnedOnly}
              className={cn(showPinnedOnly && 'text-foreground')}
              onClick={() => setShowPinnedOnly(!showPinnedOnly)}
            >
              <PushPin className="size-3.5" weight={showPinnedOnly ? 'fill' : 'regular'} />
            </IconButton>
          )}
          {onNewWorkspaceDialogChange && (
            <div className="flex items-center gap-0.5">
              <Button
                variant="outline"
                className="h-8 bg-card px-2 text-xs text-foreground"
                onClick={() => onNewWorkspaceDialogChange(true)}
              >
                <Plus className="mr-0.5 size-3.5 shrink-0" />
                <span>Workspace</span>
                <ShortcutHint action="workspace.new" className="ml-1" />
              </Button>
              <QuickCreateMenu />
            </div>
          )}
        </div>
        {(overview.projectFilters.length > 0 || overview.tagFilters.length > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-1">
            {overview.projectFilters.map((project) => {
              const isSelected = filterProjectName === project.name;
              return (
                <FilterChip
                  key={project.name}
                  selected={isSelected}
                  onToggle={() => setFilterProjectName(isSelected ? null : project.name)}
                  count={project.count}
                >
                  <ProjectMark project={project} iconClassName="size-3" />
                  {project.name}
                </FilterChip>
              );
            })}
            {overview.projectFilters.length > 0 && overview.tagFilters.length > 0 && (
              <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
            )}
            {overview.tagFilters.map((tag) => (
              <FilterChip
                key={tag.key}
                selected={filterTagKey === tag.key}
                onToggle={() => toggleTagFilter(tag.key)}
                count={tag.count}
              >
                <ToneDot tone={tag.tone} />
                {tag.name}
              </FilterChip>
            ))}
            {overview.untaggedOffered && (
              <FilterChip
                selected={filterTagKey === UNTAGGED_WORKSPACE_TAG_KEY}
                onToggle={() => toggleTagFilter(UNTAGGED_WORKSPACE_TAG_KEY)}
                count={overview.untaggedCount}
              >
                <UntaggedDot />
                Untagged
              </FilterChip>
            )}
          </div>
        )}
      </div>
      <ScrollArea className={cn('min-h-0 flex-1', selectionMode && 'select-none')}>
        <div className="mx-auto w-full max-w-5xl px-6 pt-2 pb-8">
          {overview.visibleCount === 0 ? (
            <EmptyState
              className="py-16"
              title="No workspaces match current filters"
              description={
                searchQuery
                  ? 'Try a different search term or clear the search to see all workspaces.'
                  : dashboardHiddenWorkspaceHostIds.size > 0
                    ? 'Choose another host or show all hosts.'
                    : 'Clear the project, tag or pinned filter to see every workspace.'
              }
              action={
                !searchQuery &&
                dashboardHiddenWorkspaceHostIds.size > 0 && (
                  <Button variant="outline" size="sm" onClick={showAllDashboardWorkspaceHosts}>
                    Show all hosts
                  </Button>
                )
              }
            />
          ) : (
            <div className="space-y-5">
              {overview.sections.map((section) => (
                <section key={section.key}>
                  {renderSectionHeader(section)}
                  {!isFolded(section.key) && (
                    <div className="mt-1">
                      {shownItemsBySection.get(section.key)?.map((item) => (
                        <OverviewRow
                          key={item.workspace.id}
                          workspace={item.workspace}
                          projectInfo={item.projectInfo}
                          sshHost={
                            item.workspace.backend?.kind === 'ssh'
                              ? (sshHosts.find(
                                  (host) => host.id === getWorkspaceHostId(item.workspace)
                                ) ?? null)
                              : null
                          }
                          searchQuery={searchQuery}
                          selectionMode={selectionMode}
                          isMultiSelected={selectedWorkspaceIds.has(item.workspace.id)}
                          minute={minute}
                          actions={rowActions}
                        />
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
      {selectionMode && (
        <div className="flex items-center gap-3 border-t border-border/40 px-4 py-1.5 text-xs">
          <span className="font-medium">{selectedWorkspaceIds.size} selected</span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              disabled={selectedRunningCount === 0}
              onClick={() => void stopSelectedWorkspaces()}
            >
              <Square className="size-3.5" />
              Stop
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              disabled={selectedTrashableWorkspaces.length === 0}
              onClick={() => {
                if (needsBulkTrashConfirmation(selectedTrashableWorkspaces.length)) {
                  openBulkDialog('trash', null);
                } else {
                  void trashSelectedWorkspaces();
                }
              }}
            >
              <Trash className="size-3.5" />
              Move to Trash
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
              disabled={selectedWorkspaces.length === 0}
              onClick={() => openBulkDialog('delete', null)}
            >
              <XCircle className="size-3.5" />
              Delete
            </Button>
          </div>
          <button
            className="ml-auto text-muted-foreground hover:text-foreground"
            onClick={exitSelectionMode}
          >
            Exit
          </button>
        </div>
      )}
      <BulkTrashDialog
        open={bulkDialog === 'trash'}
        onOpenChange={(open) => {
          if (!open) setBulkDialog(null);
        }}
        workspaces={bulkGroup ?? selectedTrashableWorkspaces}
        onConfirm={() => {
          if (bulkGroup) {
            void trashWorkspaces(bulkGroup.map((workspace) => workspace.id));
          } else {
            void trashSelectedWorkspaces();
          }
        }}
      />
      <BulkDeleteDialog
        open={bulkDialog === 'delete' || bulkDialog === 'empty-trash'}
        onOpenChange={(open) => {
          if (!open) setBulkDialog(null);
        }}
        workspaces={bulkGroup ?? selectedWorkspaces}
        // A stale group was picked by age, not by hand, so work it would lose stays. What's in
        // the Trash was put there to go.
        keepUnsavedWork={bulkDialog === 'delete' && bulkGroup !== null}
        onConfirm={(deleteBranch, workspacesToDelete) => {
          if (bulkGroup) {
            void deleteWorkspaces(
              workspacesToDelete.map((workspace) => workspace.id),
              true,
              deleteBranch
            );
          } else {
            void deleteSelectedWorkspaces(true, deleteBranch);
          }
        }}
      />
    </div>
  );
});
