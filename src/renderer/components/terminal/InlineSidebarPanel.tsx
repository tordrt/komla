import { CaretDown, Warning } from '@phosphor-icons/react';

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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { useNamedActionRunner } from '@/hooks/useNamedActionRunner';
import { useRunWhileVisible } from '@/hooks/useRunWhileVisible';
import { useSidebarPanelChoice } from '@/hooks/useSidebarPanels';
import { cn } from '@/lib/utils';
import { useFileViewerStore } from '@/stores/file-viewer.store';
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
          <SidebarPanelBadge workspaceId={workspaceId} panelId={current.id} />
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
                  <span className="ml-auto">
                    <SidebarPanelBadge workspaceId={workspaceId} panelId={panel.id} />
                  </span>
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
