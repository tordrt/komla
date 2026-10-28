import {
  AppWindow,
  ArrowSquareOut,
  Globe,
  Monitor,
  SquareSplitHorizontal,
  SquareSplitVertical,
} from '@phosphor-icons/react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

import type { PaneSurfacePlacement } from '@/lib/pane-surfaces';
import type { VirtualDesktopTarget } from '@/lib/virtual-desktops';
import type { ReactNode } from 'react';

/** Where a row of a list opens from its menu: the default browser, Komla's browser, or a pane of its own. */
export type OpenInTarget = 'external' | 'preview' | PaneSurfacePlacement;

/**
 * A row's right-click menu of the places it can open, as the file tree's rows offer: a page in the
 * default browser or Komla's browser, and anything in a new tab or split.
 */
export function OpenInPaneMenu({
  isPage,
  onOpen,
  children,
}: {
  /** Whether the row is a page, which can also open in a browser. */
  isPage: boolean;
  onOpen: (target: OpenInTarget) => void;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {isPage && (
          <>
            <ContextMenuItem onSelect={() => onOpen('external')}>
              <ArrowSquareOut />
              Open in Default Browser
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onOpen('preview')}>
              <Globe />
              Open in Komla
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={() => onOpen({ kind: 'tab' })}>
          <AppWindow />
          Open in New Tab
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onOpen({ kind: 'split', direction: 'vertical' })}>
          <SquareSplitHorizontal />
          Open in Split Right
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onOpen({ kind: 'split', direction: 'horizontal' })}>
          <SquareSplitVertical />
          Open in Split Down
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * A virtual desktop's right-click menu: the VNC app this computer has, then, with a noVNC page,
 * Komla's browser, a new tab or a split. Never the default browser, as its page's address holds
 * the desktop's password, which a browser keeps in its history.
 */
export function VirtualDesktopMenu({
  vncApp,
  hasPage,
  onOpen,
  children,
}: {
  vncApp: string | undefined;
  hasPage: boolean;
  onOpen: (target: VirtualDesktopTarget) => void;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {vncApp && (
          <ContextMenuItem onSelect={() => onOpen('vnc-app')}>
            <Monitor />
            Open in {vncApp}
          </ContextMenuItem>
        )}
        {hasPage && (
          <>
            <ContextMenuItem onSelect={() => onOpen('preview')}>
              <Globe />
              Open in Komla
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onOpen({ kind: 'tab' })}>
              <AppWindow />
              Open in New Tab
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onOpen({ kind: 'split', direction: 'vertical' })}>
              <SquareSplitHorizontal />
              Open in Split Right
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onOpen({ kind: 'split', direction: 'horizontal' })}>
              <SquareSplitVertical />
              Open in Split Down
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
