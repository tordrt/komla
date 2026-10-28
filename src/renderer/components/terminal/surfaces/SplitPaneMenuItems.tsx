import {
  Cloud,
  Desktop,
  Globe,
  NotePencil,
  SquareSplitHorizontal,
  SquareSplitVertical,
} from '@phosphor-icons/react';
import React, { type ReactNode } from 'react';

import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { useShortcutDisplay } from '@/hooks/useShortcuts';
import { openBrowserPane, openNewNotePane, splitAgentBesidePane } from '@/lib/pane-surfaces';

import { AgentPresetMenuItems } from '../AgentPresetMenuItems';

import type { SplitDirection } from '@/types/layout';

interface SplitPaneMenuItemsProps {
  workspaceId: string | null | undefined;
  paneId: string;
  disabled: boolean;
  onSplitTerminal: (direction: SplitDirection) => void;
  /** Offered in an SSH workspace, whose panes can split off a terminal on this computer. */
  onSplitLocalTerminal?: (direction: SplitDirection) => void;
  /** Offered beside a Local copy terminal, whose split row opens another Local terminal. */
  onSplitSshTerminal?: (direction: SplitDirection) => void;
  /** Last in each submenu: the quick commands that can open beside the pane. */
  quickCommands?: (direction: SplitDirection) => ReactNode;
}

/**
 * Split Right and Split Down. The row opens a terminal beside the pane; its submenu opens a
 * local or SSH terminal, a browser, a note, an agent or a quick command there instead.
 */
export function SplitPaneMenuItems({
  workspaceId,
  paneId,
  disabled,
  onSplitTerminal,
  onSplitLocalTerminal,
  onSplitSshTerminal,
  quickCommands,
}: SplitPaneMenuItemsProps) {
  const splitRightShortcut = useShortcutDisplay('pane.splitRight');
  const splitDownShortcut = useShortcutDisplay('pane.splitDown');
  const splits = [
    {
      direction: 'vertical',
      label: 'Split Right',
      where: 'to the right',
      icon: <SquareSplitHorizontal />,
      shortcut: splitRightShortcut,
    },
    {
      direction: 'horizontal',
      label: 'Split Down',
      where: 'below',
      icon: <SquareSplitVertical />,
      shortcut: splitDownShortcut,
    },
  ] as const;

  return splits.map(({ direction, label, where, icon, shortcut }) => {
    const placement = { kind: 'split', direction, paneId } as const;
    return (
      <ContextMenuSub key={direction}>
        <div className="flex items-stretch">
          <ContextMenuItem
            className="flex-1 pr-1"
            disabled={disabled}
            onSelect={() => onSplitTerminal(direction)}
          >
            {icon}
            {label}
            <ContextMenuShortcut>{shortcut}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSubTrigger
            aria-label={`Choose what opens ${where}`}
            disabled={disabled}
            className="ml-0.5 flex-none px-1.5"
          />
        </div>
        <ContextMenuSubContent>
          {onSplitLocalTerminal && (
            <ContextMenuItem onSelect={() => onSplitLocalTerminal(direction)}>
              <Desktop />
              Local Terminal
            </ContextMenuItem>
          )}
          {onSplitSshTerminal && (
            <ContextMenuItem onSelect={() => onSplitSshTerminal(direction)}>
              <Cloud />
              SSH Terminal
            </ContextMenuItem>
          )}
          <ContextMenuItem
            disabled={!workspaceId}
            onSelect={() => workspaceId && openBrowserPane(workspaceId, placement)}
          >
            <Globe />
            Browser
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!workspaceId}
            onSelect={() => workspaceId && void openNewNotePane(workspaceId, placement)}
          >
            <NotePencil />
            Note
          </ContextMenuItem>
          <ContextMenuSeparator />
          <AgentPresetMenuItems
            workspaceId={workspaceId}
            menuType="context"
            disabled={!workspaceId}
            onLaunch={(presetId, launchModeId) =>
              workspaceId &&
              void splitAgentBesidePane(workspaceId, paneId, direction, presetId, launchModeId)
            }
          />
          {quickCommands && (
            <>
              <ContextMenuSeparator />
              {quickCommands(direction)}
            </>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
    );
  });
}
