import { CaretDown, CaretRight, Cloud, Cpu, Desktop } from '@phosphor-icons/react';
import { Fragment, useEffect, useState, type ReactNode } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { openWorkspace } from '@/lib/open-workspace';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isSshWorkspace, type AppConfig, type SshHost, type Workspace } from '@/types';

import { StatusBarButton } from './StatusBarButton';
import { workspaceLabel } from './StatusBarWorkspaceRow';

import type {
  KomlaProcessKind,
  KomlaProcessUsage,
  MachineResourceUsage,
  ResourceUsage,
  WorkspaceResourceUsage,
} from '../../../../shared/types/resource-usage';

interface MachineReads {
  /** How long after each answer to read again; CPU is the change since the previous read. */
  refreshMs: number;
  /** How long after an answer that says why the machine couldn't be read. */
  failedRefreshMs?: number;
  /** Whether ssh may ask for a password. */
  prompt?: boolean;
  /** How old a reading, in ms, can serve, such as one another window just asked for. */
  maxAgeMs?: number;
}

// The open popover, which someone is looking at.
const POPOVER_READS: MachineReads = { refreshMs: 2500, prompt: true };
// The bar reads a machine for as long as Komla runs, unasked: less often, never asking for a
// password, and sharing what other windows' bars read.
const BAR_READS: MachineReads = {
  refreshMs: 5000,
  failedRefreshMs: 30_000,
  prompt: false,
  maxAgeMs: 4500,
};
// On Windows each read starts PowerShell, or a whole ssh connection as there's no ControlMaster,
// which a slower computer feels every few seconds.
const WINDOWS_BAR_READS: MachineReads = { ...BAR_READS, refreshMs: 15_000, maxAgeMs: 14_500 };
const GB = 1024 ** 3;
const MB = 1024 ** 2;

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / MB)} MB`;
}

function formatCpu(percent: number | null): string {
  return percent === null ? '–' : `${Math.round(percent)}%`;
}

function sumUsage(parts: ResourceUsage[]): ResourceUsage {
  return {
    cpuPercent: parts.some((part) => part.cpuPercent !== null)
      ? parts.reduce((sum, part) => sum + (part.cpuPercent ?? 0), 0)
      : null,
    memoryBytes: parts.reduce((sum, part) => sum + part.memoryBytes, 0),
  };
}

function useKomlaMetrics(enabled: boolean): { cpuPercent: number; memoryMB: number } | null {
  const [metrics, setMetrics] = useState<{ cpuPercent: number; memoryMB: number } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = () => {
      if (document.hidden) return;
      window.api
        .getSystemMetrics()
        .then((next) => {
          if (!cancelled) setMetrics(next);
        })
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      // Switched back on later, it starts again from nothing rather than from an old reading.
      setMetrics(null);
    };
  }, [enabled]);
  return enabled ? metrics : null;
}

/** SSH hosts with workspaces on them. */
function hostsWithWorkspaces(workspaces: Workspace[]): string[] {
  const hostIds = workspaces.flatMap((workspace) =>
    workspace.status === 'active' && isSshWorkspace(workspace) ? [workspace.backend.hostId] : []
  );
  return [...new Set(hostIds)].sort();
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/** Resolves once the window shows, or as soon as `signal` aborts. */
function whenVisible(signal: AbortSignal): Promise<void> {
  if (!document.hidden) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (document.hidden && !signal.aborted) return;
      document.removeEventListener('visibilitychange', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    document.addEventListener('visibilitychange', done);
    signal.addEventListener('abort', done);
  });
}

/**
 * One machine's usage, read again a little after each answer while the window shows; null until
 * the first.
 */
function useMachineResourceUsage(
  hostId: string | null,
  reads: MachineReads = POPOVER_READS,
  enabled = true
): MachineResourceUsage | null {
  // Kept with its machine, so switching to another doesn't show the last one's.
  const [reading, setReading] = useState<{
    hostId: string | null;
    usage: MachineResourceUsage;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    const { refreshMs, failedRefreshMs = refreshMs, prompt, maxAgeMs } = reads;
    const readUntilClosed = async () => {
      while (!signal.aborted) {
        await whenVisible(signal);
        if (signal.aborted) return;
        const failed = await window.api.getResourceUsage(hostId, { prompt, maxAgeMs }).then(
          (usage) => {
            if (!signal.aborted) setReading({ hostId, usage });
            return Boolean(usage.error);
          },
          // Keeps the last reading.
          () => true
        );
        await wait(failed ? failedRefreshMs : refreshMs, signal);
      }
    };
    void readUntilClosed();
    return () => {
      controller.abort();
      // Switched back on later, it starts again from nothing rather than from an old reading.
      setReading(null);
    };
  }, [hostId, reads, enabled]);
  return enabled && reading?.hostId === hostId ? reading.usage : null;
}

// Expander or dot, name, CPU and memory.
const COLUMNS = 'grid grid-cols-[1rem_minmax(0,1fr)_3rem_4.5rem] gap-x-1.5';

type Share = 'workspaces' | 'komla' | 'other';

// Who uses a machine, in the order its meters stack them. Blue and aqua stay apart for
// colour-blind readers; the rest is grey.
const SHARES: Record<Share, { label: string; color: string }> = {
  workspaces: { label: 'Workspaces', color: 'bg-[#2a78d6] dark:bg-[#3987e5]' },
  komla: { label: 'Komla', color: 'bg-[#1baf7a] dark:bg-[#199e70]' },
  other: { label: 'Other', color: 'bg-foreground/45' },
};

const KOMLA_PROCESSES: Record<KomlaProcessKind, { label: string; title?: string }> = {
  main: { label: 'Main process' },
  windows: { label: 'Windows and browser tabs' },
  helpers: { label: 'GPU and other helpers' },
  background: {
    label: 'Background processes',
    title: 'ssh, git and other commands Komla runs outside your terminals',
  },
  'tmux-server': {
    label: 'tmux server',
    title: "Keeps the host's terminal sessions and their scrollback",
  },
  connections: {
    label: 'Terminal connections',
    title: 'A tmux client for each terminal a device has open',
  },
  companion: {
    label: 'Companion',
    title: 'Watches workspaces for changes and passes agent hooks on to Komla',
  },
};

function komlaProcessLabel({ kind, processCount }: KomlaProcessUsage): string {
  const { label } = KOMLA_PROCESSES[kind];
  return kind === 'connections' ? `${label} (${processCount})` : label;
}

function ShareDot({ share }: { share: Share }) {
  return (
    <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', SHARES[share].color)} />
  );
}

function UsageCells({ usage, strong }: { usage: ResourceUsage; strong?: boolean }) {
  return (
    <>
      <span className={cn('text-right', strong ? 'font-medium' : 'text-muted-foreground')}>
        {formatCpu(usage.cpuPercent)}
      </span>
      <span className={cn('text-right', strong ? 'font-medium' : 'text-muted-foreground')}>
        {formatBytes(usage.memoryBytes)}
      </span>
    </>
  );
}

function Row({
  label,
  title,
  usage,
  level = 0,
  expanded,
  onToggle,
  onOpen,
  muted,
}: {
  label: string;
  title?: string;
  usage: ResourceUsage;
  level?: 0 | 1;
  expanded?: boolean;
  onToggle?: () => void;
  onOpen?: () => void;
  muted?: boolean;
}) {
  return (
    <li
      className={cn(
        COLUMNS,
        'items-center rounded-md px-1 py-[3px] tabular-nums',
        onOpen && 'hover:bg-foreground/6'
      )}
    >
      {onToggle ? (
        <button
          type="button"
          aria-label={`${expanded ? 'Hide' : 'Show'} what ${label} runs`}
          aria-expanded={expanded}
          className="flex size-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          onClick={onToggle}
        >
          <CaretRight
            aria-hidden="true"
            className={cn('size-3 transition-transform', expanded && 'rotate-90')}
          />
        </button>
      ) : (
        <span />
      )}
      {onOpen ? (
        <button
          type="button"
          className={cn('min-w-0 truncate text-left', level === 1 && 'pl-3')}
          onClick={onOpen}
        >
          {label}
        </button>
      ) : (
        <span
          className={cn(
            'min-w-0 truncate',
            level === 1 && 'pl-3',
            muted && 'text-muted-foreground'
          )}
          title={title}
        >
          {label}
        </span>
      )}
      <UsageCells usage={usage} />
    </li>
  );
}

/** A group of rows under its name and total; one with `onToggle` hides its rows until expanded. */
function Group({
  share,
  title,
  usage,
  expanded,
  onToggle,
  children,
}: {
  share: Share;
  title: string;
  usage: ResourceUsage;
  expanded?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  return (
    <section aria-label={title} className="not-first:mt-2.5">
      <div className={cn(COLUMNS, 'items-center px-1 py-[3px] tabular-nums')}>
        <span className="flex justify-center">
          <ShareDot share={share} />
        </span>
        <h4 className="flex min-w-0 font-medium">
          {onToggle ? (
            <button
              type="button"
              aria-label={`${expanded ? 'Hide' : 'Show'} what ${title} runs`}
              aria-expanded={expanded}
              className="flex min-w-0 items-center gap-1 text-left"
              onClick={onToggle}
            >
              <span className="truncate">{title}</span>
              <CaretRight
                aria-hidden="true"
                className={cn(
                  'size-3 shrink-0 text-muted-foreground transition-transform',
                  expanded && 'rotate-90'
                )}
              />
            </button>
          ) : (
            <span className="truncate">{title}</span>
          )}
        </h4>
        <UsageCells usage={usage} strong />
      </div>
      {children && (!onToggle || expanded) && <ul>{children}</ul>}
    </section>
  );
}

// The machine's own count of what it keeps busy, as a percent of one core; where it keeps none,
// as on a macOS host, what the groups below add up to.
function busyPercent(usage: MachineResourceUsage): number | null {
  if (usage.machine.cpuPercent !== null) return usage.machine.cpuPercent;
  // The first read has no CPU for processes yet.
  if (usage.otherProcesses.cpuPercent === null) return null;
  return sumUsage([...usage.komla, ...workspaceParts(usage), usage.otherProcesses]).cpuPercent;
}

/** Workspaces, with the sessions of other devices' workspaces counted among them. */
function workspaceParts(usage: MachineResourceUsage): ResourceUsage[] {
  return [...usage.workspaces, ...(usage.otherSessions ? [usage.otherSessions] : [])];
}

interface MeterPart {
  share: Share;
  /** Of the machine's capacity, 0 to 1. */
  fraction: number;
  amount: number;
}

/**
 * Splits what a machine uses between workspaces, Komla and everything else. Processes share
 * memory, so their sums can pass what the machine says it uses; the rest is then Other's.
 */
function meterParts(
  capacity: number,
  used: number,
  workspaces: number,
  komla: number
): MeterPart[] {
  const fill = Math.min(used, capacity);
  const ours = Math.min(workspaces, fill);
  const komlas = Math.min(komla, fill - ours);
  return (
    [
      ['workspaces', ours],
      ['komla', komlas],
      ['other', fill - ours - komlas],
    ] as const
  ).map(([share, amount]) => ({ share, amount, fraction: amount / capacity }));
}

/** One figure of a machine above a bar of what it holds, coloured by who uses it. */
function Meter({
  label,
  value,
  detail,
  parts = [],
  format,
}: {
  label: string;
  value?: string;
  detail: string;
  parts?: MeterPart[];
  format?: (amount: number) => string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-ui text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex min-w-0 items-baseline gap-1 text-ui whitespace-nowrap text-muted-foreground">
        {value && (
          <span className="text-[15px] leading-5 font-semibold text-foreground">{value}</span>
        )}{' '}
        <span className="truncate">{detail}</span>
      </div>
      <div className="mt-1.5 flex h-2 gap-0.5 overflow-hidden rounded-full">
        {parts
          .filter(({ fraction }) => fraction >= 0.005)
          .map(({ share, fraction, amount }) => (
            <span
              key={share}
              className={cn('h-full shrink-0', SHARES[share].color)}
              style={{ width: `${fraction * 100}%` }}
              title={format && `${SHARES[share].label}: ${format(amount)}`}
            />
          ))}
        <span className="h-full min-w-0 flex-1 bg-foreground/10" />
      </div>
    </div>
  );
}

function CpuMeter({ usage }: { usage: MachineResourceUsage }) {
  const { cores } = usage.machine;
  const busy = busyPercent(usage);
  const coreCount = cores === null ? 'cores' : `${cores} ${cores === 1 ? 'core' : 'cores'}`;
  if (busy === null) return <Meter label="CPU" detail={cores === null ? '–' : coreCount} />;
  return (
    <Meter
      label="CPU"
      value={(busy / 100).toFixed(1)}
      detail={`${cores === null ? '' : 'of '}${coreCount} busy`}
      parts={
        cores === null
          ? undefined
          : meterParts(
              cores * 100,
              busy,
              sumUsage(workspaceParts(usage)).cpuPercent ?? 0,
              sumUsage(usage.komla).cpuPercent ?? 0
            )
      }
      format={formatCpu}
    />
  );
}

function MemoryMeter({ usage }: { usage: MachineResourceUsage }) {
  const { memoryTotalBytes: total, memoryAvailableBytes: available } = usage.machine;
  if (total === null) return <Meter label="Memory" detail="–" />;
  const workspaces = sumUsage(workspaceParts(usage)).memoryBytes;
  const komla = sumUsage(usage.komla).memoryBytes;
  // Without the machine's own count, the bar shows only what the processes hold.
  const used =
    available === null ? workspaces + komla + usage.otherProcesses.memoryBytes : total - available;
  return (
    <Meter
      label="Memory"
      value={available === null ? undefined : formatBytes(used)}
      detail={available === null ? `${formatBytes(total)} in all` : `of ${formatBytes(total)} used`}
      parts={meterParts(total, used, workspaces, komla)}
      format={formatBytes}
    />
  );
}

/** This computer, or an SSH host, which shows as soon as it answers. */
function MachineSection({
  hostId,
  name,
  workspacesById,
  onOpenWorkspace,
}: {
  hostId: string | null;
  name: string;
  workspacesById: Map<string, Workspace>;
  onOpenWorkspace: (workspace: Workspace) => void;
}) {
  const usage = useMachineResourceUsage(hostId);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const MachineIcon = hostId === null ? Desktop : Cloud;
  const heading = (
    <div className="flex items-center gap-1.5">
      <MachineIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <h3 className="truncate text-[13px] font-medium">{name}</h3>
    </div>
  );
  if (!usage) {
    return (
      <section aria-label={name} className="px-3 py-3">
        {heading}
        <div className="mt-1 text-ui text-muted-foreground">Reading…</div>
      </section>
    );
  }
  if (usage.error) {
    return (
      <section aria-label={name} className="px-3 py-3">
        {heading}
        <div className="mt-1 line-clamp-2 text-ui break-words text-error" title={usage.error}>
          {usage.error}
        </div>
      </section>
    );
  }
  const workspaces = usage.workspaces.filter(({ workspaceId }) => workspacesById.has(workspaceId));
  const otherSessions = usage.otherSessions?.count ? usage.otherSessions : undefined;
  // What the list below shows, so the meters add up to it.
  const shown = { ...usage, workspaces, otherSessions };
  const terminalName = (workspace: Workspace, terminalId: string) =>
    workspace.terminals.find((terminal) => terminal.id === terminalId)?.name ?? 'Terminal';

  const workspaceRows = (workspaceUsage: WorkspaceResourceUsage) => {
    const workspace = workspacesById.get(workspaceUsage.workspaceId)!;
    const multiple = workspaceUsage.terminals.length > 1;
    const open = expanded.has(workspace.id);
    return (
      <Fragment key={workspace.id}>
        <Row
          label={workspaceLabel(workspace)}
          usage={workspaceUsage}
          expanded={open}
          onToggle={multiple ? () => toggle(workspace.id) : undefined}
          onOpen={() => onOpenWorkspace(workspace)}
        />
        {multiple &&
          open &&
          workspaceUsage.terminals.map((terminal) => (
            <Row
              key={terminal.terminalId}
              level={1}
              label={terminalName(workspace, terminal.terminalId)}
              usage={terminal}
              muted
            />
          ))}
      </Fragment>
    );
  };

  return (
    <section aria-label={name} className="px-3 pt-3 pb-2">
      {heading}
      <div className="mt-2.5 grid grid-cols-2 gap-x-5">
        <CpuMeter usage={shown} />
        <MemoryMeter usage={shown} />
      </div>
      <div
        className={cn(
          COLUMNS,
          'mt-3.5 border-b border-foreground/10 px-1 pb-1 text-2xs tracking-wide text-muted-foreground uppercase'
        )}
      >
        <span className="col-span-2" />
        <span className="text-right" title="A percent of one core, so 150% keeps 1.5 cores busy">
          CPU
        </span>
        <span className="text-right">Memory</span>
      </div>
      <div className="-mx-1 mt-1.5">
        <Group share="workspaces" title="Workspaces" usage={sumUsage(workspaceParts(shown))}>
          {workspaces.map(workspaceRows)}
          {otherSessions && (
            <Row
              label={`Other sessions (${otherSessions.count})`}
              title="Komla's tmux sessions on the host that no workspace here has, such as another device's"
              usage={otherSessions}
              muted
            />
          )}
          {workspaces.length === 0 && !otherSessions && (
            <li className="px-1 py-[3px] pl-6 text-muted-foreground">No terminals running</li>
          )}
        </Group>
        {usage.komla.length > 0 && (
          <Group
            share="komla"
            title="Komla"
            usage={sumUsage(usage.komla)}
            expanded={expanded.has('komla')}
            onToggle={() => toggle('komla')}
          >
            {usage.komla.map((part) => (
              <Row
                key={part.kind}
                label={komlaProcessLabel(part)}
                title={KOMLA_PROCESSES[part.kind].title}
                usage={part}
                muted
              />
            ))}
          </Group>
        )}
        <Group share="other" title="Other processes" usage={usage.otherProcesses} />
      </div>
    </section>
  );
}

type BarShows = NonNullable<AppConfig['statusBarResourceUsage']>;
type HostShows = Extract<BarShows, 'ssh-host' | 'ssh-host-workspaces'>;

const DEFAULT_BAR_SHOWS = 'komla-and-workspaces' satisfies BarShows;

/** What the bar can show of this computer. */
export const RESOURCE_USAGE_BAR_CHOICES: {
  value: Exclude<BarShows, HostShows>;
  label: string;
  description: string;
}[] = [
  { value: 'komla', label: 'Komla', description: "Komla's own processes" },
  {
    value: 'komla-and-workspaces',
    label: 'Komla and workspaces',
    description: 'Plus what terminals run on this computer',
  },
  { value: 'computer', label: 'This computer', description: 'Everything running on it' },
];

/** What the bar can show of each SSH host. */
export const RESOURCE_USAGE_HOST_CHOICES: { value: HostShows; label: string }[] = [
  { value: 'ssh-host', label: 'Everything' },
  { value: 'ssh-host-workspaces', label: 'Komla and workspaces' },
];

function isHostShows(value: string): value is HostShows {
  return RESOURCE_USAGE_HOST_CHOICES.some((choice) => choice.value === value);
}

/** One of an SSH host's choices, as a picker's value: `<choice>:<host id>`. */
export function hostChoice(shows: HostShows, host: SshHost): string {
  return `${shows}:${host.id}`;
}

type BarSource =
  | { kind: Exclude<BarShows, HostShows> }
  | { kind: HostShows; hostId: string; name: string };

/** What the bar shows; the default where the SSH host it named is gone. */
export function useResourceUsageBarSource(): BarSource {
  const config = useConfigStore((s) => s.config);
  const hosts = useSshHostsStore((s) => s.hosts);
  // Until they load, or fail to, it waits for the host it names.
  const hostsLoading = useSshHostsStore((s) => !s.hasLoaded && s.error === null);
  const shows = config?.statusBarResourceUsage ?? DEFAULT_BAR_SHOWS;
  if (!isHostShows(shows)) return { kind: shows };
  const hostId = config?.statusBarResourceUsageHostId;
  const host = hosts.find(({ id }) => id === hostId);
  if (host) return { kind: shows, hostId: host.id, name: host.name };
  return hostId && hostsLoading ? { kind: shows, hostId, name: '' } : { kind: DEFAULT_BAR_SHOWS };
}

/** What the bar shows, as one value for a picker. */
export function resourceUsageBarChoice(source: BarSource): string {
  return 'hostId' in source ? `${source.kind}:${source.hostId}` : source.kind;
}

/** The config change that picks a choice. */
export function resourceUsageBarChoiceUpdate(choice: string): Partial<AppConfig> {
  const separator = choice.indexOf(':');
  const shows = separator === -1 ? choice : choice.slice(0, separator);
  if (isHostShows(shows)) {
    return {
      statusBarResourceUsage: shows,
      statusBarResourceUsageHostId: choice.slice(separator + 1),
    };
  }
  return { statusBarResourceUsage: shows as Exclude<BarShows, HostShows> };
}

/** A choice's name where the host it counts has to be said, as on a closed picker. */
export function resourceUsageBarChoiceLabel(choice: string, hosts: SshHost[]): string {
  for (const host of hosts) {
    const option = RESOURCE_USAGE_HOST_CHOICES.find(
      ({ value }) => hostChoice(value, host) === choice
    );
    if (option) return `${host.name}: ${option.label}`;
  }
  return RESOURCE_USAGE_BAR_CHOICES.find(({ value }) => value === choice)?.label ?? '';
}

function BarChoicePicker() {
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const hosts = useSshHostsStore((s) => s.hosts);
  const choice = resourceUsageBarChoice(useResourceUsageBarSource());
  const label = resourceUsageBarChoiceLabel(choice, hosts);
  const item = (value: string, itemLabel: string, description?: string, name = itemLabel) => (
    <DropdownMenuRadioItem
      key={value}
      value={value}
      aria-label={name}
      aria-describedby={description ? `resource-usage-bar-${value}` : undefined}
      className="items-start py-1.5"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{itemLabel}</span>
        {description && (
          <span id={`resource-usage-bar-${value}`} className="text-ui text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </DropdownMenuRadioItem>
  );

  return (
    <div className="flex items-center justify-between gap-2 border-t border-foreground/10 px-3 py-1.5">
      <span className="text-ui text-muted-foreground">Status bar shows</span>
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
            value={choice}
            onValueChange={(value) => void updateConfig(resourceUsageBarChoiceUpdate(value))}
          >
            {RESOURCE_USAGE_BAR_CHOICES.map((option) =>
              item(option.value, option.label, option.description)
            )}
            {hosts.map((host) => (
              <Fragment key={host.id}>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="flex min-w-0 items-center gap-1.5">
                  <Cloud aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="truncate">{host.name}</span>
                </DropdownMenuLabel>
                {RESOURCE_USAGE_HOST_CHOICES.map((option) =>
                  item(
                    hostChoice(option.value, host),
                    option.label,
                    undefined,
                    `${host.name}: ${option.label}`
                  )
                )}
              </Fragment>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ResourceUsagePanel({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const hosts = useSshHostsStore((s) => s.hosts);
  const currentWindowId = useWindowStore((s) => s.windowId);
  const barSource = useResourceUsageBarSource();
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const hostName = (hostId: string) => hosts.find((host) => host.id === hostId)?.name ?? hostId;
  // The bar's host too, where it can ask for the password the bar can't.
  const hostIds = hostsWithWorkspaces(workspaces);
  if ('hostId' in barSource && !hostIds.includes(barSource.hostId)) hostIds.push(barSource.hostId);

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-foreground/10 px-3 py-2">
        <h2
          className="text-[13px] font-semibold"
          title="Read every few seconds while this is open, here and on SSH hosts with workspaces or on the status bar"
        >
          Resource usage
        </h2>
        <ul aria-label="Legend" className="flex items-center gap-3 text-2xs text-muted-foreground">
          {(Object.keys(SHARES) as Share[]).map((share) => (
            <li key={share} className="flex items-center gap-1">
              <ShareDot share={share} />
              {SHARES[share].label}
            </li>
          ))}
        </ul>
      </div>
      <div className="max-h-[70vh] divide-y divide-foreground/10 overflow-y-auto">
        {[null, ...hostIds].map((hostId) => (
          <MachineSection
            key={hostId ?? 'local'}
            hostId={hostId}
            name={hostId === null ? 'This computer' : hostName(hostId)}
            workspacesById={workspacesById}
            onOpenWorkspace={(workspace) => {
              void openWorkspace(workspace, currentWindowId);
              onOpenWorkspace();
            }}
          />
        ))}
      </div>
      <BarChoicePicker />
    </>
  );
}

interface BarReading {
  cpu: string;
  memory: string;
  /** What the numbers count, or why there are none. */
  about: string;
}

const NO_READING = { cpu: '–', memory: '–' };

/** Why a machine couldn't be read, in short: ssh's errors start with the whole command. */
function unreadableReason(name: string, error: string): string {
  return `${name} couldn't be read: ${error.trim().split('\n').pop()}`;
}

function cpuText(percent: number | null): string {
  return percent === null ? '–' : `${percent.toFixed(1)}%`;
}

/**
 * Komla and its workspaces on a machine, as a percent of one core, the way Komla's own CPU shows;
 * on an SSH host, other devices' sessions too.
 */
function komlaAndWorkspacesReading(
  name: string,
  about: string,
  usage: MachineResourceUsage | null
): BarReading {
  if (!usage) return { ...NO_READING, about };
  if (usage.error) {
    const reason = unreadableReason(name, usage.error);
    // This computer's still has Komla's own processes, which Electron counts.
    if (usage.komla.length === 0) return { ...NO_READING, about: reason };
    const komla = sumUsage(usage.komla);
    return {
      cpu: cpuText(komla.cpuPercent),
      memory: formatBytes(komla.memoryBytes),
      about: `Komla's own CPU and memory. ${reason}`,
    };
  }
  const { cpuPercent, memoryBytes } = sumUsage([...usage.komla, ...workspaceParts(usage)]);
  return { cpu: cpuText(cpuPercent), memory: formatBytes(memoryBytes), about };
}

/** A whole machine: the share of its cores in use, and memory used of all it has. */
function machineReading(name: string, usage: MachineResourceUsage | null): BarReading {
  const about = `${name}: CPU in use across all its cores, and memory used`;
  if (usage?.error) return { ...NO_READING, about: unreadableReason(name, usage.error) };
  if (!usage) return { ...NO_READING, about };
  const { cores, memoryTotalBytes: total, memoryAvailableBytes: available } = usage.machine;
  const busy = busyPercent(usage);
  return {
    cpu: busy === null || cores === null ? '–' : `${Math.round(busy / cores)}%`,
    memory:
      total === null || available === null
        ? '–'
        : `${((total - available) / GB).toFixed(1)}/${Math.round(total / GB)} GB`,
    about,
  };
}

function useBarReading(source: BarSource): BarReading {
  const metrics = useKomlaMetrics(source.kind === 'komla');
  const usage = useMachineResourceUsage(
    'hostId' in source ? source.hostId : null,
    window.api.platform === 'win32' ? WINDOWS_BAR_READS : BAR_READS,
    source.kind !== 'komla'
  );
  switch (source.kind) {
    case 'komla':
      return {
        ...(metrics
          ? { cpu: cpuText(metrics.cpuPercent), memory: `${metrics.memoryMB} MB` }
          : NO_READING),
        about: "Komla's own CPU and memory",
      };
    case 'komla-and-workspaces':
      return komlaAndWorkspacesReading(
        'This computer',
        "Komla and what this computer's terminals run",
        usage
      );
    case 'computer':
      return machineReading('This computer', usage);
    case 'ssh-host':
      return machineReading(source.name || 'SSH host', usage);
    case 'ssh-host-workspaces':
      return komlaAndWorkspacesReading(
        source.name || 'SSH host',
        `Komla and what its terminals run on ${source.name || 'the SSH host'}`,
        usage
      );
  }
}

/**
 * CPU and memory on the bar, of Komla, Komla and its workspaces, this computer or an SSH host as
 * the user picks; its popover breaks down what runs where, by workspace, on this computer and on
 * SSH hosts.
 */
export function ResourceUsageSegment() {
  const [open, setOpen] = useState(false);
  const source = useResourceUsageBarSource();
  const reading = useBarReading(source);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <StatusBarButton
          aria-label={`Resource usage: ${reading.about}: ${reading.cpu} CPU, ${reading.memory}`}
          tooltip={`${reading.about}. Click for workspaces and SSH hosts.`}
          className="tabular-nums"
        >
          <Cpu aria-hidden="true" className="size-3.5" />
          <span>{reading.cpu}</span>
          <span aria-hidden="true" className="text-muted-foreground/60">
            ·
          </span>
          <span>{reading.memory}</span>
        </StatusBarButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[26rem] p-0 text-xs">
        {open && <ResourceUsagePanel onOpenWorkspace={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}
