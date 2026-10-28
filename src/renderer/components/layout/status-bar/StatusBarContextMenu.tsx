import { useRef, useState } from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { addStatusItemWithAgent } from '@/lib/customize-agent';
import { useConfigStore } from '@/stores/config.store';
import { useStatusBarCustomizeStore } from '@/stores/status-bar-customize.store';
import { useToastStore } from '@/stores/toast.store';

import {
  STATUS_BAR_ITEMS,
  isCustomStatusItemKey,
  statusBarItemVisibilityUpdate,
  type CustomStatusItemKey,
  type StatusBarItemId,
} from './status-bar-items';
import { StatusBarCustomizePanel } from './StatusBarCustomizePanel';

import type * as React from 'react';

/** An item the user can hide, marked so right-clicking it offers to hide that item. */
export function StatusBarItem({
  id,
  children,
}: {
  id: StatusBarItemId;
  children: React.ReactNode;
}) {
  return (
    <span className="contents" data-status-bar-item={id}>
      {children}
    </span>
  );
}

type Point = { x: number; y: number };

type HideTarget = { id: StatusBarItemId | CustomStatusItemKey; label: string };

/** The item under the pointer: one of Komla's, or a custom item by what it shows. */
function hideTargetAt(element: Element): HideTarget | null {
  const builtInId = element.closest<HTMLElement>('[data-status-bar-item]')?.dataset.statusBarItem;
  const builtIn = STATUS_BAR_ITEMS.find((item) => item.id === builtInId);
  if (builtIn) return builtIn;
  const custom = element.closest<HTMLElement>('[data-status-item]');
  const key = custom?.dataset.statusItem;
  if (!key || !isCustomStatusItemKey(key)) return null;
  return { id: key, label: custom?.dataset.statusItemLabel ?? key };
}

/**
 * The panel that shows, hides and moves the bar's items, above where the bar was right-clicked,
 * or above its right end when opened from elsewhere, such as Tips. Rendered once, with the bar.
 */
export function StatusBarCustomizePopover() {
  const { open, close } = useStatusBarCustomizeStore();
  const anchorRef = useRef({
    getBoundingClientRect: () => {
      const bar = document.querySelector('[data-status-bar]')?.getBoundingClientRect();
      const { x, y } = useStatusBarCustomizeStore.getState().anchor ?? {
        x: (bar?.right ?? 0) - 8,
        y: bar?.top ?? 0,
      };
      return { x, y, top: y, left: x, right: x, bottom: y, width: 0, height: 0 } as DOMRect;
    },
  });
  return (
    <Popover open={open} onOpenChange={(next) => !next && close()}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        side="top"
        sideOffset={6}
        collisionPadding={8}
        aria-label="Customize status bar"
        className="w-[440px] p-0"
      >
        <StatusBarCustomizePanel onClose={close} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The bar's right-click menu: hide the item under the pointer, open the customize panel, add an
 * item with the open workspace's agent, or hide the bar. The sidebar's footer, which continues the bar, opens it too. Without the bar showing,
 * `children` gets no menu.
 */
export function StatusBarContextMenu({ children }: { children: React.ReactElement }) {
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const showCustomize = useStatusBarCustomizeStore((s) => s.show);
  const [target, setTarget] = useState<HideTarget | null>(null);
  // The panel opens above the bar where it was right-clicked.
  const anchorPoint = useRef<Point>({ x: 0, y: 0 });
  const openPanelOnClose = useRef(false);
  if (!config || config.showStatusBar === false) return children;

  const onContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    // React events bubble out of portals: a right-click inside an item's menu is not one on the bar.
    if (!event.currentTarget.contains(event.target as Node)) {
      event.preventDefault();
      return;
    }
    setTarget(hideTargetAt(event.target as Element));
    anchorPoint.current = { x: event.clientX, y: event.currentTarget.getBoundingClientRect().top };
  };

  const hideStatusBar = () => {
    void updateConfig({ showStatusBar: false });
    useToastStore
      .getState()
      .addToast('Status bar hidden. Turn it back on in Settings › Appearance.', 'info', {
        action: { label: 'Undo', onClick: () => void updateConfig({ showStatusBar: true }) },
      });
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={onContextMenu}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-[190px]"
        // Focus going back to the bar would dismiss the panel as it opens.
        onCloseAutoFocus={(event) => {
          if (!openPanelOnClose.current) return;
          openPanelOnClose.current = false;
          event.preventDefault();
          showCustomize(anchorPoint.current);
        }}
      >
        {/* The menu opens upward from the bar, so this sits farthest from the pointer. */}
        <ContextMenuItem onSelect={hideStatusBar}>Hide status bar</ContextMenuItem>
        <ContextMenuSeparator />
        {target && (
          <ContextMenuItem
            onSelect={() =>
              void updateConfig(statusBarItemVisibilityUpdate(config, target.id, false))
            }
          >
            <span className="max-w-[24ch] truncate">Hide {target.label}</span>
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => (openPanelOnClose.current = true)}>
          Customize status bar…
        </ContextMenuItem>
        <ContextMenuItem onSelect={addStatusItemWithAgent}>
          Add an item with your agent…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
