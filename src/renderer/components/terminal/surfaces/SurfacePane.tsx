import { Desktop, Globe, NotePencil, Swap, TerminalWindow, X } from '@phosphor-icons/react';
import React, { useMemo, useState } from 'react';

import { QuickCommandMenuItem } from '@/components/actions/QuickCommandMenuItem';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { IconButton } from '@/components/ui/icon-button';
import { useActionLauncher } from '@/hooks/useActionLauncher';
import { useShortcutDisplay } from '@/hooks/useShortcuts';
import { getActionMenuGroups } from '@/lib/action-menu-order';
import { useEditorSurfaceBackground } from '@/lib/palette-runtime';
import { setDraggedPaneId, PANE_DRAG_MIME } from '@/lib/pane-drag';
import {
  replacePaneSurface,
  requestClosePaneSurface,
  splitTerminalBesidePane,
} from '@/lib/pane-surfaces';
import { cn } from '@/lib/utils';
import { openNewActionEditor } from '@/stores/action-editor.store';
import { useActionsStore } from '@/stores/actions.store';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useLayoutStore } from '@/stores/layout.store';
import { usePaneSurfacesStore } from '@/stores/pane-surfaces.store';
import { supportsLocalCopy } from '@/stores/ssh-command-execution-location.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isSshWorkspace } from '@/types';

import { AgentPresetMenuItems } from '../AgentPresetMenuItems';
import {
  paneDragBarProps,
  PaneDragBarProvider,
  PaneDragGrip,
  paneDragGripRevealProps,
} from '../PaneDragGrip';

import { BrowserSurface } from './BrowserSurface';
import { FileSurface } from './FileSurface';
import { NoteSurface } from './NoteSurface';
import { SplitPaneMenuItems } from './SplitPaneMenuItems';

import type { SurfaceHeader } from './surface-props';
import type { ActionPlace } from '@/lib/action-launch';
import type { Action, AgentPreset } from '@/types';

// What a pane can show instead; each pane offers the kinds it isn't.
const REPLACEMENTS = [
  { kind: 'terminal', label: 'Terminal', icon: <TerminalWindow /> },
  { kind: 'browser', label: 'Browser', icon: <Globe /> },
  { kind: 'note', label: 'Note', icon: <NotePencil /> },
] as const;

const NO_ACTIONS: Action[] = [];
const NO_PRESETS: AgentPreset[] = [];

interface SurfacePaneProps {
  paneId: string;
  surfaceId: string;
  isTabActive: boolean;
  isLayoutLocked?: boolean;
  workspaceId?: string;
  /** The tab holds only this pane, so its grip shows only when there's another tab to drag it to. */
  isOnlyPane?: boolean;
}

/** A pane that shows a browser page, a note or a file instead of a terminal. */
export const SurfacePane = React.memo(function SurfacePane({
  paneId,
  surfaceId,
  isTabActive,
  isLayoutLocked = false,
  workspaceId,
  isOnlyPane = false,
}: SurfacePaneProps) {
  const surface = usePaneSurfacesStore((s) => s.surfaces[surfaceId]);
  const workspace = useWorkspacesStore((s) =>
    s.workspaces.find((candidate) => candidate.id === workspaceId)
  );
  const isFocused = useLayoutStore((s) => {
    if (!workspaceId) return false;
    const activeTabId = s.activeTabByWorkspace[workspaceId];
    return !!activeTabId && s.focusedPaneByTab[workspaceId]?.[activeTabId] === paneId;
  });
  const hasOtherTabs = useLayoutStore(
    (s) => !!workspaceId && (s.tabsByWorkspace[workspaceId]?.length ?? 0) > 1
  );
  const setFocusedPane = useLayoutStore((s) => s.setFocusedPane);
  const background = useEditorSurfaceBackground();
  // An SSH workspace's panes can open a terminal on this computer, in its Local copy.
  const sshHostId = workspace && isSshWorkspace(workspace) ? workspace.backend.hostId : undefined;
  const offersLocalTerminal = useSshHostsStore((s) => {
    const host = sshHostId ? s.hosts?.find((candidate) => candidate.id === sshHostId) : undefined;
    return !!host && supportsLocalCopy(host);
  });
  const closePaneShortcut = useShortcutDisplay('pane.close');
  const [isDragging, setIsDragging] = useState(false);
  const [isPointerNearTop, setIsPointerNearTop] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  // Only the open menu lists quick commands and agents, and places them in the active tab, so a
  // closed one doesn't follow them.
  const actions = useActionsStore((s) => (contextMenuOpen ? s.actions : NO_ACTIONS));
  const presets = useAgentPresetsStore((s) => (contextMenuOpen ? s.presets : NO_PRESETS));
  const activeTabId = useLayoutStore((s) =>
    contextMenuOpen && workspaceId ? (s.activeTabByWorkspace[workspaceId] ?? null) : null
  );
  const { runAction, actionInputDialog } = useActionLauncher(workspaceId);
  // Kept stable so the toolbars that drag the pane don't re-render as the pointer nears its top.
  const drag = useMemo(
    () => ({
      onDragStart: (event: React.DragEvent) => {
        event.dataTransfer.setData(PANE_DRAG_MIME, paneId);
        event.dataTransfer.effectAllowed = 'move';
        setDraggedPaneId(paneId);
        setIsDragging(true);
      },
      onDragEnd: () => {
        setDraggedPaneId(null);
        setIsDragging(false);
        // A drag sends no mouse events, so the pointer may have left the top band unseen.
        setIsPointerNearTop(false);
      },
    }),
    [paneId]
  );

  // A surface closed elsewhere (another window, a stale layout) leaves nothing to show.
  if (!surface || !workspace || !workspaceId) return null;

  const close = () => void requestClosePaneSurface(workspaceId, surfaceId);
  // The header, or a note's toolbar, drags the pane from its empty space too, but tabs or
  // buttons can fill that, so the pane also gets the grip terminal panes have.
  const showDragGrip = !isLayoutLocked && (!isOnlyPane || hasOtherTabs);

  const { onDragStart: startDrag, onDragEnd: endDrag } = drag;

  const closeButton = (
    <IconButton
      label="Close pane"
      shortcut={closePaneShortcut}
      size="xs"
      tooltipSide="bottom"
      disabled={isLayoutLocked}
      onClick={close}
    >
      <X className="size-3.5" />
    </IconButton>
  );

  const header: SurfaceHeader = (title, options = {}) => (
    <div
      className={cn(
        'flex h-7 shrink-0 cursor-grab items-center gap-1 bg-card pr-1 active:cursor-grabbing',
        // Tabs draw the bottom line as an inset shadow, which the active tab covers.
        options.tabs
          ? 'shadow-[inset_0_-1px_0_oklch(var(--border))]'
          : 'border-b border-border pl-2'
      )}
      // The active tab opens into the surface below it.
      style={options.tabs ? ({ '--tab-surface': background } as React.CSSProperties) : undefined}
      {...(isLayoutLocked ? {} : paneDragBarProps(drag))}
    >
      {options.icon && (
        <span className="flex shrink-0 text-muted-foreground [&_svg]:size-3.5">{options.icon}</span>
      )}
      <div
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1 text-xs',
          isFocused ? 'text-foreground' : 'text-muted-foreground'
        )}
        title={options.titleTooltip}
      >
        {title}
      </div>
      {options.actions}
      {closeButton}
    </div>
  );

  const handleContextMenuOpen = (open: boolean) => {
    setContextMenuOpen(open);
    if (!open) return;
    void useActionsStore.getState().loadActions();
    void useAgentPresetsStore.getState().loadPresets();
  };
  // Radix calls onOpenChange only for closes it makes itself.
  const closeContextMenuThen = (run: () => void) => {
    setContextMenuOpen(false);
    run();
  };
  // As on a terminal pane, Replace With and each split submenu end with the quick commands, sharing
  // the + menu's default since they all start something new.
  const quickCommandMenuItem = (place: ActionPlace) => (
    <QuickCommandMenuItem
      menuType="context"
      groups={getActionMenuGroups(actions, workspace.projectId)}
      defaultActionId={workspace.defaultActionId}
      presets={presets}
      onRun={(action) =>
        closeContextMenuThen(() => {
          // The list isn't a menu item, so a lock that arrives while it's open doesn't grey it out.
          if (isLayoutLocked) return;
          runAction(action, place);
        })
      }
      onNew={() => closeContextMenuThen(() => openNewActionEditor(workspace.projectId))}
      onManage={() =>
        closeContextMenuThen(() =>
          window.dispatchEvent(new CustomEvent('open-settings', { detail: 'actions' }))
        )
      }
    />
  );

  const surfaceProps = {
    surfaceId,
    workspace,
    isTabActive,
    isFocused,
    header,
    closeButton,
    onClose: close,
  };

  return (
    <>
      <ContextMenu open={contextMenuOpen} onOpenChange={handleContextMenuOpen}>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'relative flex h-full min-h-0 flex-col transition-opacity',
              // A file pane's footers and previews keep the page background.
              surface.kind === 'file' && 'bg-background',
              isDragging && 'opacity-40'
            )}
            style={surface.kind === 'file' ? undefined : { backgroundColor: background }}
            data-pane-surface={surface.kind}
            onMouseDownCapture={() => {
              if (isTabActive && !isFocused) setFocusedPane(paneId);
            }}
            {...paneDragGripRevealProps(showDragGrip, setIsPointerNearTop)}
          >
            {showDragGrip && (
              <PaneDragGrip
                revealed={isPointerNearTop}
                notch
                onDragStart={startDrag}
                onDragEnd={endDrag}
              />
            )}
            <PaneDragBarProvider value={showDragGrip ? drag : null}>
              {surface.kind === 'browser' ? (
                <BrowserSurface
                  {...surfaceProps}
                  onPageFocus={() => {
                    if (isTabActive && !isFocused) setFocusedPane(paneId);
                  }}
                />
              ) : surface.kind === 'note' ? (
                <NoteSurface {...surfaceProps} name={surface.name} />
              ) : (
                <FileSurface {...surfaceProps} path={surface.path} />
              )}
            </PaneDragBarProvider>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <SplitPaneMenuItems
            workspaceId={workspaceId}
            paneId={paneId}
            disabled={isLayoutLocked}
            onSplitTerminal={(direction) =>
              void splitTerminalBesidePane(workspaceId, paneId, direction)
            }
            onSplitLocalTerminal={
              offersLocalTerminal
                ? (direction) =>
                    void splitTerminalBesidePane(workspaceId, paneId, direction, { local: true })
                : undefined
            }
            quickCommands={(direction) =>
              quickCommandMenuItem({ kind: 'split', paneId, tabId: activeTabId, direction })
            }
          />
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={isLayoutLocked}>
              <Swap />
              Replace With
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {REPLACEMENTS.filter(({ kind }) => kind !== surface.kind).map(
                ({ kind, label, icon }) => (
                  <React.Fragment key={kind}>
                    <ContextMenuItem
                      onSelect={() => void replacePaneSurface(workspaceId, surfaceId, paneId, kind)}
                    >
                      {icon}
                      {label}
                    </ContextMenuItem>
                    {kind === 'terminal' && offersLocalTerminal && (
                      <ContextMenuItem
                        onSelect={() =>
                          void replacePaneSurface(workspaceId, surfaceId, paneId, 'local-terminal')
                        }
                      >
                        <Desktop />
                        Local Terminal
                      </ContextMenuItem>
                    )}
                  </React.Fragment>
                )
              )}
              <ContextMenuSeparator />
              <AgentPresetMenuItems
                workspaceId={workspaceId}
                menuType="context"
                onLaunch={(presetId, launchModeId) =>
                  void replacePaneSurface(workspaceId, surfaceId, paneId, {
                    kind: 'agent',
                    presetId,
                    launchModeId,
                  })
                }
              />
              <ContextMenuSeparator />
              {quickCommandMenuItem({
                kind: 'replace-surface',
                surfaceId,
                paneId,
                tabId: activeTabId,
              })}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={isLayoutLocked} onSelect={close}>
            <X />
            Close Pane
            <ContextMenuShortcut>{closePaneShortcut}</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {actionInputDialog}
    </>
  );
});
