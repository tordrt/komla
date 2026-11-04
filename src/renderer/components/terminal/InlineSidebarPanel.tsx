import { CaretDown, Check, DotsSixVertical, Warning } from '@phosphor-icons/react';
import { useLayoutEffect, useState } from 'react';

import {
  CommandHtmlFrame,
  CommandMarkdown,
  CommandPageButtons,
  CommandPagePlaceholder,
  CommandTerminalText,
  commandSource,
  useCommandPage,
} from '@/components/command-page/command-page';
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
import { IconButton } from '@/components/ui/icon-button';
import {
  menuContentClass,
  menuItemClass,
  menuLabelClass,
  menuSeparatorClass,
} from '@/components/ui/menu-styles';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useNamedActionRunner } from '@/hooks/useNamedActionRunner';
import { useWorkspaceProjectId } from '@/hooks/useProject';
import { useRunWhileVisible } from '@/hooks/useRunWhileVisible';
import { useSidebarPanelChoice, useSidebarPanels } from '@/hooks/useSidebarPanels';
import { addPanelWithAgent } from '@/lib/customize-agent';
import { hiddenInProjectUpdate, isHiddenInProject } from '@/lib/project-hidden-items';
import {
  fittingSidebarTabCount,
  fittingSidebarTabRow,
  keptSidebarTabOrder,
  moveSidebarTab,
  replaceSidebarTab,
  narrowestSidebarTabRowWidth,
  panelView,
  sidebarTabOrder,
  viewPanelId,
  type SidebarView,
} from '@/lib/sidebar-tabs';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';
import {
  cachedSidebarPanelPage,
  keepSidebarPanelPage,
  sidebarPanelKey,
} from '@/stores/sidebar-panels.store';

import { SidebarPanelHeader } from './SidebarPanelHeader';
import { SidebarPanelPage } from './SidebarPanelPage';

import type { SidebarPanel } from '../../../shared/types/sidebar-panels';
import type { ReactElement } from 'react';

const SIDEBAR_PANELS_FILE = 'sidebar-panels.json';

const ADD_PANEL = 'Add a panel with your agent…';
const MANAGE_PLUGINS = 'Manage plugins…';

/** Settings at its Plugins card, where plugins' panels are turned on, set up or deleted. */
function openPluginsSettings() {
  useSettingsDialogStore.getState().openSettings({ tab: 'integrations', card: 'Plugins' });
}

const TREE_VIEWS: Record<'diff' | 'files', { label: string; title: string }> = {
  diff: { label: 'Diff', title: 'Show changed files' },
  files: { label: 'Files', title: 'Show all files' },
};

/**
 * The sidebar's views in the order the user keeps for the workspace's project, the one showing,
 * and what changes them. Each change takes the row the user sees, which depends on its width.
 */
function useSidebarViews(workspaceId: string, isGitWorkspace: boolean) {
  const { list, current, shown } = useSidebarPanelChoice(workspaceId);
  const treeMode = useFileViewerStore(
    (s) => s.inlineFileTreeByWorkspace[workspaceId]?.mode ?? 'diff'
  );
  // Through the store action, so a dirty preview asks before reloading in the other mode.
  const requestModeChange = useFileViewerStore((s) => s.requestInlineFilePreviewModeChange);
  const showPanel = useFileViewerStore((s) => s.showInlineSidebarPanel);
  const projectId = useWorkspaceProjectId(workspaceId);
  const projectTabs = useConfigStore((s) => s.config?.projectSidebarTabs);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  const panelOf = (view: SidebarView) => {
    const id = viewPanelId(view);
    return id ? list.panels.find((panel) => panel.id === id) : undefined;
  };
  const labelOf = (view: SidebarView) =>
    panelOf(view)?.title ?? TREE_VIEWS[view as 'diff' | 'files'].label;
  const views: SidebarView[] = [
    ...(isGitWorkspace ? (['diff'] as const) : []),
    'files',
    ...list.panels.map((panel) => panelView(panel.id)),
  ];
  const showing: SidebarView =
    shown && current
      ? panelView(current.id)
      : treeMode === 'diff' && isGitWorkspace
        ? 'diff'
        : 'files';
  // The order being saved, which takes a round trip to the main process, so the row moves once.
  const [saving, setSaving] = useState<{ projectId: string; order: string[] } | null>(null);
  const kept = !projectId
    ? undefined
    : saving?.projectId === projectId
      ? saving.order
      : projectTabs?.[projectId];
  const order = sidebarTabOrder(views, kept);

  const show = (view: SidebarView) => {
    const panelId = viewPanelId(view);
    if (panelId) showPanel(workspaceId, panelId);
    else requestModeChange(workspaceId, view === 'diff' ? 'diff' : 'browse');
  };
  /** Keeps the views in `first`'s order, then the rest in the order they had. */
  const keep = (first: readonly SidebarView[]) => {
    if (!projectId) return;
    const next = keptSidebarTabOrder(first, order, kept);
    if (next.join() === (kept ?? []).join()) return;
    const pending = { projectId, order: next };
    setSaving(pending);
    // Then the saved config has it, or keeps what it had when saving fails.
    void updateConfig({ projectSidebarTabs: { ...projectTabs, [projectId]: next } }).then(() =>
      setSaving((current) => (current === pending ? null : current))
    );
  };
  return {
    list,
    views,
    order,
    showing,
    panelOf,
    labelOf,
    show,
    /** Whether the user can arrange the tabs, which needs a project to keep their order for. */
    canKeep: projectId !== null,
    /** From the menu with every view: keeps `next` as the order. */
    reorder: (next: readonly SidebarView[]) => keep(next),
    /** From a tab's right-click: the view takes that tab's place, showing if that tab was. */
    replace: (row: readonly SidebarView[], tab: SidebarView, view: SidebarView) => {
      keep(replaceSidebarTab(row, order, tab, view));
      if (tab === showing) show(view);
    },
    /** From dragging a tab: moves the one at `from` to before the one at `to`, or to the end. */
    move: (row: readonly SidebarView[], from: number, to: number) => {
      keep(moveSidebarTab(row, from, to));
    },
  };
}

/** The views the tab row in the element shows, in order, as the user sees them. */
function shownSidebarTabs(element: Element): SidebarView[] {
  return [...element.querySelectorAll<HTMLElement>('[data-sidebar-tab]')].map(
    (tab) => tab.dataset.sidebarTab as SidebarView
  );
}

/**
 * Gives the sidebar's tab row, the element that holds its tabs, a right-click menu: on a tab, to
 * put another view in its place and, on a panel's, to hide that panel in the workspace's project;
 * anywhere, to show again the panels hidden there, and to add a panel, as the status bar's adds an
 * item.
 */
export function SidebarTabsMenu({
  workspaceId,
  isGitWorkspace,
  children,
}: {
  workspaceId: string;
  isGitWorkspace: boolean;
  children: ReactElement;
}) {
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const projectId = useWorkspaceProjectId(workspaceId);
  const projectName = useProjectsStore((s) => s.projects.find((p) => p.id === projectId)?.name);
  const tabs = useSidebarViews(workspaceId, isGitWorkspace);
  const hiddenHere = useSidebarPanels(workspaceId).panels.filter((panel) =>
    isHiddenInProject(config, projectId, panelView(panel.id))
  );
  const [opened, setOpened] = useState<{ row: SidebarView[]; target: SidebarView | null }>({
    row: [],
    target: null,
  });
  const { row, target } = opened;
  const targetPanel = target ? tabs.panelOf(target) : undefined;
  const others = tabs.views.filter((view) => !row.includes(view));
  const setHidden = (panel: SidebarPanel, hidden: boolean) => {
    if (projectId) {
      void updateConfig(hiddenInProjectUpdate(config, projectId, panelView(panel.id), hidden));
    }
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          // React events bubble out of portals: a right-click in the panels' menu isn't one here.
          if (!event.currentTarget.contains(event.target as Node)) {
            event.preventDefault();
            return;
          }
          const shownRow = shownSidebarTabs(event.currentTarget);
          const view = (event.target as Element).closest<HTMLElement>('[data-sidebar-tab]')?.dataset
            .sidebarTab as SidebarView | undefined;
          setOpened({ row: shownRow, target: view && shownRow.includes(view) ? view : null });
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[190px]">
        {target && tabs.canKeep && others.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <span className="max-w-[28ch] truncate">Replace {tabs.labelOf(target)} with</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-40">
              {others.map((view) => (
                <ContextMenuItem key={view} onSelect={() => tabs.replace(row, target, view)}>
                  <span className="max-w-[28ch] truncate">{tabs.labelOf(view)}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {targetPanel && projectName && (
          <ContextMenuItem onSelect={() => setHidden(targetPanel, true)}>
            <span className="max-w-[32ch] truncate">
              Hide {targetPanel.title} in {projectName}
            </span>
          </ContextMenuItem>
        )}
        {projectName &&
          hiddenHere.map((panel) => (
            <ContextMenuItem key={panel.id} onSelect={() => setHidden(panel, false)}>
              <span className="max-w-[32ch] truncate">
                Show {panel.title} in {projectName}
              </span>
            </ContextMenuItem>
          ))}
        {(target || hiddenHere.length > 0) && <ContextMenuSeparator />}
        <ContextMenuItem onSelect={addPanelWithAgent}>{ADD_PANEL}</ContextMenuItem>
        <ContextMenuItem onSelect={openPluginsSettings}>{MANAGE_PLUGINS}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** What a tab shows: a panel's title, or Diff or Files. */
function SidebarTabLabel({ view, panel }: { view: SidebarView; panel: SidebarPanel | undefined }) {
  if (!panel) return <>{TREE_VIEWS[view as 'diff' | 'files'].label}</>;
  return <span className="truncate">{panel.title}</span>;
}

const SIDEBAR_TAB_DRAG_MIME = 'application/x-komla-sidebar-tab';
const SIDEBAR_VIEW_DRAG_MIME = 'application/x-komla-sidebar-view';

/**
 * The caret's menu: every view in the order the user keeps, with a line where the ones that fit
 * in the row end, then adding a panel and managing plugins. Clicking a view shows it, in the last
 * tab's place when it has no tab, and leaves the order alone; dragging a view, or Alt+Up and
 * Alt+Down on it, moves it in the order, and above the line into the row.
 */
function SidebarViewsMenu({
  order,
  fits,
  showing,
  canKeep,
  labelOf,
  onShow,
  onReorder,
}: {
  order: readonly SidebarView[];
  /** How many views at the start of the order the row has room for. */
  fits: number;
  showing: SidebarView;
  canKeep: boolean;
  labelOf: (view: SidebarView) => string;
  onShow: (view: SidebarView) => void;
  onReorder: (next: SidebarView[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<HTMLElement | null>(null);
  const [dragged, setDragged] = useState<SidebarView | null>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; after: boolean } | null>(null);
  // The view moved from the keyboard, to keep focus on once the list shows it in its new place.
  const [moved, setMoved] = useState<SidebarView | null>(null);
  const endDrag = () => {
    setDragged(null);
    setDropTarget(null);
  };
  useLayoutEffect(() => {
    if (!moved || !list) return;
    list.querySelector<HTMLElement>(`[data-sidebar-view="${CSS.escape(moved)}"]`)?.focus();
  }, [moved, list, order]);

  const items = () => [...(list?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const focusBy = (from: HTMLElement, step: number) => {
    const all = items();
    all[(all.indexOf(from) + step + all.length) % all.length]?.focus();
  };
  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };
  const item = (label: string, action: () => void) => (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={cn(menuItemClass, 'w-full pl-[26px] text-left')}
      onClick={() => choose(action)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          focusBy(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
        }
      }}
    >
      {label}
    </button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setMoved(null);
      }}
    >
      <PopoverTrigger asChild>
        <IconButton
          label="Sidebar tabs"
          size="xs"
          variant="ghost"
          // Beside the last tab rather than a whole gap after it.
          className="my-auto -ml-2.5 shrink-0 text-muted-foreground"
        >
          <CaretDown />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn(menuContentClass, 'w-auto max-w-72 min-w-48')}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          list?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        }}
      >
        <div ref={setList} role="menu" aria-label="Sidebar tabs">
          {order.map((view, index) => (
            <div key={view}>
              {index === fits && (
                <div role="separator" className={cn(menuLabelClass, 'flex items-center gap-2')}>
                  <span className="h-px flex-1 bg-foreground/10" />
                  Doesn't fit
                  <span className="h-px flex-1 bg-foreground/10" />
                </div>
              )}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-sidebar-view={view}
                aria-current={view === showing ? 'true' : undefined}
                aria-keyshortcuts={canKeep ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
                draggable={canKeep && order.length > 1}
                onClick={() => choose(() => onShow(view))}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                  event.preventDefault();
                  const step = event.key === 'ArrowDown' ? 1 : -1;
                  if (!event.altKey) {
                    focusBy(event.currentTarget, step);
                    return;
                  }
                  const to = index + step;
                  if (!canKeep || to < 0 || to >= order.length) return;
                  setMoved(view);
                  onReorder(moveSidebarTab(order, index, step > 0 ? to + 1 : to));
                }}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData(SIDEBAR_VIEW_DRAG_MIME, view);
                  setDragged(view);
                }}
                onDragEnd={endDrag}
                onDragOver={(event) => {
                  if (!dragged || !event.dataTransfer.types.includes(SIDEBAR_VIEW_DRAG_MIME))
                    return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  const rect = event.currentTarget.getBoundingClientRect();
                  const after = event.clientY > rect.top + rect.height / 2;
                  if (dropTarget?.index !== index || dropTarget.after !== after) {
                    setDropTarget({ index, after });
                  }
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(event) => {
                  if (!dragged) return;
                  event.preventDefault();
                  const from = order.indexOf(dragged);
                  const to = dropTarget?.after ? index + 1 : index;
                  endDrag();
                  if (from !== -1 && to !== from && to !== from + 1) {
                    onReorder(moveSidebarTab(order, from, to));
                  }
                }}
                className={cn(
                  menuItemClass,
                  'group w-full pr-2 pl-1 text-left',
                  dragged === view && 'opacity-50',
                  dropTarget?.index === index &&
                    (dropTarget.after ? 'drop-indicator-after' : 'drop-indicator-before')
                )}
              >
                <DotsSixVertical
                  aria-hidden
                  className={cn(
                    'size-3.5 text-muted-foreground',
                    canKeep ? 'cursor-grab opacity-60 group-hover:opacity-100' : 'invisible'
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{labelOf(view)}</span>
                {view === showing && <Check aria-hidden className="size-3.5" />}
              </button>
            </div>
          ))}
          <div role="separator" className={menuSeparatorClass} />
          {item(ADD_PANEL, addPanelWithAgent)}
          {item(MANAGE_PLUGINS, openPluginsSettings)}
        </div>
      </PopoverContent>
    </Popover>
  );
}
/** The warning a sidebar-panels.json Komla can't read shows after the tabs. */
const PROBLEM_ICON_WIDTH_PX = 14;

interface SidebarTabWidths {
  /** Each view's tab, with the gap after it. */
  tabs: Record<string, number>;
  /** The menu's caret, with the gap after it. */
  caret: number;
  /** The gap between the row's items. */
  gap: number;
  /** The row's padding, both sides. */
  padding: number;
}

function pixels(value: string): number {
  return Number.parseFloat(value) || 0;
}

/**
 * Each view's tab width and the caret's, measured from a row of them all that no one sees, again
 * whenever that row's size changes, as when fonts load, with the gap and padding of the row
 * they sit in. Empty until laid out.
 */
function useSidebarTabWidths(viewsKey: string) {
  const [measureRow, setMeasureRow] = useState<HTMLElement | null>(null);
  const [widths, setWidths] = useState<SidebarTabWidths>({
    tabs: {},
    caret: 0,
    gap: 0,
    padding: 0,
  });
  useLayoutEffect(() => {
    if (!measureRow) return;
    const measure = () => {
      const style = measureRow.parentElement && getComputedStyle(measureRow.parentElement);
      const gap = style ? pixels(style.columnGap) : 0;
      const padding = style ? pixels(style.paddingLeft) + pixels(style.paddingRight) : 0;
      const tabs: Record<string, number> = {};
      let caret = 0;
      for (const element of measureRow.children) {
        const view = (element as HTMLElement).dataset.measureView;
        const width = element.getBoundingClientRect().width;
        if (!view) {
          caret = width && width + gap;
          continue;
        }
        tabs[view] = width && width + gap;
      }
      const same = (a: Record<string, number>, b: Record<string, number>) =>
        Object.keys(a).length === Object.keys(b).length &&
        Object.entries(a).every(([view, width]) => b[view] === width);
      setWidths((previous) =>
        previous.caret === caret &&
        previous.gap === gap &&
        previous.padding === padding &&
        same(tabs, previous.tabs)
          ? previous
          : { tabs, caret, gap, padding }
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(measureRow);
    return () => observer.disconnect();
  }, [measureRow, viewsKey]);
  return { setMeasureRow, widths };
}

/**
 * The sidebar's tabs: Diff (which needs git), Files and its panels, in the order the user keeps
 * for the workspace's project, as many whole tabs as fit in `roomPx`, and a caret's menu with
 * every view in that order. Only the user changes the order: by dragging a tab, by moving a view
 * in the menu, or by right-clicking a tab to put another view in its place. A view shown without
 * a tab, as from the menu, takes the last tab's place until another shows. A sidebar-panels.json
 * Komla can't read shows as a warning with what's wrong.
 */
export function SidebarTabs({
  workspaceId,
  isGitWorkspace,
  tabClass,
  roomPx,
  onNarrowestWidthChange,
}: {
  workspaceId: string;
  isGitWorkspace: boolean;
  /** The look of a tab, by whether it's showing. */
  tabClass: (active: boolean) => string;
  /** The width of the row the tabs, the menu's caret and the warning sit in, with its padding. */
  roomPx: number;
  /** Called with the row's width with only two tabs, for the sidebar's narrowest. */
  onNarrowestWidthChange?: (widthPx: number) => void;
}) {
  const { list, order, showing, panelOf, labelOf, show, reorder, move, canKeep } = useSidebarViews(
    workspaceId,
    isGitWorkspace
  );
  const { setMeasureRow, widths } = useSidebarTabWidths(
    order.map((view) => `${view}=${panelOf(view)?.title ?? ''}`).join('\n')
  );
  // Each item's width counts the gap after it, which the last one doesn't have.
  const besides = (list.problem ? PROBLEM_ICON_WIDTH_PX + widths.gap : 0) + widths.padding;
  const measures = {
    widthOf: (view: SidebarView) => widths.tabs[view] ?? 0,
    caret: widths.caret,
  };
  const room = { ...measures, room: roomPx - besides + widths.gap };
  const row = fittingSidebarTabRow(order, showing, room);
  const fits = fittingSidebarTabCount(order, room);
  const narrowest = narrowestSidebarTabRowWidth(order, measures);
  useLayoutEffect(() => {
    onNarrowestWidthChange?.(narrowest ? narrowest + besides - widths.gap : 0);
  }, [narrowest, besides, widths.gap, onNarrowestWidthChange]);

  const [dragged, setDragged] = useState<SidebarView | null>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; after: boolean } | null>(null);
  const endDrag = () => {
    setDragged(null);
    setDropTarget(null);
  };
  const titleOf = (view: SidebarView) => {
    const panel = panelOf(view);
    return !panel
      ? TREE_VIEWS[view as 'diff' | 'files'].title
      : panel.plugin
        ? `${panel.title}, from the plugin ${panel.plugin}`
        : panel.title;
  };

  /** A tab in `tabs`, the row it can be dragged along, at `index`. */
  const renderTab = (view: SidebarView, index: number, tabs: readonly SidebarView[]) => {
    const panel = panelOf(view);
    return (
      <button
        key={view}
        data-sidebar-tab={view}
        data-active={view === showing ? '' : undefined}
        onClick={() => show(view)}
        draggable={canKeep && tabs.length > 1}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData(SIDEBAR_TAB_DRAG_MIME, view);
          setDragged(view);
        }}
        onDragEnd={endDrag}
        onDragOver={(event) => {
          if (!dragged || !event.dataTransfer.types.includes(SIDEBAR_TAB_DRAG_MIME)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget.getBoundingClientRect();
          const after = event.clientX > rect.left + rect.width / 2;
          if (dropTarget?.index !== index || dropTarget.after !== after) {
            setDropTarget({ index, after });
          }
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(event) => {
          if (!dragged) return;
          event.preventDefault();
          const from = tabs.indexOf(dragged);
          const to = dropTarget?.after ? index + 1 : index;
          endDrag();
          if (from !== -1 && to !== from && to !== from + 1) move(tabs, from, to);
        }}
        className={cn(
          tabClass(view === showing),
          'sidebar-tab',
          // For the drop indicator.
          'relative',
          // A panel's title shortens when its tab alone is wider than the narrowest row.
          panel && 'flex max-w-40 min-w-0 items-center',
          dragged === view && 'opacity-50',
          dropTarget?.index === index &&
            (dropTarget.after ? 'drop-indicator-right' : 'drop-indicator-left')
        )}
        title={titleOf(view)}
      >
        <SidebarTabLabel view={view} panel={panel} />
      </button>
    );
  };

  return (
    <>
      {row.map((view, index) => renderTab(view, index, row))}
      <SidebarViewsMenu
        order={order}
        fits={fits}
        showing={showing}
        canKeep={canKeep}
        labelOf={labelOf}
        onShow={show}
        onReorder={reorder}
      />
      {list.problem && (
        <span
          role="img"
          aria-label={list.problem}
          title={list.problem}
          className="my-auto shrink-0 text-warning"
        >
          <Warning className="size-3.5" />
        </span>
      )}
      {/* Every tab as it would show, unseen, so the row knows how many fit. */}
      <div
        ref={setMeasureRow}
        aria-hidden
        // As wide as its tabs, however narrow the header, so none shrinks as it is measured.
        className="pointer-events-none invisible absolute top-0 left-0 flex h-full w-max"
      >
        {order.map((view) => (
          <div key={view} data-measure-view={view} className="flex shrink-0">
            <span
              data-active={view === showing ? '' : undefined}
              className={cn(
                tabClass(view === showing),
                'sidebar-tab',
                panelOf(view) && 'flex max-w-40 min-w-0 items-center'
              )}
            >
              <SidebarTabLabel view={view} panel={panelOf(view)} />
            </span>
          </div>
        ))}
        <div className="flex">
          <span className="my-auto -ml-2.5 inline-flex size-6 shrink-0" />
        </div>
      </div>
    </>
  );
}

/**
 * A sidebar panel's page, in place of the file tree: its command runs as it opens and on its
 * interval while it shows and the window can be seen, catching up once the window shows again.
 * Its buttons open links, run Quick Commands or run the commands the panel names.
 */
export function InlineSidebarPanel({
  workspaceId,
  panel,
}: {
  workspaceId: string;
  panel: SidebarPanel;
}) {
  return panel.page ? (
    <SidebarPanelPage workspaceId={workspaceId} panel={panel} />
  ) : (
    <CommandSidebarPanel workspaceId={workspaceId} panel={panel} />
  );
}

/** A panel whose command prints its page, run again each time. */
function CommandSidebarPanel({ workspaceId, panel }: { workspaceId: string; panel: SidebarPanel }) {
  const key = sidebarPanelKey(workspaceId, panel);
  const source = commandSource(SIDEBAR_PANELS_FILE, panel.plugin);
  const { runNamedAction, actionInputDialog } = useNamedActionRunner(workspaceId);
  const { content, error, loading, load, press, busy, buttonError } = useCommandPage({
    pageKey: key,
    run: (theme) => window.api.runSidebarPanel(workspaceId, panel.id, theme),
    runButton: (name) => window.api.runSidebarPanelButton(workspaceId, panel.id, name),
    cached: (theme) => cachedSidebarPanelPage(key, theme),
    onResult: (result, startedAt, theme) => keepSidebarPanelPage(key, result, startedAt, theme),
    onRunAction: (action) => void runNamedAction(action, source),
  });

  // Runs again on the panel's interval while the window can be seen, and once it shows again.
  useRunWhileVisible({
    key,
    intervalSeconds: panel.intervalSeconds,
    busy: loading,
    run: load,
    refreshOn: panel.refreshOn,
    workspaceId,
    runOn: panel.runOn,
  });

  const html = content?.htmlUrl;
  return (
    <div className="flex h-full min-h-0 flex-col" data-sidebar-panel={panel.id}>
      <SidebarPanelHeader panel={panel} loading={loading} onRefresh={load} />
      <div
        className={cn(
          'min-h-0 flex-1',
          html ? 'flex flex-col' : 'thin-scrollbar overflow-y-auto px-3 py-2.5'
        )}
      >
        {html ? (
          <div className="min-h-0 flex-1">
            <CommandHtmlFrame url={html} title={panel.title} fill />
          </div>
        ) : content?.terminal ? (
          <CommandTerminalText lines={content.terminal} />
        ) : content ? (
          content.markdown && <CommandMarkdown markdown={content.markdown} />
        ) : (
          <CommandPagePlaceholder
            loading={loading}
            error={error}
            failure={`The panel's command failed in ${source}`}
          />
        )}
        {(content && error) || buttonError ? (
          <div className={cn('space-y-1 text-xs break-words', html && 'shrink-0 px-3 py-2')}>
            {content && error && (
              <p className="text-muted-foreground">The panel's command failed: {error}</p>
            )}
            {buttonError && (
              <p role="alert" className="text-destructive">
                {buttonError}
              </p>
            )}
          </div>
        ) : null}
      </div>
      {content && (
        <CommandPageButtons
          buttons={content.buttons}
          onPress={press}
          busy={busy}
          waiting={loading}
          source={source}
        />
      )}
      {actionInputDialog}
    </div>
  );
}
