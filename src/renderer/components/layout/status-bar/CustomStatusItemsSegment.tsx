import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { CheckedIcon } from '@/components/ui/checked-icon';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useActionLauncher } from '@/hooks/useActionLauncher';
import { findStatusItemAction } from '@/lib/action-visibility';
import { statusItemColorProps } from '@/lib/status-item-color';
import { cn } from '@/lib/utils';
import { useActionsStore } from '@/stores/actions.store';
import { useConfigStore } from '@/stores/config.store';
import {
  isStatusCommandDue,
  loadStatusCommandList,
  markStatusCommandOutdated,
  runStatusCommand,
  setAgentStatusItems,
  statusCommandKey,
  useStatusItemsStore,
} from '@/stores/status-items.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { isStatusIconSegment } from '../../../../shared/types/status-items';

import { isStatusBarItemShown } from './status-bar-items';
import { StatusBarButton } from './StatusBarButton';
import {
  AgentItemPopover,
  CommandItemPopover,
  KeptAgentHtmlPopover,
  linkHost,
  STATUS_POPOVER_WIDTH,
} from './StatusItemPopover';

import type { CustomStatusItemKey } from './status-bar-items';
import type {
  StatusCommand,
  StatusCommandList,
  StatusIconSegment,
  StatusItemContent,
  StatusItemSegment,
  StatusItemTone,
  WindowStatusItem,
} from '../../../../shared/types/status-items';

const TONE_DOT: Record<StatusItemTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-destructive',
  info: 'bg-info',
};

const NO_COMMANDS: StatusCommandList = { items: [] };
// Commands run every 10 seconds at most often, so this keeps them close to their interval.
const DUE_CHECK_MS = 1000;

/** Every workspace's items that agents set with `komla status set`, as they change. */
export function useAgentStatusItems(): WindowStatusItem[] {
  const items = useStatusItemsStore((s) => s.agentItems);
  useEffect(() => {
    let cancelled = false;
    void window.api
      .listStatusItems()
      .then((list) => {
        if (!cancelled) setAgentStatusItems(list);
      })
      .catch(() => {});
    const unsubscribe = window.api.onStatusItemsChange(setAgentStatusItems);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return items;
}

/**
 * The items status-items.json defines for the workspace, as the file changes. A workspace opened
 * before shows the list it had while it's listed again.
 */
export function useStatusCommandList(workspaceId: string | null): StatusCommandList {
  const list = useStatusItemsStore((s) => (workspaceId ? s.commandLists[workspaceId] : undefined));

  useEffect(() => {
    if (!workspaceId) return;
    const load = () => void loadStatusCommandList(workspaceId).catch(() => {});
    load();
    return window.api.onStatusCommandsChange(load);
  }, [workspaceId]);

  return list ?? NO_COMMANDS;
}

/**
 * Runs each command once its interval has passed while the window is visible, or once
 * status-items.json changed, as its listing then does. Runs are kept per workspace, so switching
 * back to one shows its items at once and runs only those that are due; those show as outdated
 * until their run ends.
 */
function useStatusCommandSchedule(workspaceId: string | null, commands: StatusCommand[]): void {
  useEffect(() => {
    if (!workspaceId || commands.length === 0) return;
    // Runs the commands that are due. Opening the workspace or showing the window again catches
    // up on the runs it skipped.
    const runDue = (catchingUp: boolean) => {
      if (document.visibilityState === 'hidden') return;
      for (const command of commands) {
        if (!isStatusCommandDue(workspaceId, command)) continue;
        if (catchingUp) markStatusCommandOutdated(workspaceId, command);
        void runStatusCommand(workspaceId, command);
      }
    };
    const catchUp = () => runDue(true);
    runDue(true);
    const timer = setInterval(() => runDue(false), DUE_CHECK_MS);
    document.addEventListener('visibilitychange', catchUp);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', catchUp);
    };
  }, [workspaceId, commands]);
}

/**
 * An icon an item shows, an image Komla's main process read and checked. With a color, its shape
 * shows in that color, so a one-color logo follows the theme; without, it keeps its own colors.
 */
function StatusIcon({ icon }: { icon: StatusIconSegment }) {
  if (!icon.icon.startsWith('data:image/')) return null;
  return (
    <CheckedIcon
      src={icon.icon}
      color={icon.color}
      className={cn(
        'inline-block align-[-0.2em]',
        icon.color ? 'size-[1.1em]' : 'h-[1.1em] w-auto max-w-[4em]'
      )}
    />
  );
}

// Keys from what each part shows, counted when a part repeats.
function segmentKeys(segments: StatusItemSegment[]): string[] {
  const seen = new Map<string, number>();
  return segments.map((segment) => {
    const shows = isStatusIconSegment(segment) ? `icon:${segment.icon}` : `text:${segment.text}`;
    const count = seen.get(shows) ?? 0;
    seen.set(shows, count + 1);
    return `${shows}:${count}`;
  });
}

function StatusItemText({ content }: { content: StatusItemContent }) {
  const { text, segments, color } = content;
  const { className, style } = statusItemColorProps(color);
  const keys = segments && segmentKeys(segments);
  return (
    <span className={cn('max-w-[24ch] truncate font-status tabular-nums', className)} style={style}>
      {segments
        ? segments.map((segment, index) => {
            const key = keys![index];
            if (isStatusIconSegment(segment)) return <StatusIcon key={key} icon={segment} />;
            const colors = statusItemColorProps(segment.color);
            return (
              <span
                key={key}
                className={cn(colors.className, segment.bold && 'font-semibold')}
                style={colors.style}
              >
                {segment.text}
              </span>
            );
          })
        : text}
    </span>
  );
}

interface StatusItemButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'content'
> {
  itemKey: string;
  content: StatusItemContent;
  /** The item's name, for the right-click menu, when it isn't what the item shows. */
  label?: string;
  /** Why the item shows its last output, as when its last run failed. */
  staleReason?: string;
  /** What clicking does, such as "opens github.com", for the tooltip and screen readers. */
  hint?: string;
}

const StatusItemButton = React.forwardRef<HTMLButtonElement, StatusItemButtonProps>(
  ({ itemKey, content, label, staleReason, hint, className, ...props }, ref) => {
    const { text, tone, tooltip } = content;
    return (
      <StatusBarButton
        ref={ref}
        data-status-item={itemKey}
        data-status-item-label={label ?? text}
        aria-label={hint ? `${text}, ${hint}` : text}
        tooltip={
          <div className="max-w-xs space-y-0.5">
            <div className="whitespace-pre-wrap">{tooltip ?? text}</div>
            {staleReason && <div className="text-muted-foreground">{staleReason}</div>}
            {hint && <div className="text-muted-foreground first-letter:uppercase">{hint}</div>}
          </div>
        }
        className={cn(!hint && 'cursor-default', staleReason && 'opacity-60', className)}
        {...props}
      >
        {tone && (
          <span aria-hidden="true" className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />
        )}
        <StatusItemText content={content} />
      </StatusBarButton>
    );
  }
);
StatusItemButton.displayName = 'StatusItemButton';

/** An item with a popover, which renders only while open. */
function PopoverItem({
  children,
  onPointerOver,
  onPrepare,
  open: shown,
  onOpenChange,
  ...item
}: Pick<StatusItemButtonProps, 'itemKey' | 'content' | 'label' | 'staleReason'> & {
  children: (close: () => void) => React.ReactNode;
  /** Whether the pointer is over the item, so its popover can get ready. */
  onPointerOver?: (over: boolean) => void;
  /** Gets the popover ready as focus comes to the item, which it keeps once the popover closes. */
  onPrepare?: () => void;
  /** Whether it's open, for an item that keeps track itself. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = shown ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <StatusItemButton
          {...item}
          hint="shows details"
          {...(onPointerOver && {
            onPointerEnter: () => onPointerOver(true),
            onPointerLeave: () => onPointerOver(false),
          })}
          onFocus={onPrepare}
        />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="p-0"
        style={{ width: STATUS_POPOVER_WIDTH }}
      >
        {open && children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * An agent item with an HTML popover. Its page loads once the pointer comes over the item, or
 * focus does, and stays loaded, so the popover opens with it drawn. It follows the pages the agent
 * sets while the pointer is over the item or its popover is open, not in the background.
 */
function AgentHtmlItem({ item, itemKey }: { item: WindowStatusItem; itemKey: string }) {
  const [open, setOpen] = useState(false);
  const [pointed, setPointed] = useState(false);
  // The item as it was when it last had the pointer or its popover open.
  const [kept, setKept] = useState<WindowStatusItem | null>(null);
  const [container] = useState(() => document.createElement('div'));
  const shown = open || pointed ? item : kept;
  // Keeps the item it follows once it stops following.
  const follow = (change: () => void) => {
    setKept(item);
    change();
  };
  return (
    <>
      <PopoverItem
        itemKey={itemKey}
        content={item}
        open={open}
        onOpenChange={(next) => follow(() => setOpen(next))}
        onPointerOver={(over) => follow(() => setPointed(over))}
        onPrepare={() => setKept(item)}
      >
        {() => <AgentItemPopover item={item} htmlContainer={container} />}
      </PopoverItem>
      {shown && (
        <KeptAgentHtmlPopover
          item={shown}
          open={open}
          onClose={() => follow(() => setOpen(false))}
          container={container}
        />
      )}
    </>
  );
}

/** A link item opens its link; any other item only shows. */
function LinkItem(
  item: Pick<StatusItemButtonProps, 'itemKey' | 'content' | 'label' | 'staleReason'>
) {
  const { link } = item.content;
  return (
    <StatusItemButton
      {...item}
      hint={link ? `opens ${linkHost(link)}` : undefined}
      onClick={link ? () => void window.api.openExternal(link) : undefined}
    />
  );
}

/** A custom item of the open workspace, shown or hidden, by its key in the bar's settings. */
export type CustomStatusItemEntry = {
  key: CustomStatusItemKey;
  label: string;
  kind: 'command' | 'agent';
};

/** The open workspace's custom items, shown or hidden: status-items.json's, then its agents'. */
export function customStatusItemEntries(
  commands: StatusCommand[],
  agentItems: WindowStatusItem[]
): CustomStatusItemEntry[] {
  return [
    ...commands.map((command) => ({
      key: `command:${command.id}` as const,
      label: command.label ?? command.id,
      kind: 'command' as const,
    })),
    ...agentItems.map((item) => ({
      key: `agent:${item.id}` as const,
      label: item.text,
      kind: 'agent' as const,
    })),
  ];
}

/**
 * The open workspace's custom items: those agents set with `komla status set`, and those
 * status-items.json defines, whose commands Komla runs in the workspace. `entries` lists every
 * item, hidden ones too; `rendered` holds each shown item by key, for the bar to place one by
 * one; `extras` is a warning about status-items.json and the Action input dialog.
 */
export function useCustomStatusItems(): {
  entries: CustomStatusItemEntry[];
  rendered: Map<string, React.ReactNode>;
  extras: React.ReactNode;
} {
  const workspaceId = useWorkspacesStore((s) => s.selectedWorkspaceId);
  const hiddenItems = useConfigStore((s) => s.config?.statusBarHiddenItems);
  const workspaceAgentItems = useAgentStatusItems().filter(
    (item) => item.workspaceId === workspaceId
  );
  const agentItems = workspaceAgentItems.filter((item) =>
    isStatusBarItemShown({ statusBarHiddenItems: hiddenItems }, `agent:${item.id}`)
  );
  const commandList = useStatusCommandList(workspaceId);
  // Hidden items don't run; memoized so the commands keep their schedule between renders.
  const commands = useMemo(
    () =>
      commandList.items.filter((command) =>
        isStatusBarItemShown({ statusBarHiddenItems: hiddenItems }, `command:${command.id}`)
      ),
    [commandList, hiddenItems]
  );
  useStatusCommandSchedule(workspaceId, commands);
  // Only the open workspace's items, so others' runs don't render the bar again.
  const results = useStatusItemsStore(
    useShallow((s) =>
      workspaceId
        ? commands.map((command) => s.results[statusCommandKey(workspaceId, command)])
        : []
    )
  );
  const projectId = useWorkspacesStore(
    (s) => s.workspaces.find((workspace) => workspace.id === workspaceId)?.projectId
  );
  const { runAction, actionInputDialog } = useActionLauncher(workspaceId ?? '');

  // Actions load with the tab bar; reading them again finds one added since.
  const runNamedAction = async (name: string) => {
    const store = useActionsStore.getState();
    let action = findStatusItemAction(store.actions, name, projectId);
    if (!action) {
      await store.loadActions();
      action = findStatusItemAction(useActionsStore.getState().actions, name, projectId);
    }
    if (action) runAction(action);
    else {
      useToastStore
        .getState()
        .addToast(
          `This project has no quick command named “${name}”. Check status-items.json.`,
          'error'
        );
    }
  };

  const commandItems = commands.flatMap((command, index) => {
    const result = results[index];
    if (!result) return [];
    const name = command.label ?? command.id;
    // An item that shows only icons reads as its name; one whose run failed keeps what it showed.
    const content: StatusItemContent | null = result.content
      ? { ...result.content, text: result.content.text || name }
      : result.error !== undefined
        ? {
            text: name,
            tone: 'error',
            tooltip: `${name} failed in status-items.json: ${result.error}`,
          }
        : null;
    const staleReason = !result.content
      ? undefined
      : result.error !== undefined
        ? `The last run failed: ${result.error}`
        : result.outdated
          ? 'From an earlier run; updating…'
          : undefined;
    return content ? [{ command, name, content, staleReason }] : [];
  });

  const rendered = new Map<string, React.ReactNode>();
  for (const { command, name, content, staleReason } of commandItems) {
    const key = `command:${command.id}`;
    const item = { itemKey: key, content, label: name, staleReason };
    if (command.popover && workspaceId) {
      rendered.set(
        key,
        <PopoverItem key={key} {...item}>
          {(close) => (
            <CommandItemPopover
              workspaceId={workspaceId}
              command={command}
              title={name}
              onClose={close}
              onRunAction={(action) => {
                close();
                void runNamedAction(action);
              }}
              onCommandDone={() => void runStatusCommand(workspaceId, command)}
            />
          )}
        </PopoverItem>
      );
    } else if (command.action) {
      const action = command.action;
      rendered.set(
        key,
        <StatusItemButton
          key={key}
          {...item}
          hint={`runs ${action}`}
          onClick={() => void runNamedAction(action)}
        />
      );
    } else {
      rendered.set(key, <LinkItem key={key} {...item} />);
    }
  }
  for (const item of agentItems) {
    const key = `agent:${item.id}`;
    rendered.set(
      key,
      item.popoverPageId ? (
        // Its own in each workspace, as the page it keeps is that workspace's.
        <AgentHtmlItem key={`${item.workspaceId}:${key}`} item={item} itemKey={key} />
      ) : item.popoverMarkdown ? (
        <PopoverItem key={key} itemKey={key} content={item}>
          {() => <AgentItemPopover item={item} />}
        </PopoverItem>
      ) : (
        <LinkItem key={key} itemKey={key} content={item} />
      )
    );
  }

  return {
    entries: customStatusItemEntries(commandList.items, workspaceAgentItems),
    rendered,
    extras: (
      <>
        {commandList.problem && (
          <StatusItemButton
            itemKey="status-items-problem"
            content={{ text: 'status-items.json', tone: 'warning', tooltip: commandList.problem }}
          />
        )}
        {actionInputDialog}
      </>
    ),
  };
}
