import { MagnifyingGlass, Plus, SidebarSimple } from '@phosphor-icons/react';
import React, { memo, useEffect, useState, type ReactNode, type Ref } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { SidebarFilterMenu } from '@/components/layout/SidebarFilterMenu';
import { StatusBarContextMenu } from '@/components/layout/status-bar/StatusBarContextMenu';
import { type UpgradeTrigger } from '@/components/layout/UpgradeDialog';
import { WorkspaceQuota } from '@/components/layout/WorkspaceQuota';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Kbd, ShortcutHint } from '@/components/ui/kbd';
import { KomlaMark } from '@/components/ui/komla-mark';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FolderDropZone } from '@/components/workspaces/FolderDropZone';
import { QuickCreateMenu } from '@/components/workspaces/QuickCreateMenu';
import { WorkspaceList } from '@/components/workspaces/WorkspaceList';
import {
  setSidebarCollapsed,
  useSidebarCollapsed,
  useSidebarMounted,
} from '@/lib/sidebar-collapsed';
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from '@/lib/sidebar-width';
import { cn } from '@/lib/utils';
import { useShortcutsStore } from '@/stores/shortcuts.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { MAC_TRAFFIC_LIGHT_INSET_PX, useHasTrafficLights } from './title-bar-metrics';

interface SidebarProps {
  ref?: Ref<HTMLDivElement>;
  width: number;
  onResize: (width: number) => void;
  onNewWorkspaceDialogChange: (open: boolean) => void;
  onUpgradeNeeded: (trigger: UpgradeTrigger) => void;
  onOpenCommandCenter?: () => void;
  /** The settings menu, in the sidebar's bottom-right corner. */
  renderAppMenu?: (placement: 'sidebar') => ReactNode;
}

// Memoized: App re-renders whenever one of its dialogs opens.
export const Sidebar = memo(function Sidebar({
  ref,
  width,
  onResize,
  onNewWorkspaceDialogChange,
  onUpgradeNeeded,
  onOpenCommandCenter,
  renderAppMenu,
}: SidebarProps) {
  const { selectWorkspace, selectionMode, selectedWorkspaceIds, exitSelectionMode } =
    useWorkspacesStore(
      useShallow((s) => ({
        selectWorkspace: s.selectWorkspace,
        selectionMode: s.selectionMode,
        selectedWorkspaceIds: s.selectedWorkspaceIds,
        exitSelectionMode: s.exitSelectionMode,
      }))
    );
  const hasTrafficLights = useHasTrafficLights();
  // Collapsed, it stays mounted but hidden, so its cards still answer the delete shortcut and
  // the list keeps its scroll position.
  useSidebarMounted();
  const collapsed = useSidebarCollapsed();
  // A selection out of sight would still take the delete shortcut.
  useEffect(() => {
    if (collapsed && selectionMode) exitSelectionMode();
  }, [collapsed, selectionMode, exitSelectionMode]);
  // Same height as the title bar beside it.
  const titleBarHeightClass = window.api.platform === 'win32' ? 'h-10' : 'h-9';
  const { getDisplayShortcut } = useShortcutsStore();
  const overviewShortcut = getDisplayShortcut('workspace.overview');

  // The macOS traffic lights sit at the left of the top row.
  const topRowInset = hasTrafficLights ? MAC_TRAFFIC_LIGHT_INSET_PX : 0;

  const showNewWorkspaceShortcut = width >= 185;

  // One filled split control, the same field as Jump to: New Workspace, then quick create.
  const newWorkspaceControls = (
    <div className="no-drag flex h-7 min-w-0 flex-1 items-center overflow-hidden rounded-md bg-accent/60">
      <button
        type="button"
        aria-label="New Workspace"
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1.5 pl-2 text-xs font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset"
        onClick={() => onNewWorkspaceDialogChange(true)}
      >
        <Plus className="size-3.5 shrink-0" />
        <span className="truncate">Workspace</span>
        {showNewWorkspaceShortcut && <ShortcutHint action="workspace.new" className="ml-auto" />}
      </button>
      <QuickCreateMenu className="size-7 rounded-none border-l border-foreground/8 focus-visible:ring-offset-0 focus-visible:ring-inset [&>svg]:size-3" />
    </div>
  );

  // Opens Overview, from the footer.
  const overview = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Komla Overview"
          className="h-6 min-w-0 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={() => selectWorkspace(null)}
        >
          <KomlaMark className="size-3.5 shrink-0" />
          <span className="truncate">Komla</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex items-center gap-2">
          Overview
          {overviewShortcut && <Kbd>{overviewShortcut}</Kbd>}
        </span>
      </TooltipContent>
    </Tooltip>
  );

  return (
    <div
      ref={ref}
      className={cn(
        'sidebar-surface window-chrome relative z-10 flex h-full shrink-0 flex-col',
        collapsed && 'hidden'
      )}
      style={{ width, minWidth: MIN_SIDEBAR_WIDTH }}
    >
      {/* Top row, level with the title bar and draggable: the macOS traffic lights, Jump to, then
          the collapse button. Komla's name sits in the footer on every platform, and in fullscreen
          too, so the sidebar doesn't rearrange itself on entering it. */}
      <div
        data-testid="sidebar-top-row"
        className={cn('drag-region flex shrink-0 items-center px-1.5', titleBarHeightClass)}
        style={topRowInset ? { paddingLeft: topRowInset } : undefined}
      >
        {onOpenCommandCenter && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="no-drag flex h-7 min-w-0 flex-1 items-center gap-1 overflow-hidden rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
                onClick={onOpenCommandCenter}
              >
                {/* Unfilled, with the shortcut as plain text, so it stays quieter than New
                    Workspace below it. When narrow, the placeholder truncates before the
                    shortcut does, which shows Shift as ⇧ to fit. */}
                <MagnifyingGlass className="size-3.5 shrink-0" />
                <span className="truncate">Jump to…</span>
                <ShortcutHint
                  action="commandCenter.open"
                  compact
                  className="ml-auto shrink-0 border-0 bg-transparent px-0 text-muted-foreground/60"
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>Search workspaces and commands</TooltipContent>
          </Tooltip>
        )}
        <IconButton
          label="Collapse sidebar"
          shortcut={getDisplayShortcut('sidebar.toggle')}
          className="no-drag ml-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => setSidebarCollapsed(true)}
        >
          <SidebarSimple className="size-4" />
        </IconButton>
      </div>

      {/* New Workspace Button */}
      <div className="flex px-2.5 pt-0.5 pb-1.5">{newWorkspaceControls}</div>

      {/* Workspace list, where a folder dropped from outside opens */}
      <FolderDropZone className="flex-1 overflow-hidden">
        <WorkspaceList onNewWorkspaceDialogChange={onNewWorkspaceDialogChange} />
      </FolderDropZone>

      {/* Workspace quota display */}
      <WorkspaceQuota onUpgradeClick={() => onUpgradeNeeded('settings')} />

      {/* Selection mode indicator */}
      {selectionMode && (
        <div className="flex items-center justify-between border-t border-border/20 px-2.5 py-1 text-xs">
          <span className="font-medium">{selectedWorkspaceIds.size} selected</span>
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={exitSelectionMode}
          >
            Exit
          </button>
        </div>
      )}

      {/* Bottom toolbar: Komla's name, which opens Overview, on the left; the filter and
          sort menu, then the settings menu in the sidebar's corner, on the right. The name and the
          settings menu stay put, and have the status bar's right-click menu. */}
      <div className="flex h-[25px] shrink-0 items-center gap-0.5 px-2">
        {/* Fills the footer's left, so right-clicking anywhere there opens the status bar's menu. */}
        <StatusBarContextMenu>
          <div
            data-testid="sidebar-footer-start"
            className="flex min-w-0 flex-1 items-center self-stretch"
          >
            {overview}
          </div>
        </StatusBarContextMenu>
        <div className="flex shrink-0 items-center gap-0.5">
          <SidebarFilterMenu />
          <StatusBarContextMenu>
            <div className="flex items-center">{renderAppMenu?.('sidebar')}</div>
          </StatusBarContextMenu>
        </div>
      </div>

      <SidebarResizeHandle width={width} onResize={onResize} />
    </div>
  );
});

/** Drag, arrow keys, or double-click/Home (resets to the default width). */
function SidebarResizeHandle({
  width,
  onResize,
}: {
  width: number;
  onResize: (width: number) => void;
}) {
  const [isResizing, setIsResizing] = useState(false);

  const handleResizeKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 16 : e.key === 'ArrowLeft' ? -16 : 0;
    if (step !== 0) {
      e.preventDefault();
      onResize(clampSidebarWidth(width + step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onResize(DEFAULT_SIDEBAR_WIDTH);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);

    const startX = e.clientX;
    const startWidth = width;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = startWidth + (e.clientX - startX);
      onResize(clampSidebarWidth(newWidth));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      tabIndex={0}
      className={cn(
        'no-drag absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize transition-colors focus-visible:bg-primary/50 focus-visible:outline-hidden',
        isResizing ? 'bg-primary/50' : 'hover:bg-primary/40'
      )}
      onMouseDown={handleMouseDown}
      onDoubleClick={() => onResize(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={handleResizeKeyDown}
    />
  );
}
