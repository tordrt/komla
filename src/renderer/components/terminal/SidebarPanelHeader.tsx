import { ArrowClockwise, ArrowCounterClockwise, Bug } from '@phosphor-icons/react';

import { IconButton } from '@/components/ui/icon-button';

import type { SidebarPanel } from '../../../shared/types/sidebar-panels';

/**
 * The slim bar above a panel: its title, and a refresh button while it has a command to run. While
 * its plugin is in development, it can load the page again and open the developer tools.
 */
export function SidebarPanelHeader({
  panel,
  loading,
  onRefresh,
  onReload,
}: {
  panel: SidebarPanel;
  loading: boolean;
  onRefresh?: () => void;
  /** Loads the panel's own page again. */
  onReload?: () => void;
}) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-foreground/10 pr-1 pl-3">
      <h2 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
        {panel.title}
        {panel.plugin && panel.plugin !== panel.title && (
          <span className="font-normal"> · {panel.plugin}</span>
        )}
      </h2>
      {panel.development && onReload && (
        <IconButton label="Load the page again" size="xs" variant="ghost" onClick={onReload}>
          <ArrowCounterClockwise />
        </IconButton>
      )}
      {panel.development && (
        <IconButton
          label="Inspect the page"
          size="xs"
          variant="ghost"
          onClick={() => void window.api.inspectSidebarPanel()}
        >
          <Bug />
        </IconButton>
      )}
      {onRefresh && (
        <IconButton
          label="Refresh"
          size="xs"
          variant="ghost"
          disabled={loading}
          onClick={onRefresh}
        >
          <ArrowClockwise className={loading ? 'animate-spin' : undefined} />
        </IconButton>
      )}
    </div>
  );
}
