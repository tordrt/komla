import { Cloud, DesktopTower, Funnel, X } from '@phosphor-icons/react';
import React, { Fragment, useMemo, type ReactNode } from 'react';

import { CountWithOnly, DotBox } from '@/components/layout/SidebarFilterMenu';
import { ProjectMark } from '@/components/projects/ProjectMark';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSwitchItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { useWorkspaceHostOptions } from '@/components/workspaces/workspace-host-options';
import { ToneDot, UntaggedDot } from '@/components/workspaces/WorkspaceTagMenu';
import { cn } from '@/lib/utils';
import { LOCAL_WORKSPACE_HOST_ID } from '@/lib/workspace-host';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import {
  UNTAGGED_WORKSPACE_TAG_KEY,
  type WorkspaceTagTone,
} from '../../../shared/lib/workspace-tags';

import {
  describeShown,
  type DashboardOverview,
  type DashboardProjectFilter,
} from './dashboard-view-model';

const countClass = 'ml-auto pl-4 text-[11px] text-muted-foreground tabular-nums';

interface FilterOption {
  key: string;
  name: string;
  count: number;
  /** A project row's project, for its mark. */
  project?: DashboardProjectFilter;
  /** A tag row's color; Untagged has none. */
  tone?: WorkspaceTagTone;
}

/** A filter that leaves some workspaces out, as its chip under the search names it. */
export interface ActiveOverviewFilter {
  key: 'projects' | 'tags' | 'hosts' | 'pinned';
  label: string;
  /** What it still shows, such as "acme, web"; none for Pinned only. */
  value?: string;
  clear: () => void;
}

interface OverviewFiltersParams {
  overview: Pick<DashboardOverview, 'projectFilters' | 'tagFilters' | 'untaggedCount'>;
  pinnedCount: number;
  pinnedOnly: boolean;
  setPinnedOnly: (pinnedOnly: boolean) => void;
}

/**
 * The Overview's filters: the projects, tags and hosts it offers, and those of them that leave
 * workspaces out. A hidden Untagged or host stays offered while hidden, even with nothing to choose
 * between, so it can always be shown again. A hidden project no workspace is in filters nothing.
 */
export function useOverviewFilters({
  overview,
  pinnedCount,
  pinnedOnly,
  setPinnedOnly,
}: OverviewFiltersParams) {
  const hiddenProjects = useWorkspacesStore((s) => s.dashboardHiddenProjects);
  const setHiddenProjects = useWorkspacesStore((s) => s.setDashboardHiddenProjects);
  const hiddenTags = useWorkspacesStore((s) => s.dashboardHiddenWorkspaceTags);
  const setHiddenTags = useWorkspacesStore((s) => s.setDashboardHiddenWorkspaceTags);
  const hiddenHostIds = useWorkspacesStore((s) => s.dashboardHiddenWorkspaceHostIds);
  const showAllHosts = useWorkspacesStore((s) => s.showAllDashboardWorkspaceHosts);
  const toggleHost = useWorkspacesStore((s) => s.toggleDashboardWorkspaceHostVisibility);
  const hostOptions = useWorkspaceHostOptions();

  return useMemo(() => {
    const projects: FilterOption[] = overview.projectFilters.map((project) => ({
      key: project.name,
      name: project.name,
      count: project.count,
      project,
    }));
    const untaggedHidden = hiddenTags.has(UNTAGGED_WORKSPACE_TAG_KEY);
    const tags: FilterOption[] = [
      ...overview.tagFilters,
      ...((overview.tagFilters.length > 0 && overview.untaggedCount > 0) || untaggedHidden
        ? [{ key: UNTAGGED_WORKSPACE_TAG_KEY, name: 'Untagged', count: overview.untaggedCount }]
        : []),
    ];
    const hosts =
      hostOptions.length > 1 || hostOptions.some((host) => hiddenHostIds.has(host.id))
        ? hostOptions
        : [];

    const active: ActiveOverviewFilter[] = [];
    const addActive = (
      key: ActiveOverviewFilter['key'],
      label: string,
      options: readonly { name: string; hidden: boolean }[],
      clear: () => void
    ) => {
      const hidden = options.filter((option) => option.hidden).map((option) => option.name);
      if (hidden.length === 0) return;
      const shown = options.filter((option) => !option.hidden).map((option) => option.name);
      active.push({ key, label, value: describeShown(shown, hidden), clear });
    };
    addActive(
      'projects',
      'Projects',
      projects.map((p) => ({
        name: p.name,
        hidden: hiddenProjects.has(p.key),
      })),
      () => setHiddenProjects([])
    );
    addActive(
      'tags',
      'Tags',
      tags.map((t) => ({ name: t.name, hidden: hiddenTags.has(t.key) })),
      () => setHiddenTags([])
    );
    addActive(
      'hosts',
      'Hosts',
      hosts.map((h) => ({ name: h.name, hidden: hiddenHostIds.has(h.id) })),
      showAllHosts
    );
    if (pinnedOnly) {
      active.push({
        key: 'pinned',
        label: 'Pinned only',
        clear: () => setPinnedOnly(false),
      });
    }

    return {
      projects,
      tags,
      hosts,
      hiddenProjects,
      setHiddenProjects,
      hiddenTags,
      setHiddenTags,
      hiddenHostIds,
      toggleHost,
      pinnedCount,
      pinnedOnly,
      setPinnedOnly,
      // One project alone filters nothing, unless it was left out before the others went.
      offersProjects: projects.length > 1 || active.some((filter) => filter.key === 'projects'),
      offersPinned: pinnedCount > 0 || pinnedOnly,
      active,
      // Everything hidden, also what the menu doesn't list now, such as a project whose
      // workspaces are all on a hidden host: once that host shows, the project would stay hidden.
      clearAll: () => {
        if (hiddenProjects.size > 0) setHiddenProjects([]);
        if (hiddenTags.size > 0) setHiddenTags([]);
        if (hiddenHostIds.size > 0) showAllHosts();
        if (pinnedOnly) setPinnedOnly(false);
      },
    };
  }, [
    overview,
    pinnedCount,
    pinnedOnly,
    setPinnedOnly,
    hiddenProjects,
    setHiddenProjects,
    hiddenTags,
    setHiddenTags,
    hiddenHostIds,
    showAllHosts,
    toggleHost,
    hostOptions,
  ]);
}

export type OverviewFilters = ReturnType<typeof useOverviewFilters>;

/**
 * Checkbox rows, checked while their workspaces show. Only unchecks every other offered row;
 * those not offered keep their state.
 */
function FilterRows({
  options,
  hidden,
  setHidden,
  renderMark,
  onlyLabel,
}: {
  options: FilterOption[];
  hidden: ReadonlySet<string>;
  setHidden: (keys: Iterable<string>) => void;
  renderMark: (option: FilterOption) => ReactNode;
  onlyLabel?: (option: FilterOption) => string;
}) {
  return options.map((option) => (
    <DropdownMenuCheckboxItem
      key={option.key}
      aria-label={`${option.name} (${option.count})`}
      className="group"
      checked={!hidden.has(option.key)}
      onSelect={(event) => event.preventDefault()}
      onCheckedChange={(checked) => {
        const next = new Set(hidden);
        if (checked) next.delete(option.key);
        else next.add(option.key);
        setHidden(next);
      }}
    >
      {renderMark(option)}
      <span className={cn('truncate', option.count === 0 && 'text-muted-foreground')}>
        {option.name}
      </span>
      <CountWithOnly
        name={onlyLabel?.(option) ?? option.name}
        count={option.count}
        onOnly={
          options.length > 1
            ? () =>
                setHidden(
                  [...hidden, ...options.map((o) => o.key)].filter((key) => key !== option.key)
                )
            : null
        }
      />
    </DropdownMenuCheckboxItem>
  ));
}

/** Projects, tags, hosts and pinned workspaces, as one menu beside the Overview's search. */
export function DashboardFilterMenu({ filters }: { filters: OverviewFilters }) {
  const {
    projects,
    tags,
    hosts,
    hiddenProjects,
    setHiddenProjects,
    hiddenTags,
    setHiddenTags,
    hiddenHostIds,
    toggleHost,
    pinnedCount,
    pinnedOnly,
    setPinnedOnly,
    offersProjects,
    offersPinned,
    active,
    clearAll,
  } = filters;
  const offersTags = tags.length > 0;
  if (!offersProjects && !offersTags && hosts.length === 0 && !offersPinned) return null;

  const sections = [
    offersProjects && (
      <>
        <DropdownMenuLabel>Projects</DropdownMenuLabel>
        <FilterRows
          options={projects}
          hidden={hiddenProjects}
          setHidden={setHiddenProjects}
          renderMark={(option) => option.project && <ProjectMark project={option.project} />}
        />
      </>
    ),
    offersTags && (
      <>
        <DropdownMenuLabel>Tags</DropdownMenuLabel>
        <FilterRows
          options={tags}
          hidden={hiddenTags}
          setHidden={setHiddenTags}
          renderMark={(option) => (
            <DotBox>{option.tone ? <ToneDot tone={option.tone} /> : <UntaggedDot />}</DotBox>
          )}
          onlyLabel={(option) =>
            option.key === UNTAGGED_WORKSPACE_TAG_KEY ? 'untagged workspaces' : option.name
          }
        />
      </>
    ),
    hosts.length > 0 && (
      <>
        <DropdownMenuLabel>Hosts</DropdownMenuLabel>
        {hosts.map((host) => (
          <DropdownMenuCheckboxItem
            key={host.id}
            checked={!hiddenHostIds.has(host.id)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => toggleHost(host.id)}
          >
            {host.id === LOCAL_WORKSPACE_HOST_ID ? <DesktopTower /> : <Cloud />}
            <span className="truncate">{host.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </>
    ),
  ].filter(Boolean);

  const label =
    active.length > 0
      ? `Filter workspaces (${active.length} filter${active.length === 1 ? '' : 's'} on)`
      : 'Filter workspaces';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={label} className={cn(active.length > 0 && 'text-foreground')}>
          <Funnel className="size-3.5" weight={active.length > 0 ? 'fill' : 'regular'} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-72 min-w-60">
        {sections.map((section, index) => (
          <Fragment key={index}>
            {index > 0 && <DropdownMenuSeparator />}
            {section}
          </Fragment>
        ))}
        {offersPinned && (
          <>
            {sections.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuSwitchItem
              checked={pinnedOnly}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={setPinnedOnly}
            >
              <span className="truncate">Pinned only</span>
              <span className={countClass}>{pinnedCount}</span>
            </DropdownMenuSwitchItem>
          </>
        )}
        {active.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={clearAll}>Show all workspaces</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A project's one-click filter, as the chips under the search offer them. */
function ProjectChip({
  pressed,
  onClick,
  count,
  color,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  count: number;
  /** Tints the chip while it's pressed, as the project's color. */
  color?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      style={
        pressed && color
          ? ({
              backgroundColor: `color-mix(in oklch, ${color} 16%, transparent)`,
              // The ring's resting color; keyboard focus still turns it the focus ring's.
              '--chip-ring': `color-mix(in oklch, ${color} 55%, transparent)`,
            } as React.CSSProperties)
          : undefined
      }
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs ring-1 transition-colors ring-inset',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
        pressed
          ? cn(
              'bg-foreground/10 text-foreground',
              color ? 'ring-(--chip-ring)' : 'ring-foreground/25'
            )
          : 'text-muted-foreground ring-border/70 hover:bg-foreground/5 hover:text-foreground'
      )}
    >
      {children}
      <span className="text-2xs text-muted-foreground tabular-nums">{count}</span>
    </button>
  );
}

/**
 * Under the search: a chip per project, to list one with a click and all again with another, then
 * the other filters that leave workspaces out, each with a button to take it off. Picking several
 * projects is the menu's job; the chips then show each one picked.
 */
export function DashboardActiveFilters({ filters }: { filters: OverviewFilters }) {
  const { projects, hiddenProjects, setHiddenProjects, active, clearAll } = filters;
  const showsProjectChips = projects.length > 1;
  const chips = showsProjectChips ? active.filter((filter) => filter.key !== 'projects') : active;
  if (!showsProjectChips && chips.length === 0) return null;

  const offered = projects.map((project) => project.key);
  const projectsFiltered = offered.some((key) => hiddenProjects.has(key));
  // Projects not listed here keep their state.
  const unlisted = [...hiddenProjects].filter((key) => !offered.includes(key));
  const showAllProjects = () => setHiddenProjects(unlisted);
  const showOnlyProject = (key: string) =>
    setHiddenProjects([...unlisted, ...offered.filter((other) => other !== key)]);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {showsProjectChips && (
        <>
          <ProjectChip
            pressed={!projectsFiltered}
            onClick={showAllProjects}
            count={projects.reduce((sum, project) => sum + project.count, 0)}
          >
            All
          </ProjectChip>
          {projects.map((option) => {
            const pressed = projectsFiltered && !hiddenProjects.has(option.key);
            const onlyThis =
              pressed && offered.every((key) => key === option.key || hiddenProjects.has(key));
            return (
              <ProjectChip
                key={option.key}
                pressed={pressed}
                onClick={() => (onlyThis ? showAllProjects() : showOnlyProject(option.key))}
                count={option.count}
                color={option.project?.color}
              >
                {option.project && <ProjectMark project={option.project} iconClassName="size-3" />}
                {option.name}
              </ProjectChip>
            );
          })}
          {chips.length > 0 && <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />}
        </>
      )}
      {chips.map((filter) => (
        <span
          key={filter.key}
          className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-foreground/6 pr-1.5 pl-2.5 text-xs ring-1 ring-border/70 ring-inset"
        >
          <span className="text-muted-foreground">{filter.label}</span>
          {filter.value && <span className="truncate text-foreground">{filter.value}</span>}
          <button
            type="button"
            aria-label={`Remove the ${filter.label.toLowerCase()} filter`}
            onClick={filter.clear}
            className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {active.length > 1 && (
        <button
          type="button"
          onClick={clearAll}
          className="rounded-sm px-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
