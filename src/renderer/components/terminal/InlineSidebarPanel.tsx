import { CaretDown, Warning } from '@phosphor-icons/react';
import { useState } from 'react';

import {
  CommandHtmlFrame,
  CommandMarkdown,
  CommandPageButtons,
  CommandPagePlaceholder,
  CommandTerminalText,
  commandSource,
  useCommandPage,
} from '@/components/command-page/command-page';
import { CheckedIcon } from '@/components/ui/checked-icon';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { useNamedActionRunner } from '@/hooks/useNamedActionRunner';
import { useWorkspaceProjectId } from '@/hooks/useProject';
import { useRunWhileVisible } from '@/hooks/useRunWhileVisible';
import { useSidebarPanelChoice, useSidebarPanels } from '@/hooks/useSidebarPanels';
import { addPanelWithAgent } from '@/lib/customize-agent';
import { hiddenInProjectUpdate, isHiddenInProject } from '@/lib/project-hidden-items';
import {
  panelView,
  pickSidebarTab,
  sidebarTabRow,
  viewPanelId,
  type SidebarView,
} from '@/lib/sidebar-tabs';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useProjectsStore } from '@/stores/projects.store';
import {
  cachedSidebarPanelPage,
  keepSidebarPanelPage,
  sidebarPanelKey,
  useSidebarPanelState,
} from '@/stores/sidebar-panels.store';

import { SidebarPanelHeader } from './SidebarPanelHeader';
import { SidebarPanelPage } from './SidebarPanelPage';

import type { SidebarPanel } from '../../../shared/types/sidebar-panels';
import type { StatusItemTone } from '../../../shared/types/status-items';
import type { ReactElement } from 'react';

const SIDEBAR_PANELS_FILE = 'sidebar-panels.json';

function PanelIcon({ panel }: { panel: SidebarPanel }) {
  if (!panel.icon) return null;
  return (
    <CheckedIcon
      src={panel.icon}
      color={panel.iconColor}
      className={cn('shrink-0', panel.iconColor ? 'size-3.5' : 'h-3.5 w-auto max-w-7')}
    />
  );
}

const BADGE_TONES: Record<StatusItemTone, string> = {
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  error: 'bg-destructive/15 text-destructive',
  info: 'bg-info/15 text-info',
};

/** The badge a panel's page or plugin code set on its tab, such as a count. */
export function SidebarPanelBadge({
  workspaceId,
  panelId,
}: {
  workspaceId: string;
  panelId: string;
}) {
  const badge = useSidebarPanelState(workspaceId, panelId)?.badge;
  if (!badge) return null;
  return (
    <span
      data-sidebar-panel-badge={panelId}
      className={cn(
        'shrink-0 rounded-full px-1.5 text-[10px] leading-4 font-medium tabular-nums',
        badge.tone ? BADGE_TONES[badge.tone] : 'bg-muted text-muted-foreground'
      )}
    >
      {badge.text}
    </span>
  );
}

const ADD_PANEL = 'Add a panel with your agent…';

const TREE_VIEWS: Record<'diff' | 'files', { label: string; title: string }> = {
  diff: { label: 'Diff', title: 'Show changed files' },
  files: { label: 'Files', title: 'Show all files' },
};

/**
 * The sidebar's views, the two its tab row shows and the one showing, with what changes them. The
 * pair the user sets is kept for the workspace's project; a workspace without one keeps the
 * first two.
 */
function useSidebarTabRow(workspaceId: string, isGitWorkspace: boolean) {
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
  const row = sidebarTabRow(views, projectId ? projectTabs?.[projectId] : undefined, showing);

  const show = (view: SidebarView) => {
    const panelId = viewPanelId(view);
    if (panelId) showPanel(workspaceId, panelId);
    else requestModeChange(workspaceId, view === 'diff' ? 'diff' : 'browse');
  };
  const keep = (next: SidebarView[]) => {
    if (projectId && next.join() !== row.join()) {
      void updateConfig({ projectSidebarTabs: { ...projectTabs, [projectId]: next } });
    }
  };
  return {
    list,
    views,
    row,
    showing,
    panelOf,
    labelOf,
    show,
    /** Whether the user can set the pair, which needs a project to keep it for. */
    canKeep: projectId !== null,
    /** From the menu: shows the view, in place of the tab that isn't showing. */
    pick: (view: SidebarView) => {
      keep(pickSidebarTab(row, view, showing));
      show(view);
    },
    /** From a tab's right-click: puts the view in that tab's place, showing it if that tab was. */
    replace: (tab: SidebarView, view: SidebarView) => {
      keep(row.map((kept) => (kept === tab ? view : kept)));
      if (tab === showing) show(view);
    },
  };
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
  const tabs = useSidebarTabRow(workspaceId, isGitWorkspace);
  const hiddenHere = useSidebarPanels(workspaceId).panels.filter((panel) =>
    isHiddenInProject(config, projectId, panelView(panel.id))
  );
  const [target, setTarget] = useState<SidebarView | null>(null);
  const targetPanel = target ? tabs.panelOf(target) : undefined;
  const others = tabs.views.filter((view) => !tabs.row.includes(view));
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
          const view = (event.target as Element).closest<HTMLElement>('[data-sidebar-tab]')?.dataset
            .sidebarTab as SidebarView | undefined;
          setTarget(view && tabs.row.includes(view) ? view : null);
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
                <ContextMenuItem key={view} onSelect={() => tabs.replace(target, view)}>
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
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The sidebar's tabs: two of Diff (which needs git), Files and its panels, and a menu with every
 * one of them when there are more. Picking one from the menu shows it in place of the tab that
 * isn't showing, so the one the user came from stays beside it; right-clicking a tab puts another
 * view in its place. The pair is kept for the workspace's project, and the row keeps its width
 * however many panels there are. A sidebar-panels.json Komla can't read shows as a warning with
 * what's wrong.
 */
export function SidebarTabs({
  workspaceId,
  isGitWorkspace,
  tabClass,
}: {
  workspaceId: string;
  isGitWorkspace: boolean;
  /** The look of a tab, by whether it's showing. */
  tabClass: (active: boolean) => string;
}) {
  const { list, views, row, showing, panelOf, show, pick } = useSidebarTabRow(
    workspaceId,
    isGitWorkspace
  );

  return (
    <>
      {row.map((view) => {
        const panel = panelOf(view);
        return (
          <button
            key={view}
            data-sidebar-tab={view}
            onClick={() => show(view)}
            className={cn(
              tabClass(view === showing),
              panel && 'flex max-w-40 min-w-0 items-center gap-1.5'
            )}
            title={
              !panel
                ? TREE_VIEWS[view as 'diff' | 'files'].title
                : panel.plugin
                  ? `${panel.title}, from the plugin ${panel.plugin}`
                  : panel.title
            }
          >
            {panel ? (
              <>
                <PanelIcon panel={panel} />
                <span className="truncate">{panel.title}</span>
                <SidebarPanelBadge workspaceId={workspaceId} panelId={panel.id} />
              </>
            ) : (
              TREE_VIEWS[view as 'diff' | 'files'].label
            )}
          </button>
        );
      })}
      {views.length > row.length && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <IconButton
              label="More sidebar tabs"
              size="xs"
              variant="ghost"
              className="my-auto shrink-0 text-muted-foreground"
            >
              <CaretDown />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            <DropdownMenuRadioGroup
              value={showing}
              onValueChange={(view) => pick(view as SidebarView)}
            >
              {views.map((view) => {
                const panel = panelOf(view);
                return (
                  <DropdownMenuRadioItem key={view} value={view} className="gap-2">
                    {panel ? (
                      <>
                        <PanelIcon panel={panel} />
                        <span className="truncate">{panel.title}</span>
                        <span className="ml-auto">
                          <SidebarPanelBadge workspaceId={workspaceId} panelId={panel.id} />
                        </span>
                      </>
                    ) : (
                      TREE_VIEWS[view as 'diff' | 'files'].label
                    )}
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={addPanelWithAgent}>{ADD_PANEL}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {list.problem && (
        <span
          role="img"
          aria-label={list.problem}
          title={list.problem}
          className="my-auto ml-1 shrink-0 text-warning"
        >
          <Warning className="size-3.5" />
        </span>
      )}
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
