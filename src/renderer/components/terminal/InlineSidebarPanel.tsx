import { ArrowClockwise, CaretDown, Warning } from '@phosphor-icons/react';
import { useEffect, useEffectEvent } from 'react';

import {
  CommandHtmlFrame,
  CommandMarkdown,
  CommandPageButtons,
  CommandPagePlaceholder,
  commandSource,
  useCommandPage,
} from '@/components/command-page/command-page';
import { CheckedIcon } from '@/components/ui/checked-icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { useNamedActionRunner } from '@/hooks/useNamedActionRunner';
import { useSidebarPanelChoice } from '@/hooks/useSidebarPanels';
import { cn } from '@/lib/utils';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import {
  cachedSidebarPanelPage,
  keepSidebarPanelPage,
  sidebarPanelKey,
} from '@/stores/sidebar-panels.store';

import type { SidebarPanel } from '../../../shared/types/sidebar-panels';

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

/**
 * The sidebar's tab for its panels, after Diff and Files: the panel picked last, with a menu to
 * pick another when there are more, so the tab row keeps its width however many there are. A
 * sidebar-panels.json Komla can't read shows as a warning with what's wrong.
 */
export function SidebarPanelTabs({
  workspaceId,
  tabClass,
}: {
  workspaceId: string;
  /** The look of a tab, as Diff and Files have it. */
  tabClass: (active: boolean) => string;
}) {
  const { list, current, shown } = useSidebarPanelChoice(workspaceId);
  const showPanel = useFileViewerStore((s) => s.showInlineSidebarPanel);
  return (
    <>
      {current && (
        <button
          onClick={() => showPanel(workspaceId, current.id)}
          className={cn(tabClass(shown), 'flex max-w-40 min-w-0 items-center gap-1.5')}
          title={
            current.plugin ? `${current.title}, from the plugin ${current.plugin}` : current.title
          }
        >
          <PanelIcon panel={current} />
          <span className="truncate">{current.title}</span>
        </button>
      )}
      {list.panels.length > 1 && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <IconButton
              label="Sidebar panels"
              size="xs"
              variant="ghost"
              className="my-auto shrink-0 text-muted-foreground"
            >
              <CaretDown />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            <DropdownMenuRadioGroup
              value={shown ? current?.id : ''}
              onValueChange={(id) => showPanel(workspaceId, id)}
            >
              {list.panels.map((panel) => (
                <DropdownMenuRadioItem key={panel.id} value={panel.id} className="gap-2">
                  <PanelIcon panel={panel} />
                  <span className="truncate">{panel.title}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
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
  const runIfDue = useEffectEvent((lastRun: { at: number }) => {
    if (document.visibilityState === 'hidden' || loading) return;
    if (Date.now() - lastRun.at < panel.intervalSeconds * 1000) return;
    lastRun.at = Date.now();
    load();
  });
  useEffect(() => {
    const lastRun = { at: Date.now() };
    const check = () => runIfDue(lastRun);
    const timer = setInterval(check, 1000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [key]);

  const html = content?.htmlUrl;
  return (
    <div className="flex h-full min-h-0 flex-col" data-sidebar-panel={panel.id}>
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-foreground/10 pr-1 pl-3">
        <h2 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {panel.title}
          {panel.plugin && <span className="font-normal"> · {panel.plugin}</span>}
        </h2>
        <IconButton label="Refresh" size="xs" variant="ghost" disabled={loading} onClick={load}>
          <ArrowClockwise className={loading ? 'animate-spin' : undefined} />
        </IconButton>
      </div>
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
