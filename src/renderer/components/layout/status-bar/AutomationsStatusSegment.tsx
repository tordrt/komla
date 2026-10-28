import { CalendarDots, Gear, Play, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { IconButton } from '@/components/ui/icon-button';
import { menuItemClass } from '@/components/ui/menu-styles';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { describeSchedule, formatRunTime, localTimeZone } from '@/lib/automation-schedule-draft';
import { formatRelativeTime } from '@/lib/format-time';
import { ipcErrorMessage } from '@/lib/ipc-error-message';
import { openWorkspace } from '@/lib/open-workspace';
import { cn } from '@/lib/utils';
import { useAutomationsStore } from '@/stores/automations.store';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { nextAutomationOccurrence } from '../../../../shared/lib/automation-schedule';

import { StatusBarButton } from './StatusBarButton';

import type { Automation, AutomationRun } from '../../../../shared/types/automation';

interface Entry {
  /** Unique across targets: an automation moved between them can briefly be listed by both. */
  key: string;
  automation: Automation;
  /** When it runs, with its time zone when that isn't this computer's. */
  schedule: string;
  lastRun?: AutomationRun;
  /** When it runs next; undefined while it's off. */
  next?: number;
}

function nextRun(automation: Automation, now: number): number | undefined {
  if (!automation.enabled) return undefined;
  try {
    return nextAutomationOccurrence(automation.schedule, now);
  } catch {
    return undefined;
  }
}

/** `09:00` today, else `Tomorrow 09:00` or `Tue, Oct 20, 09:00`, in this computer's time zone. */
function shortRunTime(instant: number, now?: number): string {
  return formatRunTime(instant, localTimeZone(), now).replace(/^Today /, '');
}

/** `Every day at 09:00`, with the city of a time zone whose clock differs from this computer's. */
function describeWhen({ schedule }: Automation, now: number): string {
  const description = describeSchedule(schedule.cron);
  try {
    if (formatRunTime(now, schedule.timeZone, now) === formatRunTime(now, localTimeZone(), now)) {
      return description;
    }
  } catch {
    return description;
  }
  return `${description} ${schedule.timeZone.split('/').pop()!.replace(/_/g, ' ')} time`;
}

/** How long until `instant`, for the bar: `in 25m`, `in 4h` or `in 3d`. */
export function runCountdown(instant: number, now: number): string {
  const minutes = Math.max(1, Math.round((instant - now) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** The time, again each half minute, so the next run moves on once it has passed. */
function useMinuteClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function AutomationRow({
  entry,
  hostName,
  onOpen,
}: {
  entry: Entry;
  hostName?: string;
  onOpen: () => void;
}) {
  const { automation, lastRun, next } = entry;
  const setAutomationEnabled = useAutomationsStore((s) => s.setAutomationEnabled);
  const runAutomationNow = useAutomationsStore((s) => s.runAutomationNow);
  const addToast = useToastStore((s) => s.addToast);
  const currentWindowId = useWindowStore((s) => s.windowId);
  const runWorkspace = useWorkspacesStore((s) =>
    lastRun?.workspaceId ? s.workspaces.find((w) => w.id === lastRun.workspaceId) : undefined
  );
  const [busy, setBusy] = useState(false);

  const withBusy = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      addToast(ipcErrorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  const runNow = () =>
    withBusy(async () => {
      const run = await runAutomationNow(automation.target, automation.id);
      if (run.status === 'started') addToast(`${automation.name} started`, 'success');
      else addToast(run.message ?? `${automation.name} didn’t start`, 'error');
    });

  const ago = lastRun && formatRelativeTime(lastRun.startedAt);
  const when = ago === 'now' ? 'just now' : `${ago} ago`;
  const failed = lastRun?.status === 'failed';

  return (
    <li className="flex items-start gap-2.5 rounded-md px-2 py-1.5">
      <Switch
        className="mt-0.5 h-4 w-7 [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3"
        checked={automation.enabled}
        disabled={busy}
        onCheckedChange={(enabled) =>
          void withBusy(() => setAutomationEnabled(automation.target, automation.id, enabled))
        }
        aria-label={`${automation.enabled ? 'Turn off' : 'Turn on'} ${automation.name}`}
      />
      <div className="min-w-0 flex-1">
        <p className={cn('truncate font-medium', !automation.enabled && 'text-muted-foreground')}>
          {automation.name}
        </p>
        <p className="truncate text-ui text-muted-foreground">
          {[entry.schedule, hostName, next !== undefined ? `Next ${shortRunTime(next)}` : 'Off']
            .filter(Boolean)
            .join(' · ')}
        </p>
        {lastRun && (
          <p className="flex min-w-0 items-center gap-1.5 text-ui text-muted-foreground">
            <span
              className={cn('min-w-0 truncate', failed && 'text-error')}
              title={lastRun.message ?? lastRun.branch ?? undefined}
            >
              {failed
                ? `Failed ${when}`
                : lastRun.status === 'skipped'
                  ? `Skipped ${when}`
                  : `Ran ${when}`}
              {lastRun.status !== 'started' && lastRun.message ? `: ${lastRun.message}` : ''}
            </span>
            {runWorkspace && (
              <button
                type="button"
                className="shrink-0 text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-hidden"
                onClick={() => {
                  void openWorkspace(runWorkspace, currentWindowId);
                  onOpen();
                }}
              >
                Open
              </button>
            )}
          </p>
        )}
      </div>
      <IconButton
        size="xs"
        label={`Run ${automation.name} now`}
        tooltipSide="top"
        onClick={() => void runNow()}
        disabled={busy}
      >
        {busy ? <Spinner className="size-3.5" /> : <Play className="size-3.5" />}
      </IconButton>
    </li>
  );
}

/**
 * The automations of this computer and every SSH host: when the next one runs, or how many failed
 * their last run. Opens a list to turn them on or off, run one now, or open its last run. Shows
 * once there is an automation.
 */
export function AutomationsStatusSegment() {
  const [open, setOpen] = useState(false);
  const snapshots = useAutomationsStore((s) => s.snapshots);
  const loadAutomations = useAutomationsStore((s) => s.loadAutomations);
  const hosts = useSshHostsStore((s) => s.hosts);
  const now = useMinuteClock();

  const entries: Entry[] = snapshots
    .flatMap((snapshot) =>
      snapshot.automations.map((automation) => ({
        key: `${automation.target.kind === 'ssh' ? automation.target.hostId : 'local'}:${automation.id}`,
        automation,
        schedule: describeWhen(automation, now),
        lastRun: snapshot.runs[automation.id]?.[0],
        next: nextRun(automation, now),
      }))
    )
    .sort(
      (a, b) =>
        (a.next ?? Number.POSITIVE_INFINITY) - (b.next ?? Number.POSITIVE_INFINITY) ||
        a.automation.name.localeCompare(b.automation.name)
    );
  if (entries.length === 0) return null;

  // A turned-off automation won't run again, so its failure would never clear.
  const failed = entries.filter(
    (entry) => entry.automation.enabled && entry.lastRun?.status === 'failed'
  ).length;
  const on = entries.filter((entry) => entry.automation.enabled).length;
  const soonest = entries[0].next !== undefined ? entries[0] : undefined;
  const soonestAt = soonest && shortRunTime(soonest.next!, now);
  const summary = [
    failed > 0 && `${failed} failed`,
    soonest ? `${soonest.automation.name} runs next, ${soonestAt}` : 'All automations are off',
  ]
    .filter(Boolean)
    .join(' · ');
  const hostName = ({ target }: Automation) =>
    target.kind === 'ssh'
      ? (hosts.find((host) => host.id === target.hostId)?.name ?? 'Removed SSH host')
      : undefined;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // SSH hosts start runs on their own, so read them again for the latest results.
        if (next) void loadAutomations();
      }}
    >
      <PopoverTrigger asChild>
        <StatusBarButton
          aria-label={`Automations: ${summary}`}
          tooltip={summary}
          className={cn(
            'tabular-nums',
            !soonest && 'text-muted-foreground/60',
            failed > 0 && 'text-error hover:text-error data-[state=open]:text-error'
          )}
        >
          {failed > 0 ? (
            <WarningCircle aria-hidden="true" weight="fill" className="size-3.5" />
          ) : (
            <CalendarDots aria-hidden="true" className="size-3.5" />
          )}
          {failed > 0 ? (
            <span>
              {failed}
              <span className="@max-3xl:hidden"> failed</span>
            </span>
          ) : (
            soonest && <span className="@max-3xl:hidden">{runCountdown(soonest.next!, now)}</span>
          )}
        </StatusBarButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-96 p-0 text-xs">
        <div className="flex items-center justify-between gap-3 border-b border-foreground/10 px-3 py-2">
          <h2 className="text-[13px] font-semibold">Automations</h2>
          <span className="flex items-center gap-2.5 text-ui text-muted-foreground tabular-nums">
            {failed > 0 && <span className="text-error">{failed} failed</span>}
            <span>
              {on} of {entries.length} on
            </span>
          </span>
        </div>
        <ul aria-label="Automations" className="max-h-[60vh] overflow-y-auto p-1.5">
          {entries.map((entry) => (
            <AutomationRow
              key={entry.key}
              entry={entry}
              hostName={hostName(entry.automation)}
              onOpen={() => setOpen(false)}
            />
          ))}
        </ul>
        <div className="border-t border-foreground/10 p-1">
          <button
            type="button"
            className={cn(menuItemClass, 'w-full hover:bg-foreground/8')}
            onClick={() => {
              setOpen(false);
              useSettingsDialogStore.getState().openSettings({ tab: 'automations' });
            }}
          >
            <Gear />
            Manage automations
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
