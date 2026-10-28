import { Globe, NotePencil, Plus, TerminalWindow } from '@phosphor-icons/react';
import { useRef, useState, type DragEventHandler, type ReactNode } from 'react';

import { QuickCommandMenuItem } from '@/components/actions/QuickCommandMenuItem';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useActionLauncher } from '@/hooks/useActionLauncher';
import { getActionMenuGroups } from '@/lib/action-menu-order';
import { openBrowserPane, openNewNotePane } from '@/lib/pane-surfaces';
import { cn } from '@/lib/utils';
import { openNewActionEditor } from '@/stores/action-editor.store';
import { useActionsStore } from '@/stores/actions.store';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useLayoutStore } from '@/stores/layout.store';
import { useShortcutsStore } from '@/stores/shortcuts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { AgentPresetMenuItems } from './AgentPresetMenuItems';

export interface NewTabTerminalOption {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}

interface NewTabButtonProps {
  workspaceId: string;
  onNewTerminal: () => void;
  /** Other shells this workspace can open, such as one in its Local copy. */
  terminalOptions?: NewTabTerminalOption[];
  /** A pane is being dragged over the button to move it into a new tab. */
  dropActive?: boolean;
  onDragOver?: DragEventHandler<HTMLButtonElement>;
  onDragLeave?: DragEventHandler<HTMLButtonElement>;
  onDrop?: DragEventHandler<HTMLButtonElement>;
}

/**
 * Tab bar `+`: a menu with a new terminal (and any other shells the workspace offers)
 * followed by every active agent preset, each with its launch modes in a submenu, and
 * last the Actions split button's twin: run the workspace's default Action, or pick one.
 */
export function NewTabButton({
  workspaceId,
  onNewTerminal,
  terminalOptions = [],
  dropActive = false,
  onDragOver,
  onDragLeave,
  onDrop,
}: NewTabButtonProps) {
  const addAgentTab = useWorkspacesStore((s) => s.addAgentTab);
  const addTab = useLayoutStore((s) => s.addTab);
  const showTabInFullPane = useLayoutStore((s) => s.showTabInFullPane);
  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));

  const presets = useAgentPresetsStore((s) => s.presets);
  const loadPresets = useAgentPresetsStore((s) => s.loadPresets);
  const setActivePreset = useAgentPresetsStore((s) => s.setActivePreset);
  const newTerminalShortcut = useShortcutsStore((s) => s.getDisplayShortcut('terminal.new'));
  const newAgentShortcut = useShortcutsStore((s) => s.getDisplayShortcut('tab.newAgent'));
  const actions = useActionsStore((s) => s.actions);
  const loadActions = useActionsStore((s) => s.loadActions);
  const { runAction, actionInputDialog } = useActionLauncher(workspaceId);
  // Controlled so the Actions list, which has no menu items, can close the menu.
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const launchAgent = async (presetId: string, launchModeId: string | null) => {
    try {
      const terminal = await addAgentTab(
        workspaceId,
        undefined,
        launchModeId ?? undefined,
        presetId
      );
      addTab(workspaceId, terminal.id);
      showTabInFullPane(terminal.id);
      void setActivePreset(presetId, launchModeId);
    } catch (err) {
      useToastStore
        .getState()
        .addToast(`Failed to launch agent: ${(err as Error).message}`, 'error');
    }
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          void loadPresets();
          void loadActions();
        }
      }}
    >
      <Tooltip delayDuration={600}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              ref={triggerRef}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              aria-label="New tab"
              className={cn(
                'flex h-7 shrink-0 items-center gap-1 rounded-md border border-transparent px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground',
                dropActive && 'border-primary text-foreground ring-2 ring-inset ring-primary'
              )}
            >
              <Plus className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <span className="flex flex-col gap-0.5">
            <span>New tab</span>
            {newTerminalShortcut && (
              <span className="flex items-center justify-between gap-2 text-muted-foreground">
                Terminal
                <Kbd>{newTerminalShortcut}</Kbd>
              </span>
            )}
            {newAgentShortcut && (
              <span className="flex items-center justify-between gap-2 text-muted-foreground">
                Agent
                <Kbd>{newAgentShortcut}</Kbd>
              </span>
            )}
          </span>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuItem onSelect={onNewTerminal}>
          <TerminalWindow />
          New terminal
          {newTerminalShortcut && (
            <DropdownMenuShortcut>{newTerminalShortcut}</DropdownMenuShortcut>
          )}
        </DropdownMenuItem>
        {terminalOptions.map((option) => (
          <DropdownMenuItem key={option.label} onSelect={option.onSelect}>
            {option.icon}
            {option.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => openBrowserPane(workspaceId, { kind: 'tab' })}>
          <Globe />
          New browser
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openNewNotePane(workspaceId, { kind: 'tab' })}>
          <NotePencil />
          New note
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <AgentPresetMenuItems
          workspaceId={workspaceId}
          menuType="dropdown"
          newAgentShortcut={newAgentShortcut}
          onLaunch={(presetId, launchModeId) => void launchAgent(presetId, launchModeId)}
        />
        <DropdownMenuSeparator />
        <QuickCommandMenuItem
          menuType="dropdown"
          groups={getActionMenuGroups(actions, workspace?.projectId)}
          defaultActionId={workspace?.defaultActionId}
          presets={presets}
          onRun={(action) => {
            setOpen(false);
            runAction(action);
          }}
          onNew={() => {
            setOpen(false);
            openNewActionEditor(workspace?.projectId, () => triggerRef.current?.focus());
          }}
          onManage={() => {
            setOpen(false);
            window.dispatchEvent(new CustomEvent('open-settings', { detail: 'actions' }));
          }}
        />
      </DropdownMenuContent>
      {actionInputDialog}
    </DropdownMenu>
  );
}
