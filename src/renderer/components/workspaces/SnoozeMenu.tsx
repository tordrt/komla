import { Alarm, BellSimple } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  formatSnoozeRemaining,
  formatSnoozeTime,
  getSnoozePresets,
  HOUR_MS,
  toDateTimeInputValue,
} from '@/lib/snooze';
import { useConfigStore } from '@/stores/config.store';

import { CI_WATCH_LIMIT_MS, notifiesCiFinished } from '../../../shared/lib/pull-request-ci';

import type { Workspace } from '@/types';

/**
 * Whether the workspace's pull request has checks running that notify it when they finish, read
 * as its menu opens.
 */
export function useCiRunning(workspace: Workspace, enabled: boolean): boolean {
  const notifies = useConfigStore((s) => !!s.config && notifiesCiFinished(s.config));
  const watched = enabled && notifies && !!workspace.isWorktree;
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!watched) return;
    let current = true;
    window.api.getWorkspacePullRequestStatus(workspace.id).then(
      (status) => {
        if (!current) return;
        const pullRequest = status.kind === 'pull-request' ? status.pullRequest : undefined;
        setRunning(
          pullRequest?.ci === 'pending' &&
            (pullRequest.state === 'open' || pullRequest.state === 'draft')
        );
      },
      () => {}
    );
    return () => {
      current = false;
    };
  }, [watched, workspace.id]);
  return watched && running;
}

/**
 * Snooze ▸ until its next notification, while `untilNotified` says one will come, until its CI
 * finishes, while it runs, the presets, each with when it ends, then Custom…
 */
export function SnoozeSubmenu({
  untilNotified,
  untilCiFinishes = false,
  onSnooze,
  onCustom,
}: {
  untilNotified: boolean;
  untilCiFinishes?: boolean;
  onSnooze: (until: number | undefined, wakesOnNotification?: boolean) => void;
  onCustom: () => void;
}) {
  const now = new Date();
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Alarm />
        Snooze
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {untilNotified && (
          <ContextMenuItem onClick={() => onSnooze(undefined, true)}>
            Until Notified
          </ContextMenuItem>
        )}
        {untilCiFinishes && (
          // CI notifies when it finishes; checks no longer watched after a few hours wake it then.
          <ContextMenuItem onClick={() => onSnooze(Date.now() + CI_WATCH_LIMIT_MS, true)}>
            Until CI Finishes
          </ContextMenuItem>
        )}
        {(untilNotified || untilCiFinishes) && <ContextMenuSeparator />}
        {getSnoozePresets(now).map((preset) => (
          <ContextMenuItem key={preset.label} onClick={() => onSnooze(preset.until)}>
            {preset.label}
            <ContextMenuShortcut>{formatSnoozeTime(preset.until, now)}</ContextMenuShortcut>
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onCustom}>Custom...</ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

export function CustomSnoozeDialog({
  open,
  onOpenChange,
  onSnooze,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (until: number) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {/* Mounted per opening, so the field starts an hour out each time. */}
        {open && <CustomSnoozeForm onCancel={() => onOpenChange(false)} onSnooze={onSnooze} />}
      </DialogContent>
    </Dialog>
  );
}

function CustomSnoozeForm({
  onCancel,
  onSnooze,
}: {
  onCancel: () => void;
  onSnooze: (until: number) => void;
}) {
  const [value, setValue] = useState(() => toDateTimeInputValue(Date.now() + HOUR_MS));
  // datetime-local values parse as local time.
  const until = value ? new Date(value).getTime() : NaN;
  const isFuture = () => Number.isFinite(until) && until > Date.now();
  const submit = () => {
    // Checked again here: the time can pass while the dialog is open.
    if (isFuture()) onSnooze(until);
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Snooze Until</DialogTitle>
        <DialogDescription>
          The workspace waits on the Snoozed shelf and comes back marked Woke.
        </DialogDescription>
      </DialogHeader>
      <Input
        type="datetime-local"
        aria-label="Snooze until"
        value={value}
        min={toDateTimeInputValue(Date.now())}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        autoFocus
      />
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!isFuture()} onClick={submit}>
          Snooze
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * How long a snoozed workspace has left, on its card, with a bell for one snoozed until notified;
 * the card's minute tick refreshes it.
 */
export function SnoozeCountdown({
  until,
  untilNotified,
}: {
  until: number | undefined;
  untilNotified?: boolean;
}) {
  const now = Date.now();
  const deadline = until !== undefined;
  const untilText = deadline ? formatSnoozeTime(until, new Date(now)) : '';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex shrink-0 items-center gap-0.5 text-2xs text-muted-foreground tabular-nums">
          {untilNotified ? (
            <BellSimple aria-hidden="true" weight="bold" className="size-3" />
          ) : (
            <Alarm aria-hidden="true" weight="bold" className="size-3" />
          )}
          {deadline && formatSnoozeRemaining(until, now)}
          <span className="sr-only">{deadline ? 'left snoozed' : 'snoozed until notified'}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        {!untilNotified
          ? `Snoozed until ${untilText}`
          : deadline
            ? `Snoozed until its next notification, or ${untilText}`
            : 'Snoozed until its next notification'}
      </TooltipContent>
    </Tooltip>
  );
}
