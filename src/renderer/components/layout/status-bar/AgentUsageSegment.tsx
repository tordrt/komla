import { ArrowClockwise, CaretDown } from '@phosphor-icons/react';
import { useEffect, useId, useState } from 'react';

import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';

import {
  AGENT_USAGE_POLL_INTERVAL_MS,
  AGENT_USAGE_RATE_LIMITED_BACKOFF_MS,
} from '../../../../shared/constants/agent-usage';

import { StatusBarButton } from './StatusBarButton';

import type {
  AgentUsageReading,
  AgentUsageSource,
  AgentUsageWindow,
} from '../../../../shared/types/agent-usage';
import type { AppConfig } from '@/types';

const AGENT_NAMES: Record<AgentUsageSource, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A rate-limited reading at most this old isn't dimmed: one backoff held it back, not two.
const RATE_LIMITED_FRESH_MS = 2 * AGENT_USAGE_RATE_LIMITED_BACKOFF_MS;
// From here a limit turns amber.
const NEARLY_FULL_PERCENT = 75;
// From here the bar's automatic choice shows the 5-hour limit beside the weekly.
const SHORTER_LIMIT_SHOWN_PERCENT = 85;

type BarLimits = NonNullable<AppConfig['statusBarUsageLimits']>;

/** What the bar can show of each agent's limits; a plan with one limit shows it for each. */
export const USAGE_LIMIT_BAR_CHOICES: { value: BarLimits; label: string; description: string }[] = [
  {
    value: 'auto',
    label: 'Auto',
    description: `Weekly, and 5-hour once it reaches ${SHORTER_LIMIT_SHOWN_PERCENT}%`,
  },
  { value: 'five-hour', label: '5-hour limit', description: 'Only the 5-hour limit' },
  { value: 'weekly', label: 'Weekly limit', description: 'Only the weekly limit' },
  { value: 'both', label: 'Both', description: '5-hour and weekly' },
];

/** Usage starts over once a limit resets, even before the next read. */
export function currentPercent(window: AgentUsageWindow, now: number): number {
  return window.resetsAt !== null && window.resetsAt <= now ? 0 : Math.round(window.usedPercent);
}

/**
 * The limits the bar shows. By default that's the longest, such as the weekly one, and the
 * shortest, such as the five-hour one, beside it only once that is nearly full, when it is the
 * one about to stop the agent.
 */
export function barWindows(
  windows: AgentUsageWindow[],
  now: number,
  limits: BarLimits = 'auto'
): (AgentUsageWindow & { percent: number })[] {
  const named = windows
    .filter((window) => window.short !== null)
    .map((window) => ({ ...window, percent: currentPercent(window, now) }));
  const first = named[0];
  const last = named[named.length - 1];
  if (!first) return [];
  if (limits === 'five-hour') return [first];
  if (limits === 'weekly') return [last];
  if (limits === 'both') return named;
  return first !== last && first.percent >= SHORTER_LIMIT_SHOWN_PERCENT ? [first, last] : [last];
}

function toneClass(percent: number): string {
  if (percent >= 90) return 'text-error';
  if (percent >= NEARLY_FULL_PERCENT) return 'text-warning';
  return '';
}

function barClass(percent: number): string {
  if (percent >= 90) return 'bg-error';
  if (percent >= NEARLY_FULL_PERCENT) return 'bg-warning';
  return 'bg-muted-foreground';
}

function formatDuration(ms: number): string {
  if (ms >= DAY) return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`;
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m`;
  return `${Math.max(1, Math.ceil(ms / MINUTE))}m`;
}

/** How long until the limit resets, or null when it isn't known or already has. */
function timeUntilReset(window: AgentUsageWindow, now: number): string | null {
  return window.resetsAt !== null && window.resetsAt > now
    ? formatDuration(window.resetsAt - now)
    : null;
}

function formatAgo(ms: number): string {
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}

/** How long until a rate-limited provider is asked again; 0 once it is being asked. */
function retryWait(reading: AgentUsageReading, now: number): number {
  if (reading.problem !== 'rate-limited' || reading.retryAt === null) return 0;
  // The minute clock can be a minute behind a reading that just came.
  return Math.max(0, reading.retryAt - Math.max(now, Date.now()));
}

function problemText(reading: AgentUsageReading, name: string, now: number): string | null {
  if (reading.problem === 'signed-out') {
    return `Sign in to ${name} with a plan on this computer to see its usage.`;
  }
  if (reading.problem === 'expired') {
    return `${name}'s sign-in has expired. It renews when you next run ${name}.`;
  }
  if (reading.problem === 'rate-limited') {
    const wait = retryWait(reading, now);
    return (
      `${name} limits how often its usage can be read, by Komla or any other app. ` +
      (wait > 0 ? `Komla asks again in ${formatDuration(wait)}.` : 'Komla is asking again.')
    );
  }
  if (reading.problem === 'unavailable') return 'Could not read the latest usage.';
  return null;
}

/** Dimmed while reads fail, except while rate limited with a reading that's still recent. */
function isDimmed(reading: AgentUsageReading, now: number): boolean {
  if (reading.problem !== 'rate-limited') return reading.problem !== null;
  return reading.readAt === 0 || now - reading.readAt > RATE_LIMITED_FRESH_MS;
}

function UsageBar({ percent, className }: { percent: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('block h-1 overflow-hidden rounded-full bg-foreground/15', className)}
    >
      <span
        className={cn('block h-full rounded-full', barClass(percent))}
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}

/** An agent's usage, read when the bar shows it, every few minutes, and on focus. */
function useAgentUsage(source: AgentUsageSource): AgentUsageReading | undefined {
  const [reading, setReading] = useState<AgentUsageReading>();
  useEffect(() => {
    let cancelled = false;
    const apply = (usage: Partial<Record<AgentUsageSource, AgentUsageReading>>) => {
      if (!cancelled) setReading(usage[source]);
    };
    const unsubscribe = window.api.onAgentUsageChange(apply);
    window.api.getAgentUsage().then(apply, () => {});
    // The main process skips reads asked for within a few minutes of the last.
    const refresh = () => {
      if (!document.hidden)
        window.api.refreshAgentUsage({ sources: [source] }).then(apply, () => {});
    };
    refresh();
    const interval = setInterval(refresh, AGENT_USAGE_POLL_INTERVAL_MS);
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [source]);
  return reading;
}

function useMinuteClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), MINUTE);
    return () => clearInterval(interval);
  }, []);
  return now;
}

/** The popover's footer row that picks which limits the bar shows, for both agents. */
function BarLimitsPicker() {
  const limits = useConfigStore((s) => s.config?.statusBarUsageLimits ?? 'auto');
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const label = USAGE_LIMIT_BAR_CHOICES.find((choice) => choice.value === limits)?.label;
  return (
    <div className="flex items-center justify-between gap-2 border-t border-foreground/10 px-3 py-1.5">
      <span className="shrink-0 text-ui text-muted-foreground">Status bar shows</span>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Status bar shows: ${label}`}
            className="flex min-w-0 items-center gap-1 rounded-lg px-1.5 py-0.5 text-ui hover:bg-foreground/6 data-[state=open]:bg-foreground/6"
          >
            <span className="truncate">{label}</span>
            <CaretDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-72 min-w-0">
          <DropdownMenuRadioGroup
            value={limits}
            onValueChange={(value) =>
              void updateConfig({ statusBarUsageLimits: value as BarLimits })
            }
          >
            {USAGE_LIMIT_BAR_CHOICES.map((choice) => (
              <DropdownMenuRadioItem
                key={choice.value}
                value={choice.value}
                aria-label={choice.label}
                aria-describedby={`usage-limits-${choice.value}`}
                className="items-start py-1.5"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{choice.label}</span>
                  <span
                    id={`usage-limits-${choice.value}`}
                    className="text-ui text-muted-foreground"
                  >
                    {choice.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The popover's footer row that turns the time until reset in the bar on or off, for both agents. */
function ResetTimeToggle() {
  const shown = useConfigStore((s) => s.config?.statusBarUsageResetTime ?? true);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-2 border-t border-foreground/10 px-3 py-1.5">
      <label htmlFor={id} className="shrink-0 text-ui text-muted-foreground">
        Time until reset
      </label>
      <Switch
        id={id}
        checked={shown}
        onCheckedChange={(checked) => void updateConfig({ statusBarUsageResetTime: checked })}
      />
    </div>
  );
}

function UsagePopover({
  name,
  reading,
  now,
}: {
  name: string;
  reading: AgentUsageReading;
  now: number;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshing(true);
    void window.api
      .refreshAgentUsage({ sources: [reading.source], force: true })
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };
  const problem = problemText(reading, name, now);
  const plan = reading.plan && `${reading.plan[0].toUpperCase()}${reading.plan.slice(1)} plan`;
  const detail = [plan, reading.account].filter(Boolean).join(' · ');

  return (
    <>
      <div className="flex items-center gap-1.5 border-b border-foreground/10 px-3 py-1.5 font-status">
        <AgentPresetIcon preset={{ name }} className="size-3.5 shrink-0" />
        <h2 className="truncate text-[13px] font-semibold">{name} usage</h2>
        <IconButton
          label="Refresh"
          size="xs"
          variant="ghost"
          className="ml-auto"
          disabled={refreshing || retryWait(reading, now) > 0}
          onClick={refresh}
        >
          <ArrowClockwise className={refreshing ? 'animate-spin' : undefined} />
        </IconButton>
      </div>
      <div className="space-y-2.5 px-3 py-2.5">
        {detail && <div className="truncate text-muted-foreground">{detail}</div>}
        {reading.windows.map((window) => {
          const percent = currentPercent(window, now);
          const untilReset = timeUntilReset(window, now);
          return (
            <div key={window.name}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate">{window.name}</span>
                <span className={cn('shrink-0 tabular-nums', toneClass(percent))}>
                  {percent}% used
                </span>
              </div>
              <UsageBar percent={percent} className="w-full" />
              {window.resetsAt !== null && (
                <div className="mt-1 text-2xs text-muted-foreground">
                  {untilReset ? `Resets in ${untilReset}` : 'Reset since the last read'}
                </div>
              )}
            </div>
          );
        })}
        {problem && <p className="text-warning">{problem}</p>}
        {reading.readAt > 0 && (
          <p className="text-2xs text-muted-foreground">
            Updated {formatAgo(now - reading.readAt)}
          </p>
        )}
      </div>
      <BarLimitsPicker />
      <ResetTimeToggle />
    </>
  );
}

function AgentUsageItem({
  name,
  reading,
  now,
}: {
  name: string;
  reading: AgentUsageReading;
  now: number;
}) {
  const limits = useConfigStore((s) => s.config?.statusBarUsageLimits);
  const resetTimeShown = useConfigStore((s) => s.config?.statusBarUsageResetTime ?? true);
  const inBar = barWindows(reading.windows, now, limits).map((window) => ({
    ...window,
    untilReset: resetTimeShown ? timeUntilReset(window, now) : null,
  }));
  const summary =
    inBar.length > 0
      ? inBar
          .map(
            (window) =>
              `${window.percent}% of the ${window.name.toLowerCase()}` +
              (window.untilReset ? `, resets in ${window.untilReset}` : '')
          )
          .join('; ')
      : (problemText(reading, name, now) ?? 'no limits reported');

  return (
    <Popover>
      <PopoverTrigger asChild>
        <StatusBarButton
          aria-label={`${name} usage: ${summary}`}
          tooltip={reading.problem ? problemText(reading, name, now) : `${name} plan usage`}
          className={cn('gap-1.5 tabular-nums', isDimmed(reading, now) && 'opacity-60')}
        >
          <AgentPresetIcon preset={{ name }} className="size-3" />
          {inBar.length === 0 && <span>–</span>}
          {inBar.map((window, index) => (
            <span key={window.name} className={toneClass(window.percent)}>
              {index > 0 && <span className="mr-1.5 text-muted-foreground/60">·</span>}
              {window.percent}%
              {/* The time left tells the limits apart, so the limit's name only shows without it. */}
              {window.untilReset ? (
                <span className="ml-1.5 text-muted-foreground">{window.untilReset}</span>
              ) : (
                ` ${window.short}`
              )}
            </span>
          ))}
        </StatusBarButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64 p-0 text-xs">
        <UsagePopover name={name} reading={reading} now={now} />
      </PopoverContent>
    </Popover>
  );
}

/** An agent's plan usage limits, for the account signed in on this computer. */
export function AgentUsageSegment({ source }: { source: AgentUsageSource }) {
  const reading = useAgentUsage(source);
  const now = useMinuteClock();
  return reading && <AgentUsageItem name={AGENT_NAMES[source]} reading={reading} now={now} />;
}
