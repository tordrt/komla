import {
  CalendarDots,
  ChartBar,
  Code,
  Coffee,
  Cloud,
  Cpu,
  DotsSixVertical,
  Folder,
  GitBranch,
  GitCommit,
  GitDiff,
  GitMerge,
  GitPullRequest,
  Lightbulb,
  MagnifyingGlass,
  NotePencil,
  Plus,
  Robot,
  SpeakerHigh,
  Terminal,
  type Icon,
} from '@phosphor-icons/react';
import { useLayoutEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { menuLabelClass } from '@/components/ui/menu-styles';
import { Switch } from '@/components/ui/switch';
import { addStatusItemWithAgent } from '@/lib/customize-agent';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import {
  customStatusItemEntries,
  useAgentStatusItems,
  useStatusCommandList,
  type CustomStatusItemEntry,
} from './CustomStatusItemsSegment';
import {
  STATUS_BAR_ITEMS,
  STATUS_BAR_ITEMS_RESET,
  isStatusBarItemShown,
  statusBarItemMoveUpdate,
  statusBarItemVisibilityUpdate,
  statusBarItemsAreDefault,
  statusBarPlacement,
  type StatusBarItemId,
  type StatusBarPlacedId,
  type StatusBarSide,
} from './status-bar-items';
import { StatusBarSizeControl } from './StatusBarSizeControl';

import type { AppConfig } from '@/types';
import type * as React from 'react';

const ITEM_ICONS: Record<StatusBarItemId, Icon> = {
  'git-menu': GitBranch,
  'target-branch': GitMerge,
  'pull-request': GitPullRequest,
  'open-in-editor': Code,
  'file-search': MagnifyingGlass,
  'file-viewer': Folder,
  'diff-viewer': GitDiff,
  notes: NotePencil,
  'commit-graph': GitCommit,
  agents: Robot,
  'claude-code-usage': ChartBar,
  'codex-usage': ChartBar,
  automations: CalendarDots,
  'notification-sounds': SpeakerHigh,
  'keep-awake': Coffee,
  'ssh-hosts': Cloud,
  'system-metrics': Cpu,
  tips: Lightbulb,
};

const SIDE_LABELS: Record<StatusBarSide, string> = { left: 'Left', right: 'Right' };

const OTHER_SIDE: Record<StatusBarSide, StatusBarSide> = { left: 'right', right: 'left' };

const switchClass = 'h-4 w-7 [&>span]:size-3 [&>span[data-state=checked]]:translate-x-3';
const rowClass =
  'flex h-7 cursor-default items-center gap-2 rounded-md px-2 font-[450] hover:bg-foreground/5';

/** The open workspace's custom items, from status-items.json and its agents, hidden ones too. */
function useCustomItemEntries(): CustomStatusItemEntry[] {
  const workspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const commands = useStatusCommandList(workspaceId).items;
  const agentItems = useAgentStatusItems().filter((item) => item.workspaceId === workspaceId);
  return customStatusItemEntries(commands, agentItems);
}

type ItemInfo = { label: string; icon: Icon };

/** An item's name and icon: Komla's from its list, a custom item's by where it comes from. */
function itemInfo(id: StatusBarPlacedId, customEntries: CustomStatusItemEntry[]): ItemInfo {
  const custom = customEntries.find((entry) => entry.key === id);
  if (custom) return { label: custom.label, icon: custom.kind === 'agent' ? Robot : Terminal };
  const item = STATUS_BAR_ITEMS.find((entry) => entry.id === id);
  return { label: item?.label ?? id, icon: ITEM_ICONS[id as StatusBarItemId] ?? Terminal };
}

/** An item's icon, name and switch. */
function ItemToggle({
  config,
  id,
  info,
}: {
  config: AppConfig | null;
  id: StatusBarPlacedId;
  info: ItemInfo;
}) {
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const ItemIcon = info.icon;
  return (
    <label className="flex min-w-0 flex-1 cursor-default items-center gap-2">
      <ItemIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{info.label}</span>
      <Switch
        aria-label={info.label}
        checked={isStatusBarItemShown(config, id)}
        onCheckedChange={(checked) =>
          void updateConfig(statusBarItemVisibilityUpdate(config, id, checked))
        }
        className={switchClass}
      />
    </label>
  );
}

type DropTarget = { side: StatusBarSide; index: number };

/**
 * The items on each side of the bar, in order, the open workspace's custom items among them.
 * Dragging a row, or the arrow keys on its handle, moves the item: up and down along its side,
 * left and right across to the other.
 */
function PlacementSections({ customEntries }: { customEntries: CustomStatusItemEntry[] }) {
  // Read here, not passed down, so a move that has saved shows from the store's latest config.
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const customKeys = customEntries.map((entry) => entry.key);
  // The last move sent, until it saves: the next move starts from it, as the store only updates
  // once a save returns.
  const [unsaved, setUnsaved] = useState<Partial<AppConfig> | null>(null);
  const saves = useRef(0);
  const placed = unsaved ? { ...config, ...unsaved } : config;
  const placement = statusBarPlacement(placed, customKeys);
  const [dragged, setDragged] = useState<StatusBarPlacedId | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // A handle moved by keyboard keeps focus once its item shows on its new side.
  const refocus = useRef<{ id: StatusBarPlacedId; side: StatusBarSide } | null>(null);

  useLayoutEffect(() => {
    const pending = refocus.current;
    if (!pending) return;
    // The moved item shows on its new side in the render after the move, or not at all.
    refocus.current = null;
    const handle = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>(
        `[data-side="${pending.side}"] [data-move-handle]`
      ) ?? []
    ).find((element) => element.dataset.moveHandle === pending.id);
    if (handle && document.activeElement !== handle) handle.focus();
  });

  const move = async (id: StatusBarPlacedId, side: StatusBarSide, index: number) => {
    const update = statusBarItemMoveUpdate(placed, customKeys, id, side, index);
    const save = ++saves.current;
    setUnsaved(update);
    await updateConfig(update);
    if (save === saves.current) setUnsaved(null);
  };

  const endDrag = () => {
    setDragged(null);
    setDropTarget(null);
  };

  const dragOver = (event: React.DragEvent, side: StatusBarSide, index: number) => {
    if (!dragged) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    if (dropTarget?.side !== side || dropTarget.index !== index) setDropTarget({ side, index });
  };

  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    if (dragged && dropTarget) {
      // The index counts the dragged item while it still sits above the drop on the same side.
      const from = placement[dropTarget.side].indexOf(dragged);
      const index =
        from !== -1 && from < dropTarget.index ? dropTarget.index - 1 : dropTarget.index;
      void move(dragged, dropTarget.side, index);
    }
    endDrag();
  };

  // Where an arrow key takes an item, or null at an edge.
  const keyTarget = (
    key: string,
    id: StatusBarPlacedId,
    side: StatusBarSide
  ): DropTarget | null => {
    const index = placement[side].indexOf(id);
    const other = OTHER_SIDE[side];
    if (key === 'ArrowUp' && index > 0) return { side, index: index - 1 };
    if (key === 'ArrowDown' && index < placement[side].length - 1)
      return { side, index: index + 1 };
    if (key === (side === 'left' ? 'ArrowRight' : 'ArrowLeft')) {
      return { side: other, index: Math.min(index, placement[other].length) };
    }
    return null;
  };

  const onHandleKeyDown = (
    event: React.KeyboardEvent,
    id: StatusBarPlacedId,
    side: StatusBarSide
  ) => {
    const target = keyTarget(event.key, id, side);
    if (!target) return;
    event.preventDefault();
    refocus.current = { id, side: target.side };
    void move(id, target.side, target.index);
  };

  const sideSection = (side: StatusBarSide) => {
    const items = placement[side];
    return (
      <section
        aria-label={SIDE_LABELS[side]}
        data-side={side}
        className="min-h-14"
        onDragOver={(event) => dragOver(event, side, items.length)}
        onDrop={drop}
      >
        <h3 className={menuLabelClass} onDragOver={(event) => dragOver(event, side, 0)}>
          {SIDE_LABELS[side]}
        </h3>
        {items.map((id, index) => {
          const info = itemInfo(id, customEntries);
          const dropBefore = dropTarget?.side === side && dropTarget.index === index;
          const dropAfter =
            dropTarget?.side === side &&
            dropTarget.index === items.length &&
            index === items.length - 1;
          return (
            <div
              key={id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', id);
                setDragged(id);
              }}
              onDragEnd={endDrag}
              onDragOver={(event) => {
                const { top, height } = event.currentTarget.getBoundingClientRect();
                dragOver(event, side, event.clientY > top + height / 2 ? index + 1 : index);
              }}
              className={cn(
                rowClass,
                'gap-1 pl-0.5',
                dragged === id && 'opacity-50',
                dropBefore && 'shadow-[inset_0_2px_0_0_var(--color-primary)]',
                dropAfter && 'shadow-[inset_0_-2px_0_0_var(--color-primary)]'
              )}
            >
              <button
                type="button"
                aria-label={`Move ${info.label}`}
                title="Drag, or use the arrow keys, to move"
                data-move-handle={id}
                onKeyDown={(event) => onHandleKeyDown(event, id, side)}
                className="flex h-5 w-4 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground/60 outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
              >
                <DotsSixVertical className="size-3.5" />
              </button>
              <ItemToggle config={config} id={id} info={info} />
            </div>
          );
        })}
      </section>
    );
  };

  return (
    <div ref={containerRef} className="grid grid-cols-2 gap-x-2 border-t border-foreground/10 p-1">
      {sideSection('left')}
      {sideSection('right')}
    </div>
  );
}

/**
 * Every item with a switch, on each side of the bar in the order it shows them, to drag into
 * place: Komla's and the open workspace's custom items. Then the bar's size, a way to add a custom
 * item, and Reset. Changes show in the bar at once; `onClose` closes the panel.
 */
export function StatusBarCustomizePanel({ onClose }: { onClose: () => void }) {
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const customEntries = useCustomItemEntries();
  if (!config) return null;

  return (
    <div className="text-[12px]">
      <div className="flex items-center justify-between py-1 pr-1 pl-3">
        <h2 className="font-medium">Customize status bar</h2>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[12px] text-muted-foreground hover:text-foreground"
          disabled={statusBarItemsAreDefault(
            config,
            customEntries.map((entry) => entry.key)
          )}
          onClick={() => void updateConfig(STATUS_BAR_ITEMS_RESET)}
        >
          Reset
        </Button>
      </div>
      <PlacementSections customEntries={customEntries} />
      <div className="flex items-center justify-between border-t border-foreground/10 py-1.5 pr-1.5 pl-3">
        <span className="font-[450]">Size</span>
        <StatusBarSizeControl size="xs" />
      </div>
      <div className="border-t border-foreground/10 p-1">
        <button
          type="button"
          className={cn(rowClass, 'w-full text-left text-muted-foreground hover:text-foreground')}
          onClick={() => {
            onClose();
            addStatusItemWithAgent();
          }}
        >
          <Plus className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Add an item with your agent…</span>
        </button>
      </div>
    </div>
  );
}
